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
 * ERPNext webhook configuration (6 webhooks to create):
 *
 *  DocType            Trigger          URL
 *  ─────────────────  ───────────────  ──────────────────────────────────────────
 *  Sales Invoice      on_submit        {BASE_URL}/webhooks/erpnext/invoice-overdue
 *  Payment Entry      on_submit        {BASE_URL}/webhooks/erpnext/payment-received
 *  Maintenance Req.   after_insert     {BASE_URL}/webhooks/erpnext/ticket-created
 *  Maintenance Req.   on_update        {BASE_URL}/webhooks/erpnext/ticket-updated
 *  Rental Contract    on_submit        {BASE_URL}/webhooks/erpnext/contract-submitted
 *  Rental Contract    on_cancel        {BASE_URL}/webhooks/erpnext/contract-cancelled
 *
 * For "Sales Invoice / invoice-overdue", set a Condition in ERPNext so it
 * only fires when outstanding_amount > 0 and due_date < today:
 *   doc.outstanding_amount > 0 and doc.due_date < frappe.utils.today()
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
 * Triggered when a new Maintenance Request (PropMS) is inserted.
 *
 * Payload key fields: name, subject, status, priority,
 *   customer / raised_by, customer_name / raised_by_full_name,
 *   custom_unit, custom_property, description
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
 * Triggered when a Maintenance Request is updated (status change, vendor notes).
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
 * Triggered when a Rental Contract is submitted (status → Active).
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
 * Triggered when a Rental Contract is cancelled (expired or early termination).
 *
 * Payload key fields: name, tenant_name, property_unit
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
