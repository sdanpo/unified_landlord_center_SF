'use strict';

/**
 * Webhook receiver (Express HTTP server).
 *
 * DoorLoop / Buildium POST events to this server the instant state changes
 * occur in the PMS (e.g. rent goes overdue, a work order is created).
 *
 * Security: every incoming request is validated against the shared HMAC-SHA256
 * signature that the PMS attaches as the "X-PMS-Signature" header.
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../logger');
const { config } = require('../config');
const webhookHandlers = require('./handlers');

const router = express.Router();

// ─── Signature validation middleware ────────────────────────────────────────

/**
 * Verifies the HMAC-SHA256 webhook signature sent by the PMS.
 * Both DoorLoop and Buildium support configuring a secret that is used to
 * sign the raw request body before delivery.
 */
function validateSignature(req, res, next) {
  // Raw body is required for HMAC verification; populated by express.raw() in app setup.
  const rawBody = req.rawBody;
  const signature = req.headers['x-pms-signature'] || req.headers['x-doorloop-signature'] || '';

  if (!config.webhook.secret) {
    // Secret not configured – skip validation (development only).
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
 * Handles all event types emitted by DoorLoop Premium.
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
    await webhookHandlers.handle(event, 'doorloop');
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Error processing DoorLoop webhook', { error: err.message });
    res.status(500).json({ error: 'Internal processing error' });
  }
});

/**
 * POST /webhooks/buildium
 * Handles all event types emitted by Buildium Premium.
 *
 * Buildium event types include:
 *   MaintenanceRequest.Created
 *   MaintenanceRequest.Updated
 *   Lease.ChargeCreated   (rent charge posted)
 *   Payment.Applied
 */
router.post('/buildium', validateSignature, async (req, res) => {
  const event = req.body;
  logger.info('Buildium webhook received', { eventType: event?.EventType, id: event?.Id });

  try {
    // Normalize Buildium event shape to the canonical internal format
    const normalized = normalizeBuildiumEvent(event);
    await webhookHandlers.handle(normalized, 'buildium');
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Error processing Buildium webhook', { error: err.message });
    res.status(500).json({ error: 'Internal processing error' });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── Normalization helpers ───────────────────────────────────────────────────

/**
 * Converts Buildium's PascalCase event envelope to the canonical snake_case
 * format used throughout this application.
 */
function normalizeBuildiumEvent(raw) {
  const typeMap = {
    'MaintenanceRequest.Created': 'workorder.created',
    'MaintenanceRequest.Updated': 'workorder.updated',
    'Lease.ChargeCreated': 'rent.charged',
    'Payment.Applied': 'payment.received',
    'Lease.Created': 'lease.created',
    'Lease.Expired': 'lease.expired',
  };

  return {
    type: typeMap[raw.EventType] || raw.EventType?.toLowerCase() || 'unknown',
    id: raw.Id,
    createdAt: raw.CreatedDateTime,
    data: raw.Data || {},
    _raw: raw,
  };
}

// ─── Express app factory ─────────────────────────────────────────────────────

function createWebhookApp() {
  const app = express();

  // Capture raw body for HMAC verification BEFORE JSON parsing
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
