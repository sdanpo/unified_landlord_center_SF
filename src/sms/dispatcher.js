'use strict';

/**
 * SMS Dispatcher
 *
 * All outbound tenant SMS messages flow through this module.
 *
 * Strategy (in priority order):
 *   1. If USE_TWILIO=true  → use the Twilio REST API (maximum automation flexibility).
 *   2. Otherwise           → use the native PMS SMS endpoint (DoorLoop Communications
 *                            Center or Buildium equivalent), which requires no additional
 *                            account setup and uses the dedicated local number registered
 *                            in the PMS.
 *
 * The caller always calls dispatcher.send() and never needs to know which
 * backend is active.
 */

const axios = require('axios');
const logger = require('../logger');
const { config } = require('../config');
const pmsClient = require('../api/index');

// ─── Twilio backend ──────────────────────────────────────────────────────────

async function sendViaTwilio({ phone, message }) {
  if (!phone) throw new Error('phone number is required for Twilio dispatch');

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

// ─── Native PMS backend ───────────────────────────────────────────────────────

async function sendViaPMS({ tenantId, phone, message }) {
  if (tenantId) {
    return pmsClient.sendSMS(tenantId, message);
  }
  if (phone) {
    return pmsClient.sendSMSToPhone(phone, message);
  }
  throw new Error('Either tenantId or phone is required for PMS SMS dispatch');
}

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * Send an SMS to a tenant.
 *
 * @param {Object} options
 * @param {string} [options.tenantId] – PMS tenant ID (preferred for PMS backend)
 * @param {string} [options.phone]    – E.164 phone number (required for Twilio)
 * @param {string} options.message    – Message body
 */
async function send({ tenantId, phone, message }) {
  if (!message) throw new Error('message is required');

  try {
    if (config.twilio.enabled) {
      return await sendViaTwilio({ phone, message });
    }
    return await sendViaPMS({ tenantId, phone, message });
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
