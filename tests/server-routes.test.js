'use strict';

/**
 * Unit tests for the webhook HTTP server routes.
 *
 * Covers:
 *  – GET  /api/properties-for-apply
 *  – POST /webhooks/erpnext/application-submitted
 *  – POST /webhooks/boldsign/completed  (signature validation + event routing)
 *  – POST /webhooks/smartmove/completed
 *  – GET  /payment-history
 *  – validateStripeSignature()          (exported for direct testing)
 *  – renderPaymentHistoryHtml()         (HTML output sanity)
 *  – GET  /webhooks/health
 *
 * All external HTTP calls (ERPNext, Stripe) are mocked via jest.
 */

jest.mock('axios');
const axios = require('axios');

const mockGet  = jest.fn();
const mockPost = jest.fn();
const mockPut  = jest.fn();
const mockHttp = {
  get:  mockGet,
  post: mockPost,
  put:  mockPut,
  interceptors: { response: { use: jest.fn() } },
};

const mockNotify = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/telegram/bot',    () => ({ notifyLandlord: mockNotify }));
jest.mock('../src/sms/dispatcher',  () => ({
  send: jest.fn().mockResolvedValue({ sid: 'SM_TEST' }),
  templates: { leaseSignedConfirmation: jest.fn(() => 'signed confirmation') },
}));

// Stub boldsign so the PDF download doesn't hit the network
jest.mock('../src/api/boldsign', () => ({
  downloadSignedDocument: jest.fn().mockResolvedValue(Buffer.from('fake-pdf')),
}));
jest.mock('../src/api/index', () => ({
  getTenants:      jest.fn().mockResolvedValue([]),
  getProperties:   jest.fn().mockResolvedValue([]),
  getLeases:       jest.fn().mockResolvedValue([]),
  getCRMLeads:     jest.fn().mockResolvedValue([]),
  updateCRMLead:   jest.fn().mockResolvedValue({}),
  updateLease:     jest.fn().mockResolvedValue({}),
}));

beforeEach(() => {
  jest.clearAllMocks();
  axios.create.mockReturnValue(mockHttp);
});

const crypto     = require('crypto');
const supertest  = require('supertest');

let app;
beforeAll(() => {
  axios.create.mockReturnValue(mockHttp);
  const { createWebhookApp } = require('../src/webhook/server');
  app = createWebhookApp();
});

// ─── Health check ─────────────────────────────────────────────────────────────

describe('GET /webhooks/health', () => {
  test('responds 200 with { status: "ok" }', async () => {
    const res = await supertest(app).get('/webhooks/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.ts).toBeDefined();
  });
});

// ─── application-submitted ───────────────────────────────────────────────────
//
// tests/setup.js sets WEBHOOK_SECRET='test-webhook-secret' before module load,
// so config.webhook.secret is cached as 'test-webhook-secret' for all tests.
// We must sign every "expects 200" request with that value.

const SETUP_WEBHOOK_SECRET = 'test-webhook-secret';

function signBody(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('POST /webhooks/erpnext/application-submitted', () => {
  function validBody() {
    return {
      name: 'LEAD-0001',
      first_name: 'Alex',
      last_name: 'Kim',
      email_id: 'alex.kim@example.com',
      mobile_no: '+14155559999',
      custom_monthly_gross_income: 8000,
      custom_number_of_occupants: 2,
      custom_eviction_history: 'No',
    };
  }

  test('returns 200 { received: true } when signed with the configured secret', async () => {
    const body = JSON.stringify(validBody());
    const sig  = signBody(body, SETUP_WEBHOOK_SECRET);
    const res  = await supertest(app)
      .post('/webhooks/erpnext/application-submitted')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  test('returns 401 when signature header is missing', async () => {
    const res = await supertest(app)
      .post('/webhooks/erpnext/application-submitted')
      .send(validBody());
    expect(res.status).toBe(401);
  });

  test('returns 401 when signature header is wrong', async () => {
    const res = await supertest(app)
      .post('/webhooks/erpnext/application-submitted')
      .set('x-frappe-webhook-signature', 'badhex00000000000000000000000000000000000000000000000000000000000000')
      .send(validBody());
    expect(res.status).toBe(401);
  });

  test('accepts request with a valid HMAC-SHA256 x-frappe-webhook-signature', async () => {
    const body = JSON.stringify(validBody());
    const sig  = signBody(body, SETUP_WEBHOOK_SECRET);
    const res  = await supertest(app)
      .post('/webhooks/erpnext/application-submitted')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
  });
});

// ─── BoldSign completed webhook ───────────────────────────────────────────────

describe('POST /webhooks/boldsign/completed', () => {
  function boldSignPayload() {
    return {
      eventType: 'Completed',
      data: {
        documentId: 'BOLDDOC-001',
        signerDetails: [
          { signerRole: 'Tenant',   signerEmail: 'maria@example.com', signerName: 'Maria Garcia' },
          { signerRole: 'Landlord', signerEmail: 'landlord@example.com', signerName: 'Landlord' },
        ],
      },
    };
  }

  test('responds 200 immediately regardless of event type', async () => {
    const res = await supertest(app)
      .post('/webhooks/boldsign/completed')
      .send({ eventType: 'SomeOtherEvent', data: {} });
    expect(res.status).toBe(200);
  });

  test('returns 401 when BOLDSIGN_WEBHOOK_SECRET is set and header is malformed', async () => {
    process.env.BOLDSIGN_WEBHOOK_SECRET = 'bs-secret';
    const res = await supertest(app)
      .post('/webhooks/boldsign/completed')
      .set('x-boldsign-signature', 'malformed')
      .send(boldSignPayload());
    expect(res.status).toBe(401);
    delete process.env.BOLDSIGN_WEBHOOK_SECRET;
  });

  test('accepts when BOLDSIGN_WEBHOOK_SECRET is unset (no signature check)', async () => {
    delete process.env.BOLDSIGN_WEBHOOK_SECRET;
    const res = await supertest(app)
      .post('/webhooks/boldsign/completed')
      .send(boldSignPayload());
    expect(res.status).toBe(200);
  });

  test('accepts valid BoldSign HMAC signature', async () => {
    process.env.BOLDSIGN_WEBHOOK_SECRET = 'bs-secret';
    const rawBody   = JSON.stringify(boldSignPayload());
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signedPayload = `${timestamp}.${rawBody}`;
    const sig = crypto.createHmac('sha256', 'bs-secret').update(signedPayload).digest('hex');
    const sigHeader = `t=${timestamp}, s0=${sig}`;

    const res = await supertest(app)
      .post('/webhooks/boldsign/completed')
      .set('Content-Type', 'application/json')
      .set('x-boldsign-signature', sigHeader)
      .send(rawBody);
    expect(res.status).toBe(200);
    delete process.env.BOLDSIGN_WEBHOOK_SECRET;
  });
});

// ─── SmartMove completed webhook ─────────────────────────────────────────────

describe('POST /webhooks/smartmove/completed', () => {
  test('returns 200 immediately', async () => {
    const res = await supertest(app)
      .post('/webhooks/smartmove/completed')
      .send({
        applicant_email: 'alex@example.com',
        report_type: 'Standard',
        result: { credit_score_range: '650-700', criminal_records: 0, eviction_records: 0 },
      });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});

// ─── GET /payment-history ─────────────────────────────────────────────────────

describe('GET /payment-history', () => {
  test('returns 400 when email query param is missing', async () => {
    const res = await supertest(app).get('/payment-history');
    expect(res.status).toBe(400);
  });

  test('returns 400 when email has no @ sign', async () => {
    const res = await supertest(app).get('/payment-history?email=notanemail');
    expect(res.status).toBe(400);
  });

  test('returns 500 when STRIPE_SECRET_KEY is not set', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await supertest(app).get('/payment-history?email=test@example.com');
    expect(res.status).toBe(500);
  });

  test('returns 200 HTML when Stripe returns an empty customer list', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    // Stripe /v1/customers call → no customers found
    mockGet.mockResolvedValue({ data: { data: [] } });

    const res = await supertest(app).get('/payment-history?email=nobody@example.com');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Payment History');
    expect(res.text).toContain('No payment records found');
    delete process.env.STRIPE_SECRET_KEY;
  });

  test('renders a payment row for each succeeded PaymentIntent', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

    // Mock customers list
    mockGet
      .mockResolvedValueOnce({
        data: {
          data: [{ id: 'cus_test', name: 'Maria Garcia', email: 'maria@example.com' }],
        },
      })
      // Mock payment intents with one succeeded PI
      .mockResolvedValueOnce({
        data: {
          data: [{
            id: 'pi_001', status: 'succeeded', amount: 280000,
            created: Math.floor(Date.now() / 1000),
            description: 'Rent – SINV-0001',
            metadata: { method: 'us_bank_account', invoice: 'SINV-0001' },
            latest_charge: { receipt_url: 'https://receipt.stripe.com/r1',
                             payment_method_details: {} },
          }],
        },
      });

    const res = await supertest(app).get('/payment-history?email=maria@example.com');
    expect(res.status).toBe(200);
    expect(res.text).toContain('$2,800.00');
    expect(res.text).toContain('ACH Bank Transfer');
    expect(res.text).toContain('SINV-0001');
    delete process.env.STRIPE_SECRET_KEY;
  });
});

// ─── Stripe webhook signature validation (unit) ───────────────────────────────

describe('validateStripeSignature() (via Stripe webhook endpoint)', () => {
  function buildStripeHeader(rawBody, secret, tsOffset = 0) {
    const ts  = Math.floor(Date.now() / 1000) + tsOffset;
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    return `t=${ts},v1=${sig}`;
  }

  test('returns 400 when STRIPE_WEBHOOK_SECRET is set and header is wrong', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'wh-secret';
    const res = await supertest(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 'bad-sig')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(400);
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  test('accepts a valid Stripe HMAC signature', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'wh-secret';
    const body = JSON.stringify({ type: 'checkout.session.completed',
                                  data: { object: { payment_status: 'paid', metadata: {} } } });
    const header = buildStripeHeader(body, 'wh-secret');
    const res = await supertest(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', header)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  test('rejects a signature with a timestamp older than 5 minutes', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'wh-secret';
    const body   = '{"type":"ping"}';
    const header = buildStripeHeader(body, 'wh-secret', -400); // 400 s in the past
    const res = await supertest(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', header)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });
});

// ─── SMS templates (all variants) ────────────────────────────────────────────
// Use requireActual so we get the real templates, not the jest.mock stub above.

describe('SMS templates', () => {
  const sms = jest.requireActual('../src/sms/dispatcher');

  test('rentOverdue includes unit and amount', () => {
    const msg = sms.templates.rentOverdue({ unit: 'Unit 1A', propertyAddress: '', amountDue: 2800 });
    expect(msg).toContain('Unit 1A');
    expect(msg).toContain('2800');
  });

  test('rentReminder includes unit, amount, and due date', () => {
    const msg = sms.templates.rentReminder({ unit: 'Unit 1A', amountDue: 2800, dueDate: '2026-04-01' });
    expect(msg).toContain('2800');
    expect(msg).toContain('2026-04-01');
  });

  test('maintenanceScheduled includes description and unit', () => {
    const msg = sms.templates.maintenanceScheduled({ unit: 'Unit 1A', description: 'HVAC repair', scheduledDate: '' });
    expect(msg).toContain('HVAC repair');
    expect(msg).toContain('Unit 1A');
  });

  test('maintenanceComplete includes description', () => {
    const msg = sms.templates.maintenanceComplete({ unit: 'Unit 1A', description: 'Leaky faucet' });
    expect(msg).toContain('Leaky faucet');
    expect(msg).toMatch(/complete|resolved/i);
  });

  test('leaseRenewalNotice includes tenant name, unit, end date, and days left', () => {
    const msg = sms.templates.leaseRenewalNotice({ tenantName: 'Maria', unit: '512 Maple', endDate: 'July 1, 2026', daysLeft: 30 });
    expect(msg).toContain('Maria');
    expect(msg).toContain('512 Maple');
    expect(msg).toContain('30 days');
    expect(msg).toContain('July 1, 2026');
  });

  test('leaseSignedConfirmation includes unit and start date', () => {
    const msg = sms.templates.leaseSignedConfirmation({ unit: '512 Maple St', startDate: '2026-07-01' });
    expect(msg).toContain('512 Maple St');
    expect(msg).toContain('2026-07-01');
  });

  test('lateFeeCharged includes fee amount, unit, total due, and day number', () => {
    const msg = sms.templates.lateFeeCharged({ unit: 'Unit 1A', feeAmount: 50, totalDue: 2850, dayNumber: 7 });
    expect(msg).toContain('50.00');
    expect(msg).toContain('2850.00');
    expect(msg).toContain('day 7');
  });

  test('vendorWorkOrder includes ticket ID, subject, and unit address', () => {
    const msg = sms.templates.vendorWorkOrder({ ticketId: 'HDT-0001', subject: 'Broken heater', unitAddress: '512 Maple St', tenantName: 'Maria Garcia', tenantPhone: '+14155551001' });
    expect(msg).toContain('HDT-0001');
    expect(msg).toContain('Broken heater');
    expect(msg).toContain('512 Maple St');
    expect(msg).toContain('+14155551001');
  });
});

// ─── GET /api/properties-for-apply ───────────────────────────────────────────

describe('GET /api/properties-for-apply', () => {
  const apiMock = require('../src/api/index');

  test('returns empty array when no properties exist', async () => {
    apiMock.getProperties.mockResolvedValueOnce([]);
    apiMock.getLeases.mockResolvedValueOnce([]);
    const res = await supertest(app).get('/api/properties-for-apply');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('vacant property appears first with "Available Now" label', async () => {
    apiMock.getProperties.mockResolvedValueOnce([
      { name: 'PROP-001', name1: 'Unit A', status: 'Available', rent: 2500, bedroom: 1 },
      { name: 'PROP-002', name1: 'Unit B', status: 'On Lease',  rent: 3000, bedroom: 2 },
    ]);
    apiMock.getLeases.mockResolvedValueOnce([
      { property: 'PROP-002', end_date: '2027-01-31', lease_status: 'Active' },
    ]);
    const res = await supertest(app).get('/api/properties-for-apply');
    expect(res.status).toBe(200);
    expect(res.body[0].value).toBe('Unit A');
    expect(res.body[0].label).toContain('Available Now');
    expect(res.body[1].value).toBe('Unit B');
    expect(res.body[1].label).toContain('Available after');
    expect(res.body[1].label).toContain('Jan');
  });

  test('occupied properties sorted by lease end_date ascending', async () => {
    apiMock.getProperties.mockResolvedValueOnce([
      { name: 'PROP-A', name1: 'Unit A', status: 'On Lease', rent: 2000, bedroom: 1 },
      { name: 'PROP-B', name1: 'Unit B', status: 'On Lease', rent: 2500, bedroom: 2 },
    ]);
    apiMock.getLeases.mockResolvedValueOnce([
      { property: 'PROP-A', end_date: '2027-06-30', lease_status: 'Active' },
      { property: 'PROP-B', end_date: '2026-12-31', lease_status: 'Active' },
    ]);
    const res = await supertest(app).get('/api/properties-for-apply');
    expect(res.status).toBe(200);
    expect(res.body[0].value).toBe('Unit B'); // earlier end date → listed first
    expect(res.body[1].value).toBe('Unit A');
  });

  test('includes rent and bedroom count in label', async () => {
    apiMock.getProperties.mockResolvedValueOnce([
      { name: 'PROP-001', name1: 'Unit C', status: 'Available', rent: 3200, bedroom: 3 },
    ]);
    apiMock.getLeases.mockResolvedValueOnce([]);
    const res = await supertest(app).get('/api/properties-for-apply');
    expect(res.status).toBe(200);
    expect(res.body[0].label).toContain('3,200');
    expect(res.body[0].label).toContain('3br');
  });

  test('sets Access-Control-Allow-Origin: * header', async () => {
    apiMock.getProperties.mockResolvedValueOnce([]);
    apiMock.getLeases.mockResolvedValueOnce([]);
    const res = await supertest(app).get('/api/properties-for-apply');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
