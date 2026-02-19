'use strict';

// Set required env vars before any module is imported in tests
process.env.PMS_PROVIDER = 'doorloop';
process.env.DOORLOOP_API_KEY = 'test-doorloop-key';
process.env.DOORLOOP_BASE_URL = 'https://api.doorloop.com/v1';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.OPENAI_MODEL = 'gpt-4o';
process.env.TELEGRAM_BOT_TOKEN = '123456789:test-token';
process.env.TELEGRAM_ALLOWED_USER_IDS = '111111,222222';
process.env.WEBHOOK_PORT = '3001';
process.env.WEBHOOK_SECRET = 'test-webhook-secret';
process.env.WEBHOOK_BASE_URL = 'http://localhost:3001';
process.env.USE_TWILIO = 'false';
process.env.LOG_LEVEL = 'error'; // suppress logs during tests
