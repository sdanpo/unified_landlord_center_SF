'use strict';

require('dotenv').config();

const config = {
  pms: {
    doorloop: {
      apiKey: process.env.DOORLOOP_API_KEY || '',
      baseUrl: process.env.DOORLOOP_BASE_URL || 'https://api.doorloop.com/v1',
    },
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o',
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    allowedUserIds: new Set(
      (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
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

  twilio: {
    enabled: process.env.USE_TWILIO === 'true',
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
  if (!config.pms.doorloop.apiKey) errors.push('DOORLOOP_API_KEY is required');

  if (errors.length) {
    throw new Error(`Configuration errors:\n  • ${errors.join('\n  • ')}`);
  }
}

module.exports = { config, validate };
