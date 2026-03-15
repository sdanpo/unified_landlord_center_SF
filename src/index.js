'use strict';

/**
 * Application entry point.
 *
 * The server now has a single responsibility: run the Telegram AI bot.
 * Scheduled notifications and event-driven alerts (SMS, Telegram) are
 * handled directly by ERPNext Server Scripts – see:
 *   scripts/setup-erpnext-integration.js
 */

const { validate, config } = require('./config');
const logger = require('./logger');

async function main() {
  // ── 1. Configuration validation ─────────────────────────────────────────────
  try {
    validate();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // ── 2. HTTP webhook server (Stripe checkout, Twilio inbound SMS) ─────────────
  const { createServer } = require('./webhook/server');
  const app  = createServer();
  const port = config.webhook.port;
  const httpServer = app.listen(port, () => {
    logger.info('HTTP webhook server started', { port });
  });

  // ── 3. Telegram AI bot ───────────────────────────────────────────────────────
  const { createBot, stopBot } = require('./telegram/bot');
  createBot();

  logger.info('Unified Landlord Center started', {
    webhookPort: port,
    note: 'Scheduling and SMS notifications handled by ERPNext Server Scripts',
  });

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    logger.info(`Received ${signal} – shutting down`);
    await stopBot();
    httpServer.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
