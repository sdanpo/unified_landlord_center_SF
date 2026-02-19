'use strict';

/**
 * Application entry point.
 *
 * Startup order:
 *   1. Validate environment configuration
 *   2. Start the Express webhook server
 *   3. Start the Telegram NLP bot
 *   4. Start the automation scheduler (cron jobs)
 */

const { validate } = require('./config');
const logger = require('./logger');

async function main() {
  // ── 1. Configuration validation ─────────────────────────────────────────────
  try {
    validate();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // ── 2. Webhook server ────────────────────────────────────────────────────────
  const { createWebhookApp } = require('./webhook/server');
  const { config } = require('./config');

  const app = createWebhookApp();
  const server = app.listen(config.webhook.port, () => {
    logger.info(`Webhook server listening on port ${config.webhook.port}`);
    logger.info(`PMS webhook endpoint: POST ${config.webhook.baseUrl}/webhooks/${config.pms.provider}`);
  });

  // ── 3. Telegram bot ──────────────────────────────────────────────────────────
  const { createBot } = require('./telegram/bot');
  createBot();

  // ── 4. Automation scheduler ──────────────────────────────────────────────────
  const scheduler = require('./automation/scheduler');
  scheduler.start();

  logger.info('Unified Landlord Center started successfully', {
    pmsProvider: 'doorloop',
    reportDelivery: config.reports.delivery,
  });

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  const shutdown = async (signal) => {
    logger.info(`Received ${signal} – shutting down`);

    scheduler.stop();

    const { stopBot } = require('./telegram/bot');
    await stopBot();

    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });

    // Force exit after 10 s if graceful close hangs
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
