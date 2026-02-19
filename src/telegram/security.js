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
 * Returns true if the Telegram userId is in the whitelist.
 * @param {number|string} userId – msg.from.id from the Telegram update
 */
function isAuthorized(userId) {
  return config.telegram.allowedUserIds.has(Number(userId));
}

/**
 * Express-style middleware for the Telegram polling handler.
 * Returns a wrapped handler that performs the whitelist check before
 * delegating to the real handler function.
 *
 * Usage:
 *   bot.on('message', guard(async (msg) => { ... }));
 */
function guard(handler) {
  return async function (msg) {
    const userId = msg?.from?.id;

    if (!isAuthorized(userId)) {
      logger.warn('Unauthorized Telegram access attempt silently dropped', {
        userId,
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
