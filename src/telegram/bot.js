'use strict';

/**
 * Telegram bot – supports two operating modes:
 *
 *   Polling mode  (local / non-Vercel)
 *     createBot() starts long-polling.  Called once from src/index.js.
 *
 *   Webhook mode  (Vercel serverless)
 *     No polling.  Telegram POSTs updates to /telegram.
 *     api/index.js calls processUpdate(body) for each incoming POST.
 *     A bot instance is created on the first call and reused within
 *     the same function invocation.
 *
 * notifyLandlord() works in both modes – it lazily creates a send-only
 * bot instance if one is not already running.
 */

const TelegramBot = require('node-telegram-bot-api');
const logger = require('../logger');
const { config } = require('../config');
const { guard } = require('./security');
const { handleStart, handleHelp, handleClear, handleChatId, handleMessage } = require('./handlers');

let bot = null;
let botInfo = null; // populated by getMe() – used for @mention + reply-to detection

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

// ─── Handler registration ─────────────────────────────────────────────────────

/**
 * Attaches all message handlers to a bot instance.
 * Called for both polling bots and webhook-mode bots.
 */
function _registerHandlers(b) {
  b.onText(/^\/start(@\w+)?$/, guard(async (msg) => {
    await handleStart(b, msg);
  }));

  b.onText(/^\/help(@\w+)?$/, guard(async (msg) => {
    await handleHelp(b, msg);
  }));

  b.onText(/^\/clear(@\w+)?$/, guard(async (msg) => {
    await handleClear(b, msg);
  }));

  b.onText(/^\/chatid(@\w+)?$/, guard(async (msg) => {
    await handleChatId(b, msg);
  }));

  b.on('message', guard(async (msg) => {
    if (msg.text?.startsWith('/')) return;

    const { addressed, text } = parseGroupMessage(msg);
    if (!addressed) return;

    await handleMessage(b, { ...msg, text });
  }));

  b.on('polling_error', (err) => {
    logger.error('Telegram polling error', { error: err.message, code: err.code });
  });

  b.on('error', (err) => {
    logger.error('Telegram bot error', { error: err.message });
  });
}

// ─── Shared: lazy bot for sending / webhook processing ───────────────────────

/**
 * Returns a bot instance suitable for sending messages or processing webhook
 * updates.  Does NOT start polling – safe to call in serverless functions.
 */
function _getOrCreateBot() {
  if (bot) return bot;
  bot = new TelegramBot(config.telegram.botToken, { polling: false });
  _registerHandlers(bot);
  return bot;
}

// ─── Polling mode (local dev) ─────────────────────────────────────────────────

function createBot() {
  if (bot) return bot;

  // node-telegram-bot-api uses @cypress/request-promise internally.
  // Pass the system HTTPS proxy so polling works inside proxied containers.
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;

  bot = new TelegramBot(config.telegram.botToken, {
    polling: true,
    ...(proxyUrl && { request: { proxy: proxyUrl } }),
  });

  _registerHandlers(bot);

  // Debug: log every raw update – runs before the guard.
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

  // Fetch bot identity for @mention detection
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

  return bot;
}

// ─── Webhook mode (Vercel) ────────────────────────────────────────────────────

/**
 * Process a single Telegram update received via the /telegram POST endpoint.
 * Called by api/index.js on every incoming Telegram webhook request.
 */
async function processUpdate(update) {
  const b = _getOrCreateBot();

  // Populate botInfo on first call of each serverless invocation.
  // Needed so parseGroupMessage can detect @mentions and reply-to checks.
  if (!botInfo) {
    try {
      botInfo = await b.getMe();
      logger.debug('Telegram bot identity resolved (webhook mode)', {
        username: botInfo.username,
        id: botInfo.id,
      });
    } catch (err) {
      logger.error('Telegram getMe() failed in webhook mode', { error: err.message });
    }
  }

  b.processUpdate(update);
}

// ─── Proactive landlord notifications ────────────────────────────────────────

/**
 * Push a message to all whitelisted landlord users and groups.
 * Works in both polling and webhook mode.
 */
async function notifyLandlord(text) {
  const b = _getOrCreateBot();

  // When a group is configured, send reports/alerts there only — not to
  // individual DMs.  The personal user IDs are kept in allowedUserIds for
  // command *authorization* purposes; they are not notification targets when a
  // group chat already covers the landlord.
  const recipients = config.telegram.allowedGroupIds.size > 0
    ? [...config.telegram.allowedGroupIds]
    : [...config.telegram.allowedUserIds];

  const results = await Promise.allSettled(
    recipients.map((id) =>
      b.sendMessage(id, text, { parse_mode: 'Markdown' })
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

module.exports = { createBot, processUpdate, notifyLandlord, stopBot };
