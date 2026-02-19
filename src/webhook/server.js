'use strict';

/**
 * Webhook receiver (Express HTTP server).
 *
 * DoorLoop POSTs events to this server the instant state changes occur in the
 * PMS (e.g. rent goes overdue, a work order is created).
 *
 * Security: every incoming request is validated against the shared HMAC-SHA256
 * signature that DoorLoop attaches as the "X-DoorLoop-Signature" header.
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../logger');
const { config } = require('../config');
const webhookHandlers = require('./handlers');

const router = express.Router();

// ─── Signature validation middleware ────────────────────────────────────────

function validateSignature(req, res, next) {
  const rawBody = req.rawBody;
  const signature = req.headers['x-doorloop-signature'] || req.headers['x-pms-signature'] || '';

  if (!config.webhook.secret) {
    logger.warn('Webhook secret not set; skipping signature verification (dev mode)');
    return next();
  }

  if (!signature) {
    logger.warn('Webhook received without signature header');
    return res.status(401).json({ error: 'Missing signature' });
  }

  const expected = crypto
    .createHmac('sha256', config.webhook.secret)
    .update(rawBody || '')
    .digest('hex');

  // timingSafeEqual requires equal-length buffers; a length mismatch is itself a rejection.
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
    logger.warn('Webhook signature mismatch – request rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /webhooks/doorloop
 *
 * DoorLoop event types (non-exhaustive):
 *   rent.overdue           – grace period has expired
 *   payment.received       – a payment was posted
 *   workorder.created      – new maintenance request
 *   workorder.updated      – status/notes changed
 *   lease.created
 *   lease.expired
 */
router.post('/doorloop', validateSignature, async (req, res) => {
  const event = req.body;
  logger.info('DoorLoop webhook received', { eventType: event?.type, id: event?.id });

  try {
    await webhookHandlers.handle(event);
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Error processing DoorLoop webhook', { error: err.message });
    res.status(500).json({ error: 'Internal processing error' });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── Express app factory ─────────────────────────────────────────────────────

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
