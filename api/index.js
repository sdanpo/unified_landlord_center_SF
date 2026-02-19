'use strict';

/**
 * Vercel serverless entry point.
 *
 * Vercel invokes this module per HTTP request – there is no persistent
 * process.  Because of that:
 *   • Telegram uses webhook mode (Telegram POSTs to /webhooks/telegram)
 *     instead of long-polling.
 *   • Scheduled jobs are triggered by Vercel Cron calling /cron/* endpoints
 *     instead of node-cron running in-process.
 *
 * For local development, use `npm run dev` (src/index.js) which starts the
 * traditional long-polling bot + node-cron scheduler.
 */

const { validate } = require('../src/config');
const { createBot } = require('../src/telegram/bot');
const { createWebhookApp } = require('../src/webhook/server');

// Validate required env vars on every cold start so misconfiguration
// surfaces immediately rather than failing mid-request.
validate();

// Initialise the bot in webhook mode (no long-polling background thread).
createBot({ webhookMode: true });

// Export the Express app – Vercel treats it as an HTTP handler.
module.exports = createWebhookApp();
