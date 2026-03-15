'use strict';

/**
 * Webhook / HTTP server
 *
 * Routes:
 *   GET  /webhooks/health                          – liveness probe
 *   GET  /checkout?invoice_name=...                – Stripe Checkout Session (card + ACH)
 *   POST /webhooks/erpnext/invoice-overdue         – ERPNext webhook → rent.overdue
 *   POST /webhooks/erpnext/payment-received        – ERPNext webhook → payment.received
 *   POST /webhooks/erpnext/ticket-created          – ERPNext webhook → workorder.created
 *   POST /webhooks/erpnext/contract-submitted      – ERPNext webhook → lease.created
 *   POST /webhooks/erpnext/contract-cancelled      – ERPNext webhook → lease.expired
 */

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const logger  = require('../logger');
const { config } = require('../config');

// ── HMAC-SHA256 signature validation for ERPNext webhooks ─────────────────────

function validateSignature(req, res, next) {
  const secret = config.webhook?.secret || process.env.WEBHOOK_SECRET || '';
  if (!secret) return next(); // skip when no secret is configured (dev mode)

  const sig  = req.headers['x-frappe-webhook-signature'] || '';
  const body = req.rawBody || JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');

  // timingSafeEqual requires same-length buffers; use fixed-length hex form
  const sigBuf = Buffer.from(sig.padEnd(64, '0').slice(0, 64), 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  next();
}

// Middleware to capture raw request body for signature validation
function captureRawBody(req, _res, buf) {
  req.rawBody = buf.toString();
}

// ── Health check ──────────────────────────────────────────────────────────────

function makeWebhookRouter() {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // ── ERPNext webhook endpoints ───────────────────────────────────────────────

  const { handle } = require('./handlers');

  router.post('/erpnext/invoice-overdue', validateSignature, async (req, res) => {
    const d = req.body;
    handle({
      type: 'rent.overdue',
      data: {
        invoiceId:   d.name,
        tenantId:    d.customer,
        tenantName:  d.customer_name,
        unitName:    d.custom_unit    || d.custom_property || '',
        amountDue:   d.outstanding_amount,
        dueDate:     d.due_date,
        leaseId:     d.custom_lease,
      },
    }).catch(err => logger.error('rent.overdue handler error', { error: err.message }));
    res.json({ received: true });
  });

  router.post('/erpnext/payment-received', validateSignature, async (req, res) => {
    const d = req.body;
    handle({
      type: 'payment.received',
      data: {
        paymentId:     d.name,
        tenantId:      d.party,
        tenantName:    d.party_name,
        amountPaid:    d.paid_amount,
        paymentMethod: d.mode_of_payment,
        leaseId:       d.custom_lease,
      },
    }).catch(err => logger.error('payment.received handler error', { error: err.message }));
    res.json({ received: true });
  });

  router.post('/erpnext/ticket-created', validateSignature, async (req, res) => {
    const d = req.body;
    handle({
      type: 'workorder.created',
      data: {
        ticketId:   d.name,
        subject:    d.subject,
        priority:   d.priority,
        tenantName: d.customer_name || d.raised_by_name || '',
        description: d.description,
      },
    }).catch(err => logger.error('workorder.created handler error', { error: err.message }));
    res.json({ received: true });
  });

  router.post('/erpnext/contract-submitted', validateSignature, async (req, res) => {
    const d = req.body;
    handle({
      type: 'lease.created',
      data: {
        leaseId:     d.name,
        tenantName:  d.tenant_name,
        unitName:    d.property_unit,
        startDate:   d.start_date,
        endDate:     d.end_date,
        monthlyRent: d.monthly_rent,
      },
    }).catch(err => logger.error('lease.created handler error', { error: err.message }));
    res.json({ received: true });
  });

  router.post('/erpnext/contract-cancelled', validateSignature, async (req, res) => {
    const d = req.body;
    handle({
      type: 'lease.expired',
      data: {
        leaseId:    d.name,
        tenantName: d.tenant_name,
        unitName:   d.property_unit,
      },
    }).catch(err => logger.error('lease.expired handler error', { error: err.message }));
    res.json({ received: true });
  });

  return router;
}

// ── Stripe Checkout with card + ACH ───────────────────────────────────────────

function makeCheckoutRouter() {
  const router = express.Router();

  /**
   * GET /checkout?invoice_name=ACC-SINV-2026-00009
   * Creates a Stripe-hosted Checkout Session (card + ACH) and redirects.
   */
  router.get('/checkout', async (req, res) => {
    const invoiceName = (req.query.invoice_name || '').trim();
    if (!invoiceName) return res.status(400).send('invoice_name is required');

    const stripeSecretKey = config.stripe?.secretKey || process.env.STRIPE_SECRET_KEY;
    const erpnextBase     = (process.env.ERPNEXT_BASE_URL || '').replace(/\/$/, '');
    const erpnextKey      = process.env.ERPNEXT_API_KEY;
    const erpnextSec      = process.env.ERPNEXT_API_SECRET;

    if (!stripeSecretKey) {
      logger.error('STRIPE_SECRET_KEY not configured');
      return res.status(500).send('Payment gateway not configured');
    }

    try {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const proxyUrl   = process.env.https_proxy || process.env.HTTPS_PROXY || '';
      const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

      const erpHttp = axios.create({
        baseURL: erpnextBase,
        headers: {
          Authorization: `token ${erpnextKey}:${erpnextSec}`,
          Accept: 'application/json',
        },
        timeout: 15_000,
        ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
      });

      const { data: invData } = await erpHttp.get(
        `/api/resource/Sales%20Invoice/${encodeURIComponent(invoiceName)}`
      );
      const inv = invData.data;

      if (inv.docstatus !== 1 || !(inv.outstanding_amount > 0)) {
        return res.status(400).send('Invoice is not payable');
      }

      const { data: custData } = await erpHttp.get(
        `/api/resource/Customer/${encodeURIComponent(inv.customer)}`
      );
      const customerEmail = custData.data.email_id || '';

      const stripeHttp = axios.create({
        baseURL: 'https://api.stripe.com',
        auth: { username: stripeSecretKey, password: '' },
        timeout: 15_000,
        ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
      });

      const params = new URLSearchParams({
        mode: 'payment',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': `Rent – ${invoiceName}`,
        'line_items[0][price_data][unit_amount]': String(Math.round(inv.outstanding_amount * 100)),
        'line_items[0][quantity]': '1',
        'success_url': `${erpnextBase}/invoices?payment=success`,
        'cancel_url':  `${erpnextBase}/invoices`,
        'metadata[invoice]': invoiceName,
        'metadata[tenant]':  inv.customer_name || '',
        'payment_method_options[us_bank_account][financial_connections][permissions][]': 'payment_method',
      });
      params.append('payment_method_types[]', 'card');
      params.append('payment_method_types[]', 'us_bank_account');
      if (customerEmail) params.set('customer_email', customerEmail);

      const { data: session } = await stripeHttp.post(
        '/v1/checkout/sessions',
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      if (session.error) {
        logger.error('Stripe session creation failed', { error: session.error });
        return res.status(502).send('Could not create payment session: ' + session.error.message);
      }

      logger.info('Stripe checkout session created', {
        invoice: invoiceName,
        session: session.id,
        amount: inv.outstanding_amount,
      });

      return res.redirect(302, session.url);

    } catch (err) {
      logger.error('Checkout endpoint error', {
        invoice: invoiceName,
        error: err.response?.data || err.message,
      });
      return res.status(500).send('Payment session error – please try again');
    }
  });

  return router;
}

// ── App factories ─────────────────────────────────────────────────────────────

/**
 * createWebhookApp() — used by tests and directly by src/index.js.
 * Mounts:
 *   /webhooks/…   ERPNext webhook endpoints + health
 *   /checkout     Stripe Checkout Session endpoint
 */
function createWebhookApp() {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, verify: captureRawBody }));
  app.use('/webhooks', makeWebhookRouter());
  app.use('/', makeCheckoutRouter());
  return app;
}

/** Alias kept for backward compatibility with src/index.js */
const createServer = createWebhookApp;

module.exports = { createWebhookApp, createServer };
