'use strict';

/**
 * Telegram security guard.
 *
 * Per the PRD: "The Botpress agent must be configured to only accept
 * messages and execute queries from the specific, hardcoded Telegram
 * User ID(s) belonging to the landlord / management team."
 *
 * Any message originating from an unauthorized user ID is silently
 * dropped – we intentionally do NOT send an error reply so that the
 * bot's existence is not confirmed to unauthorized parties.
 */

const logger = require('../logger');
const { config } = require('../config');

/**
 * Returns true if the sender or the chat they're writing in is whitelisted.
 * Accepts individual user IDs (positive) and group/supergroup chat IDs (negative).
 *
 * @param {number|string} userId  – msg.from.id
 * @param {number|string} chatId  – msg.chat.id
 */
function isAuthorized(userId, chatId) {
  if (config.telegram.allowedUserIds.has(Number(userId))) return true;
  if (config.telegram.allowedGroupIds.has(Number(chatId))) return true;
  return false;
}

/**
 * Express-style middleware for the Telegram polling handler.
 * Checks both the sender's user ID and the chat ID against their respective
 * whitelists before delegating to the real handler function.
 *
 * Usage:
 *   bot.on('message', guard(async (msg) => { ... }));
 */
function guard(handler) {
  return async function (msg) {
    const userId = msg?.from?.id;
    const chatId = msg?.chat?.id;

    if (!isAuthorized(userId, chatId)) {
      logger.warn('Unauthorized Telegram access attempt silently dropped', {
        userId,
        chatId,
        chatType: msg?.chat?.type,
        username: msg?.from?.username,
        text: msg?.text?.slice(0, 30),
      });
      // Silent drop – no reply sent
      return;
    }

    await handler(msg);
  };
}

module.exports = { isAuthorized, guard };
