'use strict';

/**
 * Tests for the ERPNext webhook server and event handlers.
 */

const crypto = require('crypto');
const request = require('supertest');

// Mock the handlers so we can inspect what they receive
jest.mock('../src/webhook/handlers', () => ({
  handle: jest.fn().mockResolvedValue(undefined),
}));

// Mock the PMS client (used by fetchTenantPhone in the server)
jest.mock('../src/api/index', () => ({
  getTenant: jest.fn().mockResolvedValue({ mobile_no: '+15550001234' }),
}));

const { createWebhookApp } = require('../src/webhook/server');
const webhookHandlers = require('../src/webhook/handlers');

let app;

// Helper: build a valid X-Frappe-Webhook-Signature for a payload
const SECRET = 'test-webhook-secret';
function makeSignature(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

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

// ─── Signature validation (tested via invoice-overdue route) ──────────────────

describe('ERPNext signature validation', () => {
  const payload = JSON.stringify({
    name: 'SINV-0001',
    customer: 'CUST-0001',
    customer_name: 'John Doe',
    outstanding_amount: 1200,
    due_date: '2026-01-31',
    custom_unit: 'Unit 3A',
    custom_property: '123 Main St',
    custom_lease: 'RC-0001',
  });

  it('accepts a valid X-Frappe-Webhook-Signature and calls handle()', async () => {
    const sig = makeSignature(payload);

    const res = await request(app)
      .post('/webhooks/erpnext/invoice-overdue')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', sig)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(webhookHandlers.handle).toHaveBeenCalledTimes(1);
  });

  it('rejects a request with an invalid signature', async () => {
    const res = await request(app)
      .post('/webhooks/erpnext/invoice-overdue')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', 'deadbeef')
      .send(payload);

    expect(res.status).toBe(401);
    expect(webhookHandlers.handle).not.toHaveBeenCalled();
  });

  it('rejects a request with no signature header', async () => {
    const res = await request(app)
      .post('/webhooks/erpnext/invoice-overdue')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(401);
  });
});

// ─── ERPNext route → normalized event mapping ─────────────────────────────────

describe('POST /webhooks/erpnext/invoice-overdue', () => {
  it('normalizes Sales Invoice payload to rent.overdue event', async () => {
    const payload = JSON.stringify({
      name: 'SINV-0001',
      customer: 'CUST-0001',
      customer_name: 'John Doe',
      outstanding_amount: 1500,
      due_date: '2026-01-31',
      custom_unit: 'Unit 3A',
      custom_property: '123 Main St',
      custom_lease: 'RC-0001',
    });

    const res = await request(app)
      .post('/webhooks/erpnext/invoice-overdue')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', makeSignature(payload))
      .send(payload);

    expect(res.status).toBe(200);
    const [event] = webhookHandlers.handle.mock.calls[0];
    expect(event.type).toBe('rent.overdue');
    expect(event.data.tenantName).toBe('John Doe');
    expect(event.data.amountDue).toBe(1500);
    expect(event.data.unit).toBe('Unit 3A');
    expect(event.data.leaseId).toBe('RC-0001');
  });
});

describe('POST /webhooks/erpnext/payment-received', () => {
  it('normalizes Payment Entry payload to payment.received event', async () => {
    const payload = JSON.stringify({
      name: 'PE-0001',
      party: 'CUST-0001',
      party_name: 'John Doe',
      paid_amount: 1500,
      mode_of_payment: 'ACH',
      custom_unit: 'Unit 3A',
      custom_lease: 'RC-0001',
    });

    const res = await request(app)
      .post('/webhooks/erpnext/payment-received')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', makeSignature(payload))
      .send(payload);

    expect(res.status).toBe(200);
    const [event] = webhookHandlers.handle.mock.calls[0];
    expect(event.type).toBe('payment.received');
    expect(event.data.amountPaid).toBe(1500);
    expect(event.data.paymentMethod).toBe('ACH');
  });
});

describe('POST /webhooks/erpnext/ticket-created', () => {
  it('normalizes Maintenance Request to workorder.created event', async () => {
    const payload = JSON.stringify({
      name: 'HDT-0001',
      subject: 'Broken heater',
      status: 'Open',
      priority: 'High',
      customer_name: 'Jane Smith',
      custom_unit: 'Unit 2B',
      custom_property: '456 Oak Ave',
      description: 'The heater is broken.',
    });

    const res = await request(app)
      .post('/webhooks/erpnext/ticket-created')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', makeSignature(payload))
      .send(payload);

    expect(res.status).toBe(200);
    const [event] = webhookHandlers.handle.mock.calls[0];
    expect(event.type).toBe('workorder.created');
    expect(event.data.id).toBe('HDT-0001');
    expect(event.data.description).toBe('Broken heater');
    expect(event.data.priority).toBe('High');
  });
});

describe('POST /webhooks/erpnext/ticket-updated', () => {
  it('normalizes Maintenance Request update to workorder.updated event', async () => {
    const payload = JSON.stringify({
      name: 'HDT-0001',
      status: 'Resolved',
      custom_unit: 'Unit 2B',
      resolution: 'Replaced the heating element.',
    });

    const res = await request(app)
      .post('/webhooks/erpnext/ticket-updated')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', makeSignature(payload))
      .send(payload);

    expect(res.status).toBe(200);
    const [event] = webhookHandlers.handle.mock.calls[0];
    expect(event.type).toBe('workorder.updated');
    expect(event.data.status).toBe('Resolved');
    expect(event.data.vendorNotes).toBe('Replaced the heating element.');
  });
});

describe('POST /webhooks/erpnext/contract-submitted', () => {
  it('normalizes Rental Contract to lease.created event', async () => {
    const payload = JSON.stringify({
      name: 'RC-0001',
      tenant_name: 'Alice Brown',
      property_unit: 'Unit 1A',
      start_date: '2026-02-01',
      end_date: '2027-01-31',
      monthly_rent: 1800,
    });

    const res = await request(app)
      .post('/webhooks/erpnext/contract-submitted')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', makeSignature(payload))
      .send(payload);

    expect(res.status).toBe(200);
    const [event] = webhookHandlers.handle.mock.calls[0];
    expect(event.type).toBe('lease.created');
    expect(event.data.tenantName).toBe('Alice Brown');
    expect(event.data.monthlyRent).toBe(1800);
  });
});

describe('POST /webhooks/erpnext/contract-cancelled', () => {
  it('normalizes Rental Contract cancellation to lease.expired event', async () => {
    const payload = JSON.stringify({
      name: 'RC-0001',
      tenant_name: 'Alice Brown',
      property_unit: 'Unit 1A',
    });

    const res = await request(app)
      .post('/webhooks/erpnext/contract-cancelled')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', makeSignature(payload))
      .send(payload);

    expect(res.status).toBe(200);
    const [event] = webhookHandlers.handle.mock.calls[0];
    expect(event.type).toBe('lease.expired');
    expect(event.data.unit).toBe('Unit 1A');
  });
});

// ─── Handler error → 500 ──────────────────────────────────────────────────────

describe('handler error propagation', () => {
  it('returns 500 when the handler throws', async () => {
    webhookHandlers.handle.mockRejectedValueOnce(new Error('DB error'));

    const payload = JSON.stringify({ name: 'PE-0001', party_name: 'Jane', paid_amount: 500 });

    const res = await request(app)
      .post('/webhooks/erpnext/payment-received')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', makeSignature(payload))
      .send(payload);

    expect(res.status).toBe(500);
  });
});

// ─── Webhook handlers unit tests ──────────────────────────────────────────────

describe('webhook/handlers (routing)', () => {
  let realHandlers;

  beforeAll(() => {
    jest.mock('../src/sms/dispatcher', () => ({ send: jest.fn().mockResolvedValue({}) }));
    jest.mock('../src/telegram/bot', () => ({ notifyLandlord: jest.fn().mockResolvedValue({}) }));
    jest.resetModules();
    realHandlers = require('../src/webhook/handlers');
  });

  it('handles unknown event types without throwing', async () => {
    await expect(
      realHandlers.handle({ type: 'unknown.event', data: {} })
    ).resolves.toBeUndefined();
  });
});
