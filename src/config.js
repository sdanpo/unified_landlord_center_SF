'use strict';

require('dotenv').config();

const config = {
  pms: {
    erpnext: {
      baseUrl:   process.env.ERPNEXT_BASE_URL   || '',
      apiKey:    process.env.ERPNEXT_API_KEY     || '',
      apiSecret: process.env.ERPNEXT_API_SECRET  || '',
    },
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model:  process.env.OPENAI_MODEL   || 'gpt-4o',
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

  stripe: {
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    secretKey:      process.env.STRIPE_SECRET_KEY      || '',
    paymentAccount: process.env.STRIPE_PAYMENT_ACCOUNT || 'Debtors - LD',
  },

  webhook: {
    port:   parseInt(process.env.WEBHOOK_PORT || '3000', 10),
    secret: process.env.WEBHOOK_SECRET || '',
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

function validate() {
  const errors = [];

  if (!config.telegram.botToken)
    errors.push('TELEGRAM_BOT_TOKEN is required');
  if (config.telegram.allowedUserIds.size === 0)
    errors.push('TELEGRAM_ALLOWED_USER_IDS must contain at least one Telegram user ID');
  if (!config.openai.apiKey)
    errors.push('OPENAI_API_KEY is required');

  // ERPNext connection (used by the AI agentic loop)
  if (!config.pms.erpnext.baseUrl)   errors.push('ERPNEXT_BASE_URL is required');
  if (!config.pms.erpnext.apiKey)    errors.push('ERPNEXT_API_KEY is required');
  if (!config.pms.erpnext.apiSecret) errors.push('ERPNEXT_API_SECRET is required');

  if (errors.length) {
    throw new Error(`Configuration errors:\n  • ${errors.join('\n  • ')}`);
  }
}

module.exports = { config, validate };
