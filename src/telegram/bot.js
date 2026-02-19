'use strict';

/**
 * Telegram bot initialization and lifecycle management.
 *
 * Responsibilities:
 *   1. Create the bot instance (long-polling mode for simplicity;
 *      webhook mode can be enabled by setting TELEGRAM_WEBHOOK=true).
 *   2. Enforce the Telegram User ID whitelist on every inbound message.
 *   3. Route commands and free-form messages to the correct handler.
 *   4. Expose a notifyLandlord() function used by the webhook event
 *      handlers and the automation scheduler to push proactive alerts.
 */

const TelegramBot = require('node-telegram-bot-api');
const logger = require('../logger');
const { config } = require('../config');
const { guard } = require('./security');
const { handleStart, handleHelp, handleClear, handleMessage } = require('./handlers');

let bot = null;

// ─── Bot factory ─────────────────────────────────────────────────────────────

function createBot() {
  if (bot) return bot;

  bot = new TelegramBot(config.telegram.botToken, { polling: true });

  logger.info('Telegram bot started (long-polling)');

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
    // Skip command messages already handled above
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

// ─── Proactive landlord notifications ────────────────────────────────────────

/**
 * Push a message to all whitelisted landlord Telegram chats.
 *
 * Used by:
 *   - webhook/handlers.js  – real-time PMS event alerts
 *   - automation/scheduler.js – scheduled proactive alerts
 *
 * @param {string} text – Message text (Markdown supported)
 */
async function notifyLandlord(text) {
  if (!bot) {
    logger.warn('notifyLandlord called before bot was initialized');
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

module.exports = { createBot, notifyLandlord, stopBot };
