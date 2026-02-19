'use strict';

/**
 * Webhook receiver (Express HTTP server).
 *
 * Routes handled:
 *   POST /webhooks/doorloop      – real-time PMS events (HMAC-verified)
 *   POST /webhooks/telegram      – inbound Telegram messages (webhook mode)
 *   GET  /cron/rent-check        – triggered daily by Vercel Cron at 08:00
 *   GET  /cron/maintenance-check – triggered daily at 09:00
 *   GET  /cron/weekly-report     – triggered every Friday at 17:00
 *   GET  /health                 – liveness probe
 */

const crypto = require('crypto');
const express = require('express');
const logger = require('../logger');
const { config } = require('../config');
const webhookHandlers = require('./handlers');

const router = express.Router();

// ─── DoorLoop signature validation ──────────────────────────────────────────

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

// ─── Vercel Cron authentication ───────────────────────────────────────────────

/**
 * Vercel automatically sets CRON_SECRET and forwards it as
 * "Authorization: Bearer <secret>" on every cron-triggered request.
 * We reject any call that doesn't carry it so cron endpoints cannot
 * be triggered by arbitrary HTTP clients in production.
 */
function validateCronRequest(req, res, next) {
  const cronSecret = config.cron.secret;

  // Skip auth when no secret is configured (local dev / testing).
  if (!cronSecret) return next();

  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${cronSecret}`) {
    logger.warn('Cron request rejected – missing or invalid CRON_SECRET');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// DoorLoop PMS events
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

/**
 * POST /webhooks/telegram
 *
 * Telegram delivers every bot update here when the bot is in webhook mode.
 * The update is passed directly to the bot's internal event pipeline via
 * processUpdate(), which triggers the same handlers as in polling mode.
 *
 * Telegram signs the request with a secret token we set during webhook
 * registration (scripts/setup-telegram-webhook.js).  We verify it here.
 */
router.post('/telegram', (req, res) => {
  const secretToken = req.headers['x-telegram-bot-api-secret-token'] || '';

  if (config.telegram.webhookSecret && secretToken !== config.telegram.webhookSecret) {
    logger.warn('Telegram webhook secret mismatch – request rejected');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { processUpdate } = require('../telegram/bot');
    processUpdate(req.body);
  } catch (err) {
    logger.error('Error processing Telegram update', { error: err.message });
  }

  // Always respond 200 so Telegram does not retry the delivery.
  res.sendStatus(200);
});

// Health check
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── Cron endpoints (called by Vercel Cron) ──────────────────────────────────

const cronRouter = express.Router();

cronRouter.get('/rent-check', validateCronRequest, async (_req, res) => {
  logger.info('Cron: /rent-check triggered');
  try {
    const { runOverdueRentCheck } = require('../automation/scheduler');
    await runOverdueRentCheck();
    res.json({ ok: true });
  } catch (err) {
    logger.error('Cron rent-check failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

cronRouter.get('/maintenance-check', validateCronRequest, async (_req, res) => {
  logger.info('Cron: /maintenance-check triggered');
  try {
    const { runStaleWorkOrderCheck } = require('../automation/scheduler');
    await runStaleWorkOrderCheck();
    res.json({ ok: true });
  } catch (err) {
    logger.error('Cron maintenance-check failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

cronRouter.get('/weekly-report', validateCronRequest, async (_req, res) => {
  logger.info('Cron: /weekly-report triggered');
  try {
    const { runWeeklyReport } = require('../automation/scheduler');
    await runWeeklyReport();
    res.json({ ok: true });
  } catch (err) {
    logger.error('Cron weekly-report failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
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
  app.use('/cron', cronRouter);

  return app;
}

module.exports = { createWebhookApp, router };
