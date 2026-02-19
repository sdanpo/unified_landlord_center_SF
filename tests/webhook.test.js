'use strict';

/**
 * Tests for the webhook server and event handlers.
 */

const crypto = require('crypto');
const request = require('supertest');

// Mock the handlers so we can inspect what they receive
jest.mock('../src/webhook/handlers', () => ({
  handle: jest.fn().mockResolvedValue(undefined),
}));

const { createWebhookApp } = require('../src/webhook/server');
const webhookHandlers = require('../src/webhook/handlers');

let app;

beforeEach(() => {
  jest.clearAllMocks();
  app = createWebhookApp();
});

// ─── Health check ─────────────────────────────────────────────────────────────

describe('GET /webhooks/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/webhooks/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.ts).toBeDefined();
  });
});

// ─── DoorLoop webhook ─────────────────────────────────────────────────────────

describe('POST /webhooks/doorloop', () => {
  const secret = 'test-webhook-secret';

  function makeSignature(body) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  it('accepts a valid signed webhook and calls handle()', async () => {
    const payload = JSON.stringify({
      type: 'rent.overdue',
      id: 'evt-001',
      data: { tenantId: 't1', amountDue: 1200 },
    });

    const sig = makeSignature(payload);

    const res = await request(app)
      .post('/webhooks/doorloop')
      .set('Content-Type', 'application/json')
      .set('x-pms-signature', sig)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(webhookHandlers.handle).toHaveBeenCalledTimes(1);
  });

  it('rejects a request with an invalid signature', async () => {
    const payload = JSON.stringify({ type: 'rent.overdue' });

    const res = await request(app)
      .post('/webhooks/doorloop')
      .set('Content-Type', 'application/json')
      .set('x-pms-signature', 'deadbeef')
      .send(payload);

    expect(res.status).toBe(401);
    expect(webhookHandlers.handle).not.toHaveBeenCalled();
  });

  it('rejects a request with no signature header', async () => {
    const res = await request(app)
      .post('/webhooks/doorloop')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'rent.overdue' }));

    expect(res.status).toBe(401);
  });

  it('returns 500 when the handler throws', async () => {
    webhookHandlers.handle.mockRejectedValueOnce(new Error('DB error'));

    const payload = JSON.stringify({ type: 'rent.overdue', id: 'evt-002' });
    const sig = makeSignature(payload);

    const res = await request(app)
      .post('/webhooks/doorloop')
      .set('Content-Type', 'application/json')
      .set('x-pms-signature', sig)
      .send(payload);

    expect(res.status).toBe(500);
  });
});

// ─── Webhook handlers unit tests ──────────────────────────────────────────────

describe('webhook/handlers (routing)', () => {
  // Reset the module so we get the real implementation
  let realHandlers;

  beforeAll(() => {
    // Manually mock the downstream deps that handlers use
    jest.mock('../src/sms/dispatcher', () => ({ send: jest.fn().mockResolvedValue({}) }));
    jest.mock('../src/telegram/bot', () => ({ notifyLandlord: jest.fn().mockResolvedValue({}) }));

    jest.resetModules();
    // Re-require after setting up mocks
    realHandlers = require('../src/webhook/handlers');
  });

  it('handles unknown event types without throwing', async () => {
    await expect(
      realHandlers.handle({ type: 'unknown.event', data: {} })
    ).resolves.toBeUndefined();
  });
});
