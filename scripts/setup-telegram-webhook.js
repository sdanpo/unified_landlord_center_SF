#!/usr/bin/env node
'use strict';

/**
 * One-time setup script: registers the Telegram webhook URL with the
 * Telegram Bot API so Telegram delivers updates to your Vercel deployment
 * instead of waiting to be polled.
 *
 * Run once after each new Vercel deployment (the domain doesn't change
 * unless you use preview URLs):
 *
 *   TELEGRAM_BOT_TOKEN=xxx \
 *   TELEGRAM_WEBHOOK_SECRET=yyy \
 *   WEBHOOK_BASE_URL=https://your-app.vercel.app \
 *   node scripts/setup-telegram-webhook.js
 *
 * To inspect the current webhook configuration:
 *   node scripts/setup-telegram-webhook.js --info
 *
 * To delete the webhook (revert to polling):
 *   node scripts/setup-telegram-webhook.js --delete
 */

require('dotenv').config();
const https = require('https');

const token = process.env.TELEGRAM_BOT_TOKEN;
const baseUrl = process.env.WEBHOOK_BASE_URL;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';

if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set.');
  process.exit(1);
}

const arg = process.argv[2];

function telegramRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (arg === '--info') {
    const result = await telegramRequest('getWebhookInfo');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (arg === '--delete') {
    const result = await telegramRequest('deleteWebhook');
    console.log('Webhook deleted:', result);
    return;
  }

  if (!baseUrl) {
    console.error('Error: WEBHOOK_BASE_URL is not set (e.g. https://your-app.vercel.app)');
    process.exit(1);
  }

  const webhookUrl = `${baseUrl.replace(/\/$/, '')}/webhooks/telegram`;
  console.log(`Registering webhook → ${webhookUrl}`);

  const params = { url: webhookUrl };
  if (secret) params.secret_token = secret;

  const result = await telegramRequest('setWebhook', params);

  if (result.ok) {
    console.log('✅ Webhook registered successfully.');
    if (secret) console.log('   Secret token set (X-Telegram-Bot-Api-Secret-Token will be verified).');
  } else {
    console.error('❌ Failed to register webhook:', result.description);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
