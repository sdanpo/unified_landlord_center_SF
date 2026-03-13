'use strict';

/**
 * Vercel serverless entry point.
 *
 * Vercel routes every incoming request here via the rewrite rule in vercel.json.
 * The module exports the Express app so Vercel can wrap it as a serverless function.
 *
 * Routes handled:
 *   /webhooks/erpnext/*  – ERPNext event webhooks (defined in src/webhook/server.js)
 *   /telegram            – Telegram bot updates (replaces long-polling on Vercel)
 *   /telegram/setup      – One-time webhook registration helper
 *   /cron/overdue-rent   – Called by Vercel Cron daily at 08:00 PST
 *   /cron/stale-workorders – Called by Vercel Cron daily at 09:00 PST
 *   /cron/weekly-report  – Called by Vercel Cron every Friday at 17:00 PST
 *   /webhooks/health     – Health check
 */

const { createWebhookApp } = require('../src/webhook/server');
const { processUpdate }     = require('../src/telegram/bot');
const logger                = require('../src/logger');

const {
  runOverdueRentCheck,
  runStaleWorkOrderCheck,
  runWeeklyReport,
} = require('../src/automation/scheduler');

const app = createWebhookApp();

// ─── Telegram webhook ─────────────────────────────────────────────────────────
// Telegram POSTs every update here instead of us polling.
// Must always return HTTP 200 immediately; Telegram retries on failure.

app.post('/telegram', async (req, res) => {
  res.sendStatus(200); // ACK to Telegram before any async work
  try {
    await processUpdate(req.body);
  } catch (err) {
    logger.error('Telegram webhook processing error', { error: err.message, stack: err.stack });
  }
});

// ─── Telegram webhook setup ──────────────────────────────────────────────────
// Call GET /telegram/setup ONCE after each deployment to tell Telegram the URL.
// e.g. curl https://your-app.vercel.app/telegram/setup

app.get('/telegram/setup', async (_req, res) => {
  const TelegramBot = require('node-telegram-bot-api');
  const { config }  = require('../src/config');
  const webhookUrl  = `${config.webhook.baseUrl}/telegram`;

  try {
    const bot = new TelegramBot(config.telegram.botToken, { polling: false });
    const result = await bot.setWebHook(webhookUrl);
    logger.info('Telegram webhook registered', { webhookUrl, result });
    res.json({ ok: true, webhookUrl });
  } catch (err) {
    logger.error('Telegram webhook setup failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Cron helpers ─────────────────────────────────────────────────────────────

/**
 * Vercel Cron Jobs don't authenticate requests automatically.
 * Set CRON_SECRET in Vercel env vars and pass it in the Authorization header
 * if you want to prevent anyone from triggering cron endpoints manually.
 * If CRON_SECRET is not set the endpoint runs without auth (fine for testing).
 */
function verifyCron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    logger.warn('Cron endpoint called with invalid secret', { path: req.path });
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ─── Cron: daily overdue rent sweep (08:00 PST / 16:00 UTC) ──────────────────

app.get('/cron/overdue-rent', async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    await runOverdueRentCheck();
    res.json({ ok: true, job: 'overdue-rent', ts: new Date().toISOString() });
  } catch (err) {
    logger.error('Cron job failed: overdue-rent', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Cron: stale work-order alert (09:00 PST / 17:00 UTC) ────────────────────

app.get('/cron/stale-workorders', async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    await runStaleWorkOrderCheck();
    res.json({ ok: true, job: 'stale-workorders', ts: new Date().toISOString() });
  } catch (err) {
    logger.error('Cron job failed: stale-workorders', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Cron: weekly financial report (17:00 PST Friday / 01:00 UTC Saturday) ───

app.get('/cron/weekly-report', async (req, res) => {
  if (!verifyCron(req, res)) return;
  try {
    await runWeeklyReport();
    res.json({ ok: true, job: 'weekly-report', ts: new Date().toISOString() });
  } catch (err) {
    logger.error('Cron job failed: weekly-report', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;
