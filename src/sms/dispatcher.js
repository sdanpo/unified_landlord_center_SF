'use strict';

/**
 * SMS Dispatcher
 *
 * All outbound tenant SMS messages flow through this module via Twilio.
 * ERPNext has no outbound SMS API, so Twilio is the sole provider.
 *
 * The caller always uses dispatcher.send() and never needs to know the
 * underlying transport.
 */

const axios = require('axios');
const logger = require('../logger');
const { config } = require('../config');

// ─── Twilio backend ───────────────────────────────────────────────────────────

async function sendViaTwilio({ phone, message }) {
  if (!phone) throw new Error('phone number is required for SMS dispatch');

  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Messages.json`;

  const params = new URLSearchParams({
    To: phone,
    From: config.twilio.fromNumber,
    Body: message,
  });

  const { data } = await axios.post(url, params.toString(), {
    auth: {
      username: config.twilio.accountSid,
      password: config.twilio.authToken,
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10_000,
  });

  logger.info('Twilio SMS dispatched', { sid: data.sid, to: phone });
  return data;
}

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * Send an SMS to a tenant via Twilio.
 *
 * @param {Object} options
 * @param {string} options.phone    – E.164 phone number (e.g. "+15550001234")
 * @param {string} options.message  – Message body
 * @param {string} [options.tenantId] – ERPNext Customer name (for log context only)
 */
async function send({ tenantId, phone, message }) {
  if (!message) throw new Error('message is required');
  if (!phone) throw new Error('phone is required – look up the tenant phone from ERPNext before calling send()');

  try {
    return await sendViaTwilio({ phone, message });
  } catch (err) {
    logger.error('SMS dispatch failed', {
      tenantId,
      phone,
      error: err.message,
      messageSnippet: message.slice(0, 60),
    });
    throw err;
  }
}

/**
 * Pre-built message templates used by the automation scheduler and
 * webhook handlers to ensure consistent tenant-facing messaging.
 */
const templates = {
  rentOverdue: ({ unit, propertyAddress, amountDue }) =>
    `This is an automated alert from Management. ` +
    `Your rent balance of $${amountDue} for ${unit} at ${propertyAddress} is currently past due. ` +
    `Please remit payment via your tenant portal at your earliest convenience.`,

  rentReminder: ({ unit, amountDue, dueDate }) =>
    `Friendly reminder from Management: your rent of $${amountDue} for ${unit} ` +
    `is due on ${dueDate}. Please pay via your tenant portal to avoid a late fee.`,

  maintenanceScheduled: ({ unit, description, scheduledDate }) =>
    `Your maintenance request (${description}) for ${unit} has been scheduled for ${scheduledDate}. ` +
    `Please ensure access is available. Contact Management with any questions.`,

  maintenanceComplete: ({ unit, description }) =>
    `Your maintenance request (${description}) for ${unit} has been completed. ` +
    `Please let us know if there are any remaining issues.`,
};

module.exports = { send, templates };
