'use strict';

/**
 * Webhook / HTTP server
 *
 * Exposes:
 *   GET  /health                         – liveness probe
 *   GET  /checkout?invoice_name=...      – Stripe Checkout Session with card + ACH,
 *                                          redirects browser to Stripe-hosted payment page
 *
 * Future routes (inbound tenant SMS plan):
 *   POST /twilio/inbound                 – Twilio webhook for inbound tenant SMS
 */

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const logger  = require('../logger');
const { config } = require('../config');

const router = express.Router();

// ── Health check ──────────────────────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── Stripe Checkout with card + ACH ───────────────────────────────────────────

/**
 * GET /checkout?invoice_name=ACC-SINV-2026-00009
 *
 * Creates a Stripe-hosted Checkout Session that offers both:
 *   • Credit / debit card
 *   • US bank transfer (ACH Direct Debit)
 *
 * After payment Stripe redirects to /invoices?payment=success.
 * On cancel the tenant lands back at /invoices.
 *
 * Security: only whitelisted invoice names (submitted + outstanding) are
 * accepted — unauthenticated callers cannot create arbitrary sessions.
 */
router.get('/checkout', async (req, res) => {
  const invoiceName = (req.query.invoice_name || '').trim();

  if (!invoiceName) {
    return res.status(400).send('invoice_name is required');
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
    // Fetch invoice from ERPNext to verify it exists and is outstanding
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

    // Fetch customer email
    const { data: custData } = await erpHttp.get(
      `/api/resource/Customer/${encodeURIComponent(inv.customer)}`
    );
    const customerEmail = custData.data.email_id || '';

    // Create Stripe Checkout Session with card + ACH (us_bank_account)
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
    // append array values for payment_method_types
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

// ── Create and export the Express app ────────────────────────────────────────

function createServer() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/', router);
  return app;
}

module.exports = { createServer };
