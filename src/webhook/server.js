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
   * GET /checkout?invoice_name=ACC-SINV-2026-00009[&method=ach|card]
   *
   * method=ach  (default) → us_bank_account only, original amount
   * method=card           → card only, amount + CARD_SURCHARGE_PCT (default 3%)
   *
   * Creates a Stripe-hosted Checkout Session and redirects the tenant.
   */
  router.get('/checkout', async (req, res) => {
    const invoiceName = (req.query.invoice_name || '').trim();
    if (!invoiceName) return res.status(400).send('invoice_name is required');

    const method = (req.query.method || 'ach').toLowerCase();
    if (method !== 'ach' && method !== 'card') {
      return res.status(400).send('method must be "ach" or "card"');
    }

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

      // Apply credit-card surcharge when method=card
      const CARD_SURCHARGE_PCT = parseFloat(process.env.CARD_SURCHARGE_PCT || '3') / 100;
      const baseAmount  = inv.outstanding_amount;
      const isCard      = method === 'card';
      const finalAmount = isCard
        ? Math.round(baseAmount * (1 + CARD_SURCHARGE_PCT) * 100) // cents, rounded
        : Math.round(baseAmount * 100);

      const stripeHttp = axios.create({
        baseURL: 'https://api.stripe.com',
        auth: { username: stripeSecretKey, password: '' },
        timeout: 15_000,
        ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
      });

      const surchargeLabel = isCard
        ? ` (includes ${Math.round(CARD_SURCHARGE_PCT * 100)}% card processing fee)`
        : '';

      const params = new URLSearchParams({
        mode: 'payment',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': `Rent – ${invoiceName}${surchargeLabel}`,
        'line_items[0][price_data][unit_amount]': String(finalAmount),
        'line_items[0][quantity]': '1',
        'success_url': `${erpnextBase}/invoices?payment=success`,
        'cancel_url':  `${erpnextBase}/invoices`,
        'metadata[invoice]': invoiceName,
        'metadata[tenant]':  inv.customer_name || '',
        'metadata[method]':  method,
      });

      if (isCard) {
        params.append('payment_method_types[]', 'card');
      } else {
        params.append('payment_method_types[]', 'us_bank_account');
        params.set('payment_method_options[us_bank_account][financial_connections][permissions][]', 'payment_method');
      }

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

// ── Stripe webhook: ACH async payment confirmation ───────────────────────────
//
// ACH (us_bank_account) payments take 1-5 business days to settle.
// Stripe fires these events:
//   checkout.session.completed            – always fires; payment_status='unpaid' for ACH
//   checkout.session.async_payment_succeeded – ACH cleared   ← record payment here
//   checkout.session.async_payment_failed   – ACH bounced    ← alert landlord
//   (for card payments checkout.session.completed fires with payment_status='paid')
//
// On success we create a Payment Entry (draft or submitted) in ERPNext so the
// invoice outstanding_amount is zeroed out.  A Telegram alert is also sent.

/**
 * Validate a Stripe webhook signature.
 * Stripe header format: "t=TIMESTAMP,v1=SIG[,v1=SIG2]"
 * Signed payload:        "{timestamp}.{rawBody}"
 */
function validateStripeSignature(rawBody, header, secret) {
  if (!header || !secret) return false;

  const parts = {};
  for (const chunk of header.split(',')) {
    const eq = chunk.indexOf('=');
    if (eq === -1) continue;
    const k = chunk.slice(0, eq);
    const v = chunk.slice(eq + 1);
    if (!parts[k]) parts[k] = [];
    parts[k].push(v);
  }

  const timestamp  = parts.t?.[0];
  const signatures = parts.v1 || [];
  if (!timestamp || signatures.length === 0) return false;

  // Reject events older than 5 minutes to prevent replay attacks
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const payload  = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expBuf   = Buffer.from(expected, 'hex');

  return signatures.some(sig => {
    if (sig.length !== expected.length) return false;
    const sigBuf = Buffer.from(sig, 'hex');
    return crypto.timingSafeEqual(sigBuf, expBuf);
  });
}

/**
 * Create a Payment Entry in ERPNext to mark the invoice as paid.
 * docstatus=1 (submitted) when STRIPE_BANK_ACCOUNT is configured,
 * docstatus=0 (draft)     otherwise — accountant reviews before posting.
 */
async function recordStripePaymentInERPNext(erpHttp, { invoiceName, amountCents, paymentMethod, stripeSessionId }) {
  const amount      = amountCents / 100;
  const arAccount   = config.stripe?.paymentAccount || 'Debtors - LD';
  const bankAccount = config.stripe?.bankAccount    || '';
  const modeOfPayment = paymentMethod === 'us_bank_account' ? 'Wire Transfer' : 'Credit Card';

  // Fetch invoice to get customer / company context
  const { data: invData } = await erpHttp.get(
    `/api/resource/Sales%20Invoice/${encodeURIComponent(invoiceName)}`
  );
  const inv = invData.data;

  const pePayload = {
    payment_type:      'Receive',
    mode_of_payment:   modeOfPayment,
    party_type:        'Customer',
    party:             inv.customer,
    party_name:        inv.customer_name,
    paid_amount:       amount,
    received_amount:   amount,
    paid_from:         arAccount,
    references: [{
      reference_doctype: 'Sales Invoice',
      reference_name:    invoiceName,
      allocated_amount:  amount,
    }],
    remarks: `Stripe ${paymentMethod === 'us_bank_account' ? 'ACH' : 'card'} payment — session ${stripeSessionId}`,
    docstatus: bankAccount ? 1 : 0,
    ...(bankAccount ? { paid_to: bankAccount } : {}),
  };

  const { data: result } = await erpHttp.post('/api/resource/Payment%20Entry', pePayload);
  return { name: result.data.name, submitted: !!bankAccount };
}

function makeStripeWebhookRouter() {
  const router = express.Router();

  router.post('/stripe', async (req, res) => {
    const webhookSecret = config.stripe?.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET || '';
    const sigHeader     = req.headers['stripe-signature'] || '';
    const rawBody       = req.rawBody || JSON.stringify(req.body);

    if (webhookSecret) {
      if (!validateStripeSignature(rawBody, sigHeader, webhookSecret)) {
        logger.warn('Stripe webhook: invalid signature');
        return res.status(400).json({ error: 'Invalid signature' });
      }
    } else {
      logger.warn('STRIPE_WEBHOOK_SECRET not set — skipping signature validation');
    }

    let event;
    try {
      event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    // Acknowledge immediately — Stripe retries on non-2xx
    res.json({ received: true });

    // Process asynchronously so a slow ERPNext call doesn't delay the 200
    setImmediate(() => handleStripeEvent(event).catch(err =>
      logger.error('Stripe webhook handler error', { type: event?.type, error: err.message })
    ));
  });

  return router;
}

async function handleStripeEvent(event) {
  const { handle: handleErpEvent } = require('./handlers');
  const type    = event.type;
  const session = event.data?.object;

  logger.info('Stripe webhook event', { type, session: session?.id });

  // ── Card payment: confirmed synchronously at checkout ──────────────────────
  if (type === 'checkout.session.completed' && session?.payment_status === 'paid') {
    await onPaymentConfirmed(session, 'card', handleErpEvent);
    return;
  }

  // ── ACH: payment cleared (1-5 business days after checkout) ───────────────
  if (type === 'checkout.session.async_payment_succeeded') {
    await onPaymentConfirmed(session, 'us_bank_account', handleErpEvent);
    return;
  }

  // ── ACH: payment bounced ───────────────────────────────────────────────────
  if (type === 'checkout.session.async_payment_failed') {
    const invoiceName = session?.metadata?.invoice || 'unknown';
    const tenantName  = session?.metadata?.tenant  || 'unknown';
    const amount      = session?.amount_total ? `$${(session.amount_total / 100).toFixed(2)}` : '';
    logger.warn('ACH payment failed', { invoice: invoiceName, tenant: tenantName });
    await handleErpEvent({
      type: 'payment.failed',
      data: { invoiceName, tenantName, amount },
    }).catch(() => {});
    return;
  }

  // ── ACH: session completed but payment still pending (normal ACH flow) ─────
  if (type === 'checkout.session.completed' && session?.payment_status === 'unpaid') {
    const invoiceName = session?.metadata?.invoice || 'unknown';
    const tenantName  = session?.metadata?.tenant  || 'unknown';
    const amount      = session?.amount_total ? `$${(session.amount_total / 100).toFixed(2)}` : '';
    logger.info('ACH payment initiated — awaiting bank confirmation', { invoice: invoiceName });
    await handleErpEvent({
      type: 'payment.pending',
      data: { invoiceName, tenantName, amount },
    }).catch(() => {});
    return;
  }
}

async function onPaymentConfirmed(session, paymentMethod, handleErpEvent) {
  const invoiceName = session?.metadata?.invoice;
  const tenantName  = session?.metadata?.tenant || 'unknown';
  const amountCents = session?.amount_total || 0;
  const amount      = `$${(amountCents / 100).toFixed(2)}`;

  if (!invoiceName) {
    logger.error('Stripe webhook: no invoice in session metadata', { session: session?.id });
    return;
  }

  const erpnextBase = (process.env.ERPNEXT_BASE_URL || '').replace(/\/$/, '');
  const erpnextKey  = process.env.ERPNEXT_API_KEY;
  const erpnextSec  = process.env.ERPNEXT_API_SECRET;

  let peResult = null;
  if (erpnextBase && erpnextKey && erpnextSec) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const proxyUrl   = process.env.https_proxy || process.env.HTTPS_PROXY || '';
    const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    const erpHttp = axios.create({
      baseURL: erpnextBase,
      headers: { Authorization: `token ${erpnextKey}:${erpnextSec}`, Accept: 'application/json' },
      timeout: 20_000,
      ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
    });

    try {
      peResult = await recordStripePaymentInERPNext(erpHttp, {
        invoiceName,
        amountCents,
        paymentMethod,
        stripeSessionId: session.id,
      });
      logger.info('Payment Entry created', { name: peResult.name, submitted: peResult.submitted, invoice: invoiceName });
    } catch (err) {
      logger.error('Failed to create Payment Entry', {
        invoice: invoiceName,
        error: err.response?.data?.exception || err.message,
      });
    }
  }

  const methodLabel = paymentMethod === 'us_bank_account' ? 'ACH bank transfer' : 'card';
  const peNote = peResult
    ? peResult.submitted
      ? ` — Payment Entry ${peResult.name} posted in ERPNext`
      : ` — Draft Payment Entry ${peResult.name} created in ERPNext (needs review)`
    : ' — ⚠️ ERPNext payment entry creation failed, record manually';

  await handleErpEvent({
    type: 'payment.received',
    data: {
      invoiceId:     invoiceName,
      tenantName,
      amountPaid:    amountCents / 100,
      paymentMethod: methodLabel,
    },
  }).catch(() => {});

  logger.info('Stripe payment confirmed', { invoice: invoiceName, amount, method: methodLabel, peNote });
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
  app.use('/webhooks', makeStripeWebhookRouter());
  app.use('/', makeCheckoutRouter());
  return app;
}

/** Alias kept for backward compatibility with src/index.js */
const createServer = createWebhookApp;

module.exports = { createWebhookApp, createServer };
