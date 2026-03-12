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
 *      doc.outstanding_amount > 0 and doc.due_date < frappe.utils.today()
 *  - Lease / contract-cancelled (on_update):
 *      doc.status in ("Cancelled", "Expired")
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

// ─── Signature validation middleware ────────────────────────────────────────

function validateSignature(req, res, next) {
  const rawBody = req.rawBody;

  if (!config.webhook.secret) {
    logger.warn('Webhook secret not set; skipping signature verification (dev mode)');
    return next();
  }

  // Frappe attaches the hex HMAC-SHA256 digest in this header
  const signature = req.headers['x-frappe-webhook-signature'] || '';

  if (!signature) {
    logger.warn('ERPNext webhook received without X-Frappe-Webhook-Signature header');
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
    logger.warn('ERPNext webhook signature mismatch – request rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

// ─── ERPNext payload normalizers ─────────────────────────────────────────────

/**
 * Attempt to resolve a tenant's mobile_no from ERPNext.
 * Returns null (never throws) so a failed lookup never blocks the webhook.
 */
async function fetchTenantPhone(customerId) {
  if (!customerId) return null;
  try {
    const tenant = await getPMS().getTenant(customerId);
    return tenant?.mobile_no || null;
  } catch {
    logger.warn('Could not fetch tenant phone for SMS', { customerId });
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
  const body = req.body;
  logger.info('ERPNext webhook: invoice-overdue', { invoice: body?.name, customer: body?.customer });

  try {
    const tenantPhone = await fetchTenantPhone(body.customer);

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

    await webhookHandlers.handle(event);
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Error processing invoice-overdue webhook', { error: err.message });
    res.status(500).json({ error: 'Internal processing error' });
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
  const body = req.body;
  logger.info('ERPNext webhook: payment-received', { entry: body?.name, party: body?.party });

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

    await webhookHandlers.handle(event);
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Error processing payment-received webhook', { error: err.message });
    res.status(500).json({ error: 'Internal processing error' });
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
  const body = req.body;
  logger.info('ERPNext webhook: ticket-created', { ticket: body?.name });

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

    await webhookHandlers.handle(event);
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Error processing ticket-created webhook', { error: err.message });
    res.status(500).json({ error: 'Internal processing error' });
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
  const body = req.body;
  logger.info('ERPNext webhook: ticket-updated', { ticket: body?.name, status: body?.status });

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

    await webhookHandlers.handle(event);
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Error processing ticket-updated webhook', { error: err.message });
    res.status(500).json({ error: 'Internal processing error' });
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
  const body = req.body;
  logger.info('ERPNext webhook: contract-submitted', { contract: body?.name });

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

    await webhookHandlers.handle(event);
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Error processing contract-submitted webhook', { error: err.message });
    res.status(500).json({ error: 'Internal processing error' });
  }
});

/**
 * POST /webhooks/erpnext/contract-cancelled
 *
 * Triggered when a Lease status changes to Cancelled or Expired (on_update).
 * Set Condition in ERPNext: doc.status in ("Cancelled", "Expired")
 *
 * Payload key fields: name, tenant_name, property_unit, status
 */
router.post('/erpnext/contract-cancelled', validateSignature, async (req, res) => {
  const body = req.body;
  logger.info('ERPNext webhook: contract-cancelled', { contract: body?.name });

  try {
    const event = {
      type: 'lease.expired',
      data: {
        tenantName: body.tenant_name,
        unit: body.property_unit,
      },
    };

    await webhookHandlers.handle(event);
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Error processing contract-cancelled webhook', { error: err.message });
    res.status(500).json({ error: 'Internal processing error' });
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
  const body = req.body;
  logger.info('ERPNext webhook: visit-scheduled', { visit: body?.name, customer: body?.customer });

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

    await webhookHandlers.handle(event);
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Error processing visit-scheduled webhook', { error: err.message });
    res.status(500).json({ error: 'Internal processing error' });
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
