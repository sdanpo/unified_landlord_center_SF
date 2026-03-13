'use strict';

/**
 * Telegram bot initialization and lifecycle management.
 *
 * Uses long-polling: the bot opens a persistent connection to the
 * Telegram API and receives updates directly.  Start the server with
 * `npm start` or `npm run dev`.
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

  // node-telegram-bot-api uses @cypress/request-promise internally.
  // Pass the system HTTPS proxy so polling works inside proxied containers.
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  const botOptions = {
    polling: true,
    ...(proxyUrl && { request: { proxy: proxyUrl } }),
  };

  bot = new TelegramBot(config.telegram.botToken, botOptions);

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
 * Used by webhook/handlers.js and automation/scheduler.js.
 *
 * @param {string} text – Message text (Markdown supported)
 */
async function notifyLandlord(text) {
  if (!bot) {
    logger.warn('notifyLandlord called before bot was initialised');
    return;
  }

  const recipients = [
    ...config.telegram.allowedUserIds,
    ...config.telegram.allowedGroupIds,
  ];

  const results = await Promise.allSettled(
    recipients.map((id) =>
      bot.sendMessage(id, text, { parse_mode: 'Markdown' })
    )
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      logger.error('Failed to deliver Telegram notification to landlord', {
        recipientId: recipients[i],
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
