'use strict';

// Set required env vars before any module is imported in tests
process.env.ERPNEXT_BASE_URL = 'https://erpnext.test.local';
process.env.ERPNEXT_API_KEY = 'test-api-key';
process.env.ERPNEXT_API_SECRET = 'test-api-secret';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.OPENAI_MODEL = 'gpt-4o';
process.env.TELEGRAM_BOT_TOKEN = '123456789:test-token';
process.env.TELEGRAM_ALLOWED_USER_IDS = '111111,222222';
process.env.WEBHOOK_PORT = '3001';
process.env.WEBHOOK_SECRET = 'test-webhook-secret';
process.env.WEBHOOK_BASE_URL = 'http://localhost:3001';
process.env.TWILIO_ACCOUNT_SID = 'ACtest00000000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'test-twilio-auth-token';
process.env.TWILIO_FROM_NUMBER = '+15550000000';
process.env.LOG_LEVEL = 'error'; // suppress logs during tests
