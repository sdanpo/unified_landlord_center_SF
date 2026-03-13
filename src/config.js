'use strict';

require('dotenv').config();

const config = {
  pms: {
    erpnext: {
      baseUrl: process.env.ERPNEXT_BASE_URL || '',
      apiKey: process.env.ERPNEXT_API_KEY || '',
      apiSecret: process.env.ERPNEXT_API_SECRET || '',
    },
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o',
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    // Individual user IDs (positive integers)
    allowedUserIds: new Set(
      (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .map(Number)
    ),
    // Group / supergroup chat IDs (negative integers, e.g. -1001234567890)
    allowedGroupIds: new Set(
      (process.env.TELEGRAM_ALLOWED_GROUP_IDS || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .map(Number)
    ),
  },

  webhook: {
    port: parseInt(process.env.WEBHOOK_PORT || '3000', 10),
    secret: process.env.WEBHOOK_SECRET || '',
    baseUrl: process.env.WEBHOOK_BASE_URL || 'http://localhost:3000',
  },

  // Twilio is the sole SMS provider (ERPNext has no outbound SMS API).
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
  },

  reports: {
    delivery: process.env.REPORT_DELIVERY || 'telegram',
    googleDriveFolderId: process.env.REPORT_GOOGLE_DRIVE_FOLDER_ID || '',
    emailTo: process.env.REPORT_EMAIL_TO || '',
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

function validate() {
  const errors = [];

  if (!config.telegram.botToken) errors.push('TELEGRAM_BOT_TOKEN is required');
  if (config.telegram.allowedUserIds.size === 0)
    errors.push('TELEGRAM_ALLOWED_USER_IDS must contain at least one Telegram user ID');
  if (!config.openai.apiKey) errors.push('OPENAI_API_KEY is required');

  // ERPNext connection
  if (!config.pms.erpnext.baseUrl) errors.push('ERPNEXT_BASE_URL is required');
  if (!config.pms.erpnext.apiKey) errors.push('ERPNEXT_API_KEY is required');
  if (!config.pms.erpnext.apiSecret) errors.push('ERPNEXT_API_SECRET is required');

  // Twilio is required — no fallback SMS provider
  if (!config.twilio.accountSid) errors.push('TWILIO_ACCOUNT_SID is required');
  if (!config.twilio.authToken) errors.push('TWILIO_AUTH_TOKEN is required');
  if (!config.twilio.fromNumber) errors.push('TWILIO_FROM_NUMBER is required');

  if (errors.length) {
    throw new Error(`Configuration errors:\n  • ${errors.join('\n  • ')}`);
  }
}

module.exports = { config, validate };
