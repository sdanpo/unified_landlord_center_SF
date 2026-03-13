'use strict';

/**
 * Webhook receiver (Express HTTP server).
 *
 * ERPNext POSTs events to this server when document state changes.
 * One webhook URL is registered per event type in ERPNext →
 * Integrations → Webhooks, pointing to the corresponding route below.
 *
 * Security: every request is validated against an HMAC-SHA256 signature
 * that Frappe/ERPNext attaches as the "X-Frappe-Webhook-Signature" header
 * (hex-encoded, computed over the raw request body with the shared secret).
 *
 * ERPNext webhook configuration (7 webhooks to create):
 *
 *  DocType              Trigger          URL
 *  ───────────────────  ───────────────  ──────────────────────────────────────────────
 *  Sales Invoice        on_submit        {BASE_URL}/webhooks/erpnext/invoice-overdue
 *  Payment Entry        on_submit        {BASE_URL}/webhooks/erpnext/payment-received
 *  Issue                after_insert     {BASE_URL}/webhooks/erpnext/ticket-created
 *  Issue                on_update        {BASE_URL}/webhooks/erpnext/ticket-updated
 *  Maintenance Visit    after_insert     {BASE_URL}/webhooks/erpnext/visit-scheduled
 *  Lease                after_insert     {BASE_URL}/webhooks/erpnext/contract-submitted
 *  Lease                on_update        {BASE_URL}/webhooks/erpnext/contract-cancelled
 *
 * Conditions to set in ERPNext:
 *  - Sales Invoice / invoice-overdue:
 *      (doc.outstanding_amount or 0) > 0 and doc.due_date < frappe.utils.today()
 *  - Lease / contract-cancelled (on_update):
 *      doc.lease_status in ("Closed", "Not Materialized", "Vacating")
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../logger');
const { config } = require('../config');
const webhookHandlers = require('./handlers');

const router = express.Router();

// Lazy require to avoid circular deps at startup
let pmsClient;
function getPMS() {
  if (!pmsClient) pmsClient = require('../api/index');
  return pmsClient;
}

// ─── Request ID helper ────────────────────────────────────────────────────────

/** Generate a short, unique ID for correlating log lines within one request. */
function makeReqId() {
  return `wh-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Truncate a string for safe log output (avoids flooding logs with huge bodies). */
function truncate(str, max = 1500) {
  if (typeof str !== 'string') str = JSON.stringify(str);
  return str.length > max ? `${str.slice(0, max)}…[truncated ${str.length - max} chars]` : str;
}

/** Mask a phone number, keeping the country code prefix and last 2 digits visible. */
function maskPhone(phone) {
  if (!phone || phone.length < 5) return '***';
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 5)}${phone.slice(-2)}`;
}

// ─── Signature validation middleware ────────────────────────────────────────

function validateSignature(req, res, next) {
  const rawBody = req.rawBody;
  const reqId = req.reqId;

  if (!config.webhook.secret) {
    logger.warn('Webhook secret not set; skipping signature verification (dev mode)', { reqId });
    return next();
  }

  const signature = req.headers['x-frappe-webhook-signature'] || '';

  if (!signature) {
    logger.warn('ERPNext webhook received without X-Frappe-Webhook-Signature header', {
      reqId,
      path: req.path,
      ip: req.ip,
    });
    return res.status(401).json({ error: 'Missing signature' });
  }

  const expected = crypto
    .createHmac('sha256', config.webhook.secret)
    .update(rawBody || '')
    .digest('hex');

  let trusted = false;
  try {
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length === expBuf.length) {
      trusted = crypto.timingSafeEqual(sigBuf, expBuf);
    }
  } catch (_) {
    trusted = false;
  }

  if (!trusted) {
    logger.warn('ERPNext webhook signature mismatch – request rejected', {
      reqId,
      path: req.path,
      ip: req.ip,
      receivedSignaturePrefix: signature.slice(0, 8) + '…',
    });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  logger.debug('Webhook signature verified OK', { reqId });
  next();
}

// ─── Request logging middleware ───────────────────────────────────────────────

/**
 * Attaches a unique reqId to every incoming request and logs the full
 * payload at DEBUG level so you can replay exactly what ERPNext sent.
 */
router.use((req, _res, next) => {
  req.reqId = makeReqId();
  req.startedAt = Date.now();

  logger.debug('Incoming webhook request', {
    reqId: req.reqId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length'],
    // Full raw body at debug level – invaluable for replaying failures
    rawBody: truncate(req.rawBody?.toString() || ''),
  });

  next();
});

// ─── ERPNext payload normalizers ─────────────────────────────────────────────

/**
 * Attempt to resolve a tenant's mobile_no from ERPNext.
 * Returns null (never throws) so a failed lookup never blocks the webhook.
 */
async function fetchTenantPhone(customerId, reqId) {
  if (!customerId) {
    logger.debug('fetchTenantPhone: no customerId provided, skipping lookup', { reqId });
    return null;
  }
  logger.debug('fetchTenantPhone: looking up mobile_no', { reqId, customerId });
  try {
    const tenant = await getPMS().getTenant(customerId);
    const phone = tenant?.mobile_no || null;
    if (phone) {
      logger.debug('fetchTenantPhone: found phone', { reqId, customerId, maskedPhone: maskPhone(phone) });
    } else {
      logger.warn('fetchTenantPhone: tenant exists but mobile_no is empty', { reqId, customerId });
    }
    return phone;
  } catch (err) {
    logger.warn('fetchTenantPhone: ERPNext lookup failed – SMS will be skipped', {
      reqId,
      customerId,
      error: err.message,
    });
    return null;
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /webhooks/erpnext/invoice-overdue
 *
 * Triggered by a submitted Sales Invoice where outstanding_amount > 0
 * and due_date has passed (set the Condition in ERPNext).
 *
 * Payload key fields: name, customer, customer_name, outstanding_amount,
 *   due_date, custom_unit, custom_property, custom_lease
 */
router.post('/erpnext/invoice-overdue', validateSignature, async (req, res) => {
  const { reqId, startedAt } = req;
  const body = req.body;

  logger.info('Webhook received: invoice-overdue', {
    reqId,
    invoiceName: body?.name,
    customer: body?.customer,
    customerName: body?.customer_name,
    outstandingAmount: body?.outstanding_amount,
    dueDate: body?.due_date,
    unit: body?.custom_unit,
    property: body?.custom_property,
    lease: body?.custom_lease,
  });

  try {
    const tenantPhone = await fetchTenantPhone(body.customer, reqId);

    const event = {
      type: 'rent.overdue',
      data: {
        leaseId: body.custom_lease || body.name,
        tenantName: body.customer_name,
        tenantId: body.customer,
        tenantPhone,
        unit: body.custom_unit,
        propertyAddress: body.custom_property,
        amountDue: body.outstanding_amount,
      },
    };

    logger.debug('Dispatching event', { reqId, eventType: event.type, eventData: event.data });

    await webhookHandlers.handle(event, { reqId });

    const elapsed = Date.now() - startedAt;
    logger.info('Webhook processed successfully', { reqId, route: 'invoice-overdue', elapsedMs: elapsed });
    res.status(200).json({ received: true, reqId });
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    logger.error('Error processing invoice-overdue webhook', {
      reqId,
      elapsedMs: elapsed,
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: 'Internal processing error', reqId });
  }
});

/**
 * POST /webhooks/erpnext/payment-received
 *
 * Triggered when a Payment Entry is submitted.
 *
 * Payload key fields: name, party, party_name, paid_amount,
 *   mode_of_payment, custom_unit, custom_lease
 */
router.post('/erpnext/payment-received', validateSignature, async (req, res) => {
  const { reqId, startedAt } = req;
  const body = req.body;

  logger.info('Webhook received: payment-received', {
    reqId,
    entryName: body?.name,
    party: body?.party,
    partyName: body?.party_name,
    paidAmount: body?.paid_amount,
    modeOfPayment: body?.mode_of_payment,
    unit: body?.custom_unit,
    lease: body?.custom_lease,
  });

  try {
    const event = {
      type: 'payment.received',
      data: {
        leaseId: body.custom_lease || '',
        tenantName: body.party_name,
        unit: body.custom_unit,
        amountPaid: body.paid_amount,
        paymentMethod: body.mode_of_payment || 'Portal',
      },
    };

    logger.debug('Dispatching event', { reqId, eventType: event.type, eventData: event.data });

    await webhookHandlers.handle(event, { reqId });

    const elapsed = Date.now() - startedAt;
    logger.info('Webhook processed successfully', { reqId, route: 'payment-received', elapsedMs: elapsed });
    res.status(200).json({ received: true, reqId });
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    logger.error('Error processing payment-received webhook', {
      reqId,
      elapsedMs: elapsed,
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: 'Internal processing error', reqId });
  }
});

/**
 * POST /webhooks/erpnext/ticket-created
 *
 * Triggered when a new Issue (Support module) is inserted by a tenant.
 *
 * Payload key fields: name, subject, priority,
 *   customer, customer_name, raised_by, raised_by_full_name,
 *   custom_unit, custom_property
 */
router.post('/erpnext/ticket-created', validateSignature, async (req, res) => {
  const { reqId, startedAt } = req;
  const body = req.body;

  logger.info('Webhook received: ticket-created', {
    reqId,
    ticketName: body?.name,
    subject: body?.subject,
    priority: body?.priority,
    customer: body?.customer,
    customerName: body?.customer_name,
    unit: body?.custom_unit,
    property: body?.custom_property,
  });

  try {
    const event = {
      type: 'workorder.created',
      data: {
        id: body.name,
        tenantName: body.customer_name || body.raised_by_full_name,
        unit: body.custom_unit,
        propertyAddress: body.custom_property,
        description: body.subject,
        priority: body.priority,
      },
    };

    logger.debug('Dispatching event', { reqId, eventType: event.type, eventData: event.data });

    await webhookHandlers.handle(event, { reqId });

    const elapsed = Date.now() - startedAt;
    logger.info('Webhook processed successfully', { reqId, route: 'ticket-created', elapsedMs: elapsed });
    res.status(200).json({ received: true, reqId });
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    logger.error('Error processing ticket-created webhook', {
      reqId,
      elapsedMs: elapsed,
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: 'Internal processing error', reqId });
  }
});

/**
 * POST /webhooks/erpnext/ticket-updated
 *
 * Triggered when an Issue (Support module) is updated (status change, resolution notes).
 *
 * Payload key fields: name, status, custom_unit, resolution / resolution_details
 */
router.post('/erpnext/ticket-updated', validateSignature, async (req, res) => {
  const { reqId, startedAt } = req;
  const body = req.body;

  logger.info('Webhook received: ticket-updated', {
    reqId,
    ticketName: body?.name,
    status: body?.status,
    unit: body?.custom_unit,
    hasResolution: !!(body?.resolution || body?.resolution_details),
  });

  try {
    const event = {
      type: 'workorder.updated',
      data: {
        id: body.name,
        unit: body.custom_unit,
        status: body.status,
        vendorNotes: body.resolution || body.resolution_details || '',
      },
    };

    logger.debug('Dispatching event', { reqId, eventType: event.type, eventData: event.data });

    await webhookHandlers.handle(event, { reqId });

    const elapsed = Date.now() - startedAt;
    logger.info('Webhook processed successfully', { reqId, route: 'ticket-updated', elapsedMs: elapsed });
    res.status(200).json({ received: true, reqId });
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    logger.error('Error processing ticket-updated webhook', {
      reqId,
      elapsedMs: elapsed,
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: 'Internal processing error', reqId });
  }
});

/**
 * POST /webhooks/erpnext/contract-submitted
 *
 * Triggered when a new Lease is inserted (after_insert).
 *
 * Payload key fields: name, tenant_name, property_unit, start_date,
 *   end_date, monthly_rent
 */
router.post('/erpnext/contract-submitted', validateSignature, async (req, res) => {
  const { reqId, startedAt } = req;
  const body = req.body;

  logger.info('Webhook received: contract-submitted', {
    reqId,
    leaseName: body?.name,
    tenantName: body?.tenant_name,
    unit: body?.property_unit,
    startDate: body?.start_date,
    endDate: body?.end_date,
    monthlyRent: body?.monthly_rent,
  });

  try {
    const event = {
      type: 'lease.created',
      data: {
        tenantName: body.tenant_name,
        unit: body.property_unit,
        startDate: body.start_date,
        endDate: body.end_date,
        monthlyRent: body.monthly_rent,
      },
    };

    logger.debug('Dispatching event', { reqId, eventType: event.type, eventData: event.data });

    await webhookHandlers.handle(event, { reqId });

    const elapsed = Date.now() - startedAt;
    logger.info('Webhook processed successfully', { reqId, route: 'contract-submitted', elapsedMs: elapsed });
    res.status(200).json({ received: true, reqId });
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    logger.error('Error processing contract-submitted webhook', {
      reqId,
      elapsedMs: elapsed,
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: 'Internal processing error', reqId });
  }
});

/**
 * POST /webhooks/erpnext/contract-cancelled
 *
 * Triggered when a Lease lease_status changes to a terminal value (on_update).
 * Set Condition in ERPNext: doc.lease_status in ("Closed", "Not Materialized", "Vacating")
 *
 * Payload key fields: name, tenant_name, property_unit, status
 */
router.post('/erpnext/contract-cancelled', validateSignature, async (req, res) => {
  const { reqId, startedAt } = req;
  const body = req.body;

  logger.info('Webhook received: contract-cancelled', {
    reqId,
    leaseName: body?.name,
    tenantName: body?.tenant_name,
    unit: body?.property_unit,
    leaseStatus: body?.lease_status || body?.status,
  });

  try {
    const event = {
      type: 'lease.expired',
      data: {
        tenantName: body.tenant_name,
        unit: body.property_unit,
      },
    };

    logger.debug('Dispatching event', { reqId, eventType: event.type, eventData: event.data });

    await webhookHandlers.handle(event, { reqId });

    const elapsed = Date.now() - startedAt;
    logger.info('Webhook processed successfully', { reqId, route: 'contract-cancelled', elapsedMs: elapsed });
    res.status(200).json({ received: true, reqId });
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    logger.error('Error processing contract-cancelled webhook', {
      reqId,
      elapsedMs: elapsed,
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: 'Internal processing error', reqId });
  }
});

/**
 * POST /webhooks/erpnext/visit-scheduled
 *
 * Triggered when a Maintenance Visit (Maintenance module) is created,
 * indicating a technician visit has been scheduled for a tenant's issue.
 *
 * Payload key fields: name, customer, customer_name, status,
 *   purpose, maintenance_date, completion_status,
 *   custom_unit, custom_property
 */
router.post('/erpnext/visit-scheduled', validateSignature, async (req, res) => {
  const { reqId, startedAt } = req;
  const body = req.body;

  logger.info('Webhook received: visit-scheduled', {
    reqId,
    visitName: body?.name,
    customer: body?.customer,
    customerName: body?.customer_name,
    unit: body?.custom_unit,
    property: body?.custom_property,
    purpose: body?.purpose,
    maintenanceDate: body?.maintenance_date,
    completionStatus: body?.completion_status,
  });

  try {
    const event = {
      type: 'visit.scheduled',
      data: {
        id: body.name,
        tenantName: body.customer_name,
        unit: body.custom_unit,
        propertyAddress: body.custom_property,
        purpose: body.purpose,
        maintenanceDate: body.maintenance_date,
        completionStatus: body.completion_status,
      },
    };

    logger.debug('Dispatching event', { reqId, eventType: event.type, eventData: event.data });

    await webhookHandlers.handle(event, { reqId });

    const elapsed = Date.now() - startedAt;
    logger.info('Webhook processed successfully', { reqId, route: 'visit-scheduled', elapsedMs: elapsed });
    res.status(200).json({ received: true, reqId });
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    logger.error('Error processing visit-scheduled webhook', {
      reqId,
      elapsedMs: elapsed,
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: 'Internal processing error', reqId });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── Express app factory ──────────────────────────────────────────────────────

function createWebhookApp() {
  const app = express();

  app.use(
    express.json({
      verify(req, _res, buf) {
        req.rawBody = buf;
      },
    })
  );

  app.use('/webhooks', router);

  return app;
}

module.exports = { createWebhookApp, router };
