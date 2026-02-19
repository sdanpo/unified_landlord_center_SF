'use strict';

/**
 * Telegram bot initialization and lifecycle management.
 *
 * Two operating modes:
 *
 *   polling (default / local dev)
 *     The bot opens a long-poll connection to the Telegram API and receives
 *     updates directly.  Start with `npm run dev`.
 *
 *   webhook  (Vercel / production)
 *     Telegram sends HTTP POST requests to /webhooks/telegram on our server.
 *     The bot is created with polling disabled and updates are fed in via
 *     processUpdate().  Activated by passing { webhookMode: true } to
 *     createBot() or by setting TELEGRAM_WEBHOOK_MODE=true in the environment.
 */

const TelegramBot = require('node-telegram-bot-api');
const logger = require('../logger');
const { config } = require('../config');
const { guard } = require('./security');
const { handleStart, handleHelp, handleClear, handleMessage } = require('./handlers');

let bot = null;

// ─── Bot factory ─────────────────────────────────────────────────────────────

/**
 * @param {Object} [opts]
 * @param {boolean} [opts.webhookMode=false] – Skip long-polling; rely on
 *   processUpdate() being called by the /webhooks/telegram HTTP route instead.
 */
function createBot({ webhookMode = config.telegram.webhookMode } = {}) {
  if (bot) return bot;

  bot = new TelegramBot(config.telegram.botToken, { polling: !webhookMode });

  if (webhookMode) {
    logger.info('Telegram bot started (webhook mode)');
  } else {
    logger.info('Telegram bot started (long-polling)');
  }

  // ── Commands (whitelisted) ─────────────────────────────────────────────────

  bot.onText(/^\/start(@\w+)?$/, guard(async (msg) => {
    await handleStart(bot, msg);
  }));

  bot.onText(/^\/help(@\w+)?$/, guard(async (msg) => {
    await handleHelp(bot, msg);
  }));

  bot.onText(/^\/clear(@\w+)?$/, guard(async (msg) => {
    await handleClear(bot, msg);
  }));

  // ── Free-form NLP messages (whitelisted) ───────────────────────────────────

  bot.on('message', guard(async (msg) => {
    if (msg.text?.startsWith('/')) return;
    await handleMessage(bot, msg);
  }));

  // ── Error handling ─────────────────────────────────────────────────────────

  bot.on('polling_error', (err) => {
    logger.error('Telegram polling error', { error: err.message, code: err.code });
  });

  bot.on('error', (err) => {
    logger.error('Telegram bot error', { error: err.message });
  });

  return bot;
}

// ─── Webhook update ingestion ─────────────────────────────────────────────────

/**
 * Feed a raw Telegram Update object into the bot's event pipeline.
 * Called by the POST /webhooks/telegram Express route in webhook mode.
 *
 * @param {Object} update – The parsed JSON body from Telegram's POST request.
 */
function processUpdate(update) {
  if (!bot) throw new Error('Bot not initialised – call createBot() first');
  bot.processUpdate(update);
}

// ─── Proactive landlord notifications ────────────────────────────────────────

async function notifyLandlord(text) {
  if (!bot) {
    logger.warn('notifyLandlord called before bot was initialised');
    return;
  }

  const results = await Promise.allSettled(
    [...config.telegram.allowedUserIds].map((userId) =>
      bot.sendMessage(userId, text, { parse_mode: 'Markdown' })
    )
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      logger.error('Failed to deliver Telegram notification to landlord', {
        userId: [...config.telegram.allowedUserIds][i],
        error: r.reason?.message,
      });
    }
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function stopBot() {
  if (bot) {
    await bot.stopPolling();
    bot = null;
    logger.info('Telegram bot stopped');
  }
}

module.exports = { createBot, processUpdate, notifyLandlord, stopBot };
