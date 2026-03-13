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
let botInfo = null; // populated by getMe() on startup

// ─── Group-mention filter ─────────────────────────────────────────────────────

/**
 * Returns true when a message should be processed.
 *
 * Private chats  → always respond.
 * Group chats    → only respond when the bot is explicitly addressed:
 *                    • @mention in the message text/entities, OR
 *                    • a direct reply to one of the bot's own messages.
 *
 * Also returns the message text with the @mention prefix stripped so the AI
 * receives clean input ("@LandlordBot what is the rent status?" → "what is
 * the rent status?").
 *
 * @returns {{ addressed: boolean, text: string }}
 */
function parseGroupMessage(msg) {
  const isGroup = ['group', 'supergroup'].includes(msg.chat?.type);
  const text = msg.text || '';

  if (!isGroup) {
    return { addressed: true, text };
  }

  // Direct reply to the bot's own message
  if (botInfo && msg.reply_to_message?.from?.id === botInfo.id) {
    return { addressed: true, text };
  }

  // @mention anywhere in the message (Telegram marks these in msg.entities)
  const mentioned = (msg.entities || []).some(
    (e) => e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase()
      === `@${(botInfo?.username || '').toLowerCase()}`
  );

  if (!mentioned) {
    return { addressed: false, text };
  }

  // Strip the @mention so the AI gets clean input
  const cleanText = text
    .replace(new RegExp(`@${botInfo?.username}\\s*`, 'i'), '')
    .trim();

  return { addressed: true, text: cleanText };
}

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

  // Fetch bot identity so we can detect @mentions in groups
  bot.getMe().then((info) => {
    botInfo = info;
    logger.info('Telegram bot started (long-polling)', {
      username: botInfo.username,
      id: botInfo.id,
      allowedUserIds: [...config.telegram.allowedUserIds],
      allowedGroupIds: [...config.telegram.allowedGroupIds],
    });
  }).catch((err) => {
    logger.error('Telegram getMe() failed', { error: err.message });
  });

  // Debug: log every raw update so misconfiguration is visible in logs.
  // Runs BEFORE the guard so even blocked messages appear.
  bot.on('message', (msg) => {
    logger.debug('Telegram raw message received', {
      chatId: msg.chat?.id,
      chatType: msg.chat?.type,
      chatTitle: msg.chat?.title,
      fromId: msg.from?.id,
      fromUsername: msg.from?.username,
      text: msg.text?.slice(0, 60),
    });
  });

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

    const { addressed, text } = parseGroupMessage(msg);
    if (!addressed) return; // group message not directed at the bot

    // Pass clean text (mention stripped) to the AI handler
    await handleMessage(bot, { ...msg, text });
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
