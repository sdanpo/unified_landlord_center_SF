'use strict';

/**
 * SMS dispatcher — thin wrapper around Twilio's REST API.
 *
 * Usage:
 *   const { send, templates } = require('./dispatcher');
 *   await send('+14155551234', templates.rentOverdue({ unit, amountDue }));
 */

const axios  = require('axios');
const logger = require('../logger');

const SID   = process.env.TWILIO_ACCOUNT_SID   || '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN     || '';
const FROM  = process.env.TWILIO_FROM_NUMBER    || '';

/**
 * Send an SMS message via Twilio.
 * @param {string} to      E.164 phone number
 * @param {string} body    Message text (≤320 chars for SMS, longer for MMS)
 * @returns {Promise<{ sid: string }>}
 */
async function send(to, body) {
  if (!SID || !TOKEN || !FROM) {
    logger.warn('SMS send skipped — Twilio credentials not configured', { to });
    return { sid: 'SKIPPED' };
  }

  const { HttpsProxyAgent } = require('https-proxy-agent');
  const proxyUrl   = process.env.https_proxy || process.env.HTTPS_PROXY || '';
  const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  const { data } = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
    new URLSearchParams({ To: to, From: FROM, Body: body }).toString(),
    {
      auth: { username: SID, password: TOKEN },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      ...(httpsAgent ? { httpsAgent, proxy: false } : {}),
    }
  );

  logger.info('SMS sent', { to, sid: data.sid });
  return { sid: data.sid };
}

// ── Message templates ─────────────────────────────────────────────────────────

const templates = {
  /**
   * Outbound alert when rent is overdue.
   * @param {{ unit: string, propertyAddress: string, amountDue: number }} p
   */
  rentOverdue({ unit, propertyAddress, amountDue }) {
    return `Rent overdue notice: $${amountDue} is past due for ${unit || propertyAddress}. ` +
           'Please pay at your tenant portal or contact the office.';
  },

  /**
   * Friendly reminder a few days before the due date.
   * @param {{ unit: string, amountDue: number, dueDate: string }} p
   */
  rentReminder({ unit, amountDue, dueDate }) {
    return `Rent reminder: $${amountDue} is due ${dueDate} for ${unit}. ` +
           'Pay early via your tenant portal to avoid late fees.';
  },

  /**
   * Tenant notification when maintenance is scheduled.
   * @param {{ unit: string, description: string, scheduledDate: string }} p
   */
  maintenanceScheduled({ unit, description, scheduledDate }) {
    return `Maintenance scheduled: "${description}" at ${unit}` +
           (scheduledDate ? ` on ${scheduledDate}` : '') + '. ';
  },

  /**
   * Tenant notification when maintenance is complete.
   * @param {{ unit: string, description: string }} p
   */
  maintenanceComplete({ unit, description }) {
    return `Maintenance complete: "${description}" at ${unit} has been resolved. ` +
           'Please contact us if you have any concerns.';
  },
};

module.exports = { send, templates };
