'use strict';

/**
 * Vercel serverless entry point.
 *
 * Initialization is lazy (deferred to the first request) so that a bad
 * environment variable or a bot-setup failure does not prevent Vercel from
 * loading the module – which would produce the opaque
 * "FUNCTION_INVOCATION_FAILED" 500 with no useful message.
 *
 * On the first request:
 *   1. Config is validated; if a required env var is missing the handler
 *      returns 500 with the exact error message so it is visible in Vercel
 *      function logs.
 *   2. The Telegram bot is created in webhook mode (no long-polling thread).
 *   3. The Express app is built and cached for all subsequent requests.
 *
 * Telegram uses webhook mode (POST /webhooks/telegram) instead of polling.
 * Cron jobs are triggered by Vercel Cron calling GET /cron/* endpoints.
 *
 * For local development use `npm run dev` (src/index.js) – long-polling + cron.
 */

let app = null;

function init() {
  if (app) return; // already initialised on a previous invocation

  const { validate } = require('../src/config');
  validate(); // throws with a descriptive message if env vars are missing

  const { createBot } = require('../src/telegram/bot');
  createBot({ webhookMode: true });

  const { createWebhookApp } = require('../src/webhook/server');
  app = createWebhookApp(); // only assigned if everything above succeeded
}

module.exports = (req, res) => {
  try {
    init();
  } catch (err) {
    // Log to Vercel's function log and return a clear error to the caller.
    console.error('[unified-landlord-center] startup error:', err.message);
    return res.status(500).json({ error: 'Server configuration error', detail: err.message });
  }

  app(req, res);
};
