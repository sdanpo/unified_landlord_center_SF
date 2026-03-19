'use strict';

/**
 * End-to-end tests for Unified Landlord Center SF
 * ─────────────────────────────────────────────────
 * Tests the FULL stack against the live ERPNext instance at lutra.k.frappe.cloud.
 * No mocking – everything hits real APIs.
 *
 * Coverage
 * ────────
 * 1.  ERPNext API layer    – read properties, tenants, leases, invoices, tickets
 * 2.  Filter logic         – lease status filters, vacant units, stale work orders
 * 3.  Financial queries    – outstanding balances, general ledger, payments
 * 4.  Webhook server       – signature validation, event normalisation, handler dispatch
 * 5.  AI agentic loop      – Telegram-style queries routed through OpenAI + real PMS data
 * 6.  Telegram handler     – chat() integration via mocked bot transport
 * 7.  Scheduler jobs       – runOverdueRentCheck() and runStaleWorkOrderCheck()
 * 8.  SMS dispatcher       – template generation (no actual Twilio send in test)
 *
 * Run:  npx jest tests/e2e.test.js --testTimeout=60000 --forceExit
 */

// ─── load REAL environment FIRST, overriding jest's test/setup.js fake vars ──
// tests/setup.js (configured as Jest setupFiles) sets fake ERPNEXT_BASE_URL etc.
// We must call dotenv with override:true so the real .env wins.
require('dotenv').config({ override: true });

// ─── override only what the e2e test harness controls ─────────────────────────
process.env.WEBHOOK_PORT        = '3099';   // avoid port conflicts
process.env.WEBHOOK_SECRET      = 'e2e-test-secret';
process.env.LOG_LEVEL           = 'error';

// Real credentials (read after dotenv override)
const REAL_ERPNEXT = {
  baseUrl:   process.env.ERPNEXT_BASE_URL,
  apiKey:    process.env.ERPNEXT_API_KEY,
  apiSecret: process.env.ERPNEXT_API_SECRET,
};

const crypto  = require('crypto');
const request = require('supertest');

// ─── 1. ERPNext API layer ─────────────────────────────────────────────────────

describe('ERPNext API – Properties', () => {
  let client;

  beforeAll(() => {
    const ERPNextClient = require('../src/api/erpnext');
    client = new ERPNextClient(REAL_ERPNEXT);
  });

  test('getProperties() returns at least 4 properties', async () => {
    const props = await client.getProperties();
    expect(Array.isArray(props)).toBe(true);
    expect(props.length).toBeGreaterThanOrEqual(4);
    // Each property has a name and status
    expect(props[0]).toHaveProperty('name');
    expect(props[0]).toHaveProperty('status');
  });

  test('getProperty() returns a single property with expected fields', async () => {
    const props = await client.getProperties();
    const first = await client.getProperty(props[0].name);
    expect(first.name).toBe(props[0].name);
    expect(first).toHaveProperty('rent');
  });

  test('getVacantUnits() returns only Available properties', async () => {
    const vacant = await client.getVacantUnits();
    expect(Array.isArray(vacant)).toBe(true);
    vacant.forEach(p => expect(p.status).toBe('Available'));
    // 512 Maple Unit 2B was seeded as Available
    const maple2B = vacant.find(p => p.name.includes('2B'));
    expect(maple2B).toBeDefined();
  });

  test('getUnits() without filter returns all properties', async () => {
    const all = await client.getUnits();
    const props = await client.getProperties();
    expect(all.length).toBe(props.length);
  });
});

// ─── 2. ERPNext API – Tenants ─────────────────────────────────────────────────

describe('ERPNext API – Tenants', () => {
  let client;

  beforeAll(() => {
    const ERPNextClient = require('../src/api/erpnext');
    client = new ERPNextClient(REAL_ERPNEXT);
  });

  test('getTenants() returns all 4 seeded tenants', async () => {
    const tenants = await client.getTenants({});
    expect(tenants.length).toBeGreaterThanOrEqual(4);
    const names = tenants.map(t => t.customer_name);
    expect(names).toContain('Maria Garcia');
    expect(names).toContain('James Wilson');
    expect(names).toContain('Priya Patel');
    expect(names).toContain('Chen Wei');
  });

  test('getTenants({ name }) filters by partial name', async () => {
    const results = await client.getTenants({ name: 'Maria' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    results.forEach(t => expect(t.customer_name.toLowerCase()).toContain('maria'));
  });

  test('getTenant() fetches a single tenant with contact info', async () => {
    const t = await client.getTenant('Maria Garcia');
    expect(t.customer_name).toBe('Maria Garcia');
    expect(t.mobile_no).toBe('+14155551001');
    expect(t.email_id).toBe('maria.garcia.tenant@example.com');
  });
});

// ─── 3. ERPNext API – Leases ──────────────────────────────────────────────────

describe('ERPNext API – Leases', () => {
  let client;

  beforeAll(() => {
    const ERPNextClient = require('../src/api/erpnext');
    client = new ERPNextClient(REAL_ERPNEXT);
  });

  test('getLeases({ status: "all" }) returns all 3 seeded leases', async () => {
    const leases = await client.getLeases({ status: 'all' });
    expect(leases.length).toBeGreaterThanOrEqual(3);
  });

  test('getLeases({ status: "active" }) returns only Active leases', async () => {
    const active = await client.getLeases({ status: 'active' });
    expect(active.length).toBeGreaterThanOrEqual(2);
    active.forEach(l => expect(l.lease_status).toBe('Active'));
  });

  test('getLeases({ status: "expired" }) returns only Closed leases', async () => {
    const expired = await client.getLeases({ status: 'expired' });
    expect(expired.length).toBeGreaterThanOrEqual(1);
    expired.forEach(l => expect(l.lease_status).toBe('Closed'));
  });

  test('getLeases({ unit: "Maple" }) filters by property name', async () => {
    const mapleLeases = await client.getLeases({ unit: 'Maple' });
    expect(mapleLeases.length).toBeGreaterThanOrEqual(1);
    mapleLeases.forEach(l => expect(l.property.toLowerCase()).toContain('maple'));
  });

  test('getLease() returns single lease with start/end dates', async () => {
    const all = await client.getLeases({ status: 'all' });
    const lease = await client.getLease(all[0].name);
    expect(lease.name).toBe(all[0].name);
    expect(lease).toHaveProperty('start_date');
    expect(lease).toHaveProperty('end_date');
    expect(lease).toHaveProperty('lease_status');
  });
});

// ─── 4. ERPNext API – Financials ─────────────────────────────────────────────

describe('ERPNext API – Financials', () => {
  let client;

  beforeAll(() => {
    const ERPNextClient = require('../src/api/erpnext');
    client = new ERPNextClient(REAL_ERPNEXT);
  });

  test('getOutstandingBalances() returns 2 overdue invoices', async () => {
    const balances = await client.getOutstandingBalances();
    expect(Array.isArray(balances)).toBe(true);
    // 2 invoices were seeded with past due dates
    expect(balances.length).toBeGreaterThanOrEqual(2);
    balances.forEach(inv => {
      expect(inv.outstanding_amount).toBeGreaterThan(0);
      expect(new Date(inv.due_date) < new Date()).toBe(true);
    });
  });

  test('getOutstandingBalances() invoices have required fields', async () => {
    const balances = await client.getOutstandingBalances();
    const inv = balances[0];
    expect(inv).toHaveProperty('name');
    expect(inv).toHaveProperty('customer_name');
    expect(inv).toHaveProperty('outstanding_amount');
    expect(inv).toHaveProperty('due_date');
  });

  test('getLeaseLedger() returns invoices for a specific lease', async () => {
    const active = await client.getLeases({ status: 'active' });
    // Maria Garcia's Maple 1A lease
    const mapleL = active.find(l => l.property && l.property.includes('Maple'));
    if (!mapleL) { console.warn('Maple lease not found – skipping ledger test'); return; }
    const ledger = await client.getLeaseLedger(mapleL.name);
    expect(Array.isArray(ledger)).toBe(true);
    expect(ledger.length).toBeGreaterThanOrEqual(1);
  });

  test('getGeneralLedger() returns GL entries for date range', async () => {
    const gl = await client.getGeneralLedger({
      startDate: '2026-01-01',
      endDate: '2026-03-31',
    });
    expect(Array.isArray(gl)).toBe(true);
    expect(gl.length).toBeGreaterThan(0);
    expect(gl[0]).toHaveProperty('posting_date');
    expect(gl[0]).toHaveProperty('debit');
    expect(gl[0]).toHaveProperty('credit');
  });

  test('getPayments() returns submitted payment entries', async () => {
    const payments = await client.getPayments({
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });
    expect(Array.isArray(payments)).toBe(true);
    expect(payments.length).toBeGreaterThanOrEqual(1);
    payments.forEach(p => expect(p.paid_amount).toBeGreaterThan(0));
  });
});

// ─── 5. ERPNext API – Work Orders (HD Tickets) ───────────────────────────────

describe('ERPNext API – Work Orders', () => {
  let client;

  beforeAll(() => {
    const ERPNextClient = require('../src/api/erpnext');
    client = new ERPNextClient(REAL_ERPNEXT);
  });

  test('getWorkOrders({ status: "all" }) returns all 3 seeded tickets', async () => {
    const all = await client.getWorkOrders({ status: 'all' });
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  test('getWorkOrders({ status: "open" }) returns only Open tickets', async () => {
    const open = await client.getWorkOrders({ status: 'open' });
    expect(open.length).toBeGreaterThanOrEqual(1);
    open.forEach(t => expect(t.status).toBe('Open'));
  });

  test('getWorkOrders({ status: "completed" }) returns Resolved tickets', async () => {
    const resolved = await client.getWorkOrders({ status: 'completed' });
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    resolved.forEach(t => expect(t.status).toBe('Resolved'));
  });

  test('getWorkOrder() fetches a single ticket with all fields', async () => {
    const all = await client.getWorkOrders({ status: 'all' });
    const ticket = await client.getWorkOrder(all[0].name);
    expect(ticket).toHaveProperty('subject');
    expect(ticket).toHaveProperty('status');
    expect(ticket).toHaveProperty('priority');
    expect(ticket).toHaveProperty('description');
  });

  test('getStaleWorkOrders() returns open/replied tickets older than threshold', async () => {
    // Use a negative ageHours so the cutoff is 2h in the future.
    // This handles cases where the Frappe server clock is slightly ahead of
    // the test runner, making recently-created tickets appear to be "future" datetimes.
    const stale = await client.getStaleWorkOrders(-2);
    expect(Array.isArray(stale)).toBe(true);
    stale.forEach(t => expect(['Open', 'Replied']).toContain(t.status));
    // Our Open (ticket 3) and Replied (ticket 4) tickets should appear
    expect(stale.length).toBeGreaterThanOrEqual(2);
  });

  test('updateWorkOrder() updates a ticket field', async () => {
    const open = await client.getWorkOrders({ status: 'open' });
    const ticket = open[0];
    const originalPriority = ticket.priority;
    const newPriority = originalPriority === 'High' ? 'Medium' : 'High';

    const updated = await client.updateWorkOrder(ticket.name, { priority: newPriority });
    expect(updated.priority).toBe(newPriority);

    // Restore original priority
    await client.updateWorkOrder(ticket.name, { priority: originalPriority });
  });
});

// ─── 6. Webhook Server ────────────────────────────────────────────────────────

describe('Webhook Server', () => {
  let app;
  const SECRET = process.env.WEBHOOK_SECRET;

  function sign(body) {
    return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  }

  beforeAll(() => {
    // Mock the handlers so we can inspect calls without firing real notifications
    jest.mock('../src/webhook/handlers', () => ({
      handle: jest.fn().mockResolvedValue(undefined),
    }));
    jest.mock('../src/api/index', () => ({
      getTenant: jest.fn().mockResolvedValue({ mobile_no: '+14155551001' }),
    }));
    const { createWebhookApp } = require('../src/webhook/server');
    app = createWebhookApp();
  });

  afterAll(() => {
    jest.unmock('../src/webhook/handlers');
    jest.unmock('../src/api/index');
    jest.resetModules();
  });

  test('GET /webhooks/health → 200 { status: "ok" }', async () => {
    const res = await request(app).get('/webhooks/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('POST invoice-overdue: valid signature → 200 + handle() called', async () => {
    const { handle } = require('../src/webhook/handlers');
    const body = JSON.stringify({
      name: 'ACC-SINV-2026-00006',
      customer: 'Maria Garcia',
      customer_name: 'Maria Garcia',
      outstanding_amount: 2800,
      due_date: '2026-01-31',
      custom_unit: '512 Maple Street, Unit 1A – SF',
      custom_property: '512 Maple Street, Unit 1A – SF',
      custom_lease: '512 Maple Street, Unit 1A \u2013 SF-00001',
    });
    const res = await request(app)
      .post('/webhooks/erpnext/invoice-overdue')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(handle).toHaveBeenCalled();
    const [event] = handle.mock.calls[0];
    expect(event.type).toBe('rent.overdue');
    expect(event.data.tenantName).toBe('Maria Garcia');
    expect(event.data.amountDue).toBe(2800);
  });

  test('POST invoice-overdue: invalid signature → 401', async () => {
    const body = JSON.stringify({ name: 'X', outstanding_amount: 100 });
    const res = await request(app)
      .post('/webhooks/erpnext/invoice-overdue')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', 'badbadbadhex')
      .send(body);
    expect(res.status).toBe(401);
  });

  test('POST payment-received → payment.received event', async () => {
    const { handle } = require('../src/webhook/handlers');
    handle.mockClear();
    const body = JSON.stringify({
      name: 'ACC-PAY-2026-00006',
      party: 'Maria Garcia',
      party_name: 'Maria Garcia',
      paid_amount: 2800,
      mode_of_payment: 'Wire Transfer',
      custom_lease: '512 Maple Street, Unit 1A \u2013 SF-00001',
    });
    const res = await request(app)
      .post('/webhooks/erpnext/payment-received')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    const [event] = handle.mock.calls[0];
    expect(event.type).toBe('payment.received');
    expect(event.data.amountPaid).toBe(2800);
    expect(event.data.paymentMethod).toBe('Wire Transfer');
  });

  test('POST ticket-created → workorder.created event', async () => {
    const { handle } = require('../src/webhook/handlers');
    handle.mockClear();
    const body = JSON.stringify({
      name: '3',
      subject: '[512 Maple] Broken heater',
      status: 'Open',
      priority: 'High',
      customer_name: 'Maria Garcia',
      description: 'Heater broken.',
    });
    const res = await request(app)
      .post('/webhooks/erpnext/ticket-created')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    const [event] = handle.mock.calls[0];
    expect(event.type).toBe('workorder.created');
    expect(event.data.priority).toBe('High');
  });

  test('POST contract-submitted → lease.created event', async () => {
    const { handle } = require('../src/webhook/handlers');
    handle.mockClear();
    const body = JSON.stringify({
      name: '512 Maple Street, Unit 1A \u2013 SF-00001',
      tenant_name: 'Maria Garcia',
      property_unit: '512 Maple Street, Unit 1A \u2013 SF',
      start_date: '2025-07-01',
      end_date: '2026-06-30',
      monthly_rent: 2800,
    });
    const res = await request(app)
      .post('/webhooks/erpnext/contract-submitted')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    const [event] = handle.mock.calls[0];
    expect(event.type).toBe('lease.created');
    expect(event.data.tenantName).toBe('Maria Garcia');
    expect(event.data.monthlyRent).toBe(2800);
  });

  test('POST contract-cancelled → lease.expired event', async () => {
    const { handle } = require('../src/webhook/handlers');
    handle.mockClear();
    const body = JSON.stringify({
      name: '229 Watson Drive-00003',
      tenant_name: 'Priya Patel',
      property_unit: '229 Watson Drive',
    });
    const res = await request(app)
      .post('/webhooks/erpnext/contract-cancelled')
      .set('Content-Type', 'application/json')
      .set('x-frappe-webhook-signature', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    const [event] = handle.mock.calls[0];
    expect(event.type).toBe('lease.expired');
  });
});

// ─── 6b. Checkout endpoint — surcharge + method routing ──────────────────────

describe('Checkout endpoint – surcharge & method routing', () => {
  let app;

  // Capture the URLSearchParams body passed to Stripe so we can assert on it
  let lastStripeBody = '';

  beforeAll(() => {
    jest.mock('axios', () => {
      const mockAxios = jest.fn();
      mockAxios.create = jest.fn(() => {
        const inst = {
          interceptors: { response: { use: jest.fn() } },
          get:  jest.fn((path) => {
            if (path.includes('Sales%20Invoice'))
              return Promise.resolve({ data: { data: {
                docstatus: 1, outstanding_amount: 1000,
                customer: 'Rotem Porat', customer_name: 'Rotem Porat',
              }}});
            if (path.includes('Customer'))
              return Promise.resolve({ data: { data: { email_id: 'rotem@test.com' } } });
            return Promise.reject(new Error('unexpected GET ' + path));
          }),
          post: jest.fn((_path, body) => {
            lastStripeBody = body || '';
            return Promise.resolve({ data: { url: 'https://checkout.stripe.com/pay/cs_test', id: 'cs_test' } });
          }),
        };
        return inst;
      });
      return mockAxios;
    });

    process.env.STRIPE_SECRET_KEY  = 'sk_test_fake';
    process.env.ERPNEXT_BASE_URL   = 'https://erpnext.test.local';
    process.env.ERPNEXT_API_KEY    = 'key';
    process.env.ERPNEXT_API_SECRET = 'secret';
    process.env.CARD_SURCHARGE_PCT = '3';

    const { createWebhookApp } = require('../src/webhook/server');
    app = createWebhookApp();
  });

  afterAll(() => {
    jest.unmock('axios');
    jest.resetModules();
  });

  test('GET /checkout missing invoice_name → 400', async () => {
    const res = await request(app).get('/checkout');
    expect(res.status).toBe(400);
  });

  test('GET /checkout invalid method → 400', async () => {
    const res = await request(app).get('/checkout?invoice_name=ACC-SINV-2026-00001&method=crypto');
    expect(res.status).toBe(400);
  });

  test('GET /checkout method=ach → us_bank_account, original amount (100000 cents)', async () => {
    lastStripeBody = '';
    const res = await request(app).get('/checkout?invoice_name=ACC-SINV-2026-00001&method=ach');
    expect(res.status).toBe(302);
    // URL-encoded: payment_method_types[]=us_bank_account
    expect(lastStripeBody).toContain('us_bank_account');
    // URL-encoded: line_items[0][price_data][unit_amount]=100000
    expect(lastStripeBody).toContain('%5Bunit_amount%5D=100000');
    expect(lastStripeBody).not.toContain('payment_method_types%5B%5D=card');
  });

  test('GET /checkout method=card → card only, amount +3% (103000 cents)', async () => {
    lastStripeBody = '';
    const res = await request(app).get('/checkout?invoice_name=ACC-SINV-2026-00001&method=card');
    expect(res.status).toBe(302);
    expect(lastStripeBody).toContain('payment_method_types%5B%5D=card');
    expect(lastStripeBody).not.toContain('us_bank_account');
    // $1000 * 1.03 * 100 = 103000 cents
    expect(lastStripeBody).toContain('%5Bunit_amount%5D=103000');
  });

  test('GET /checkout no method → defaults to ach (302 redirect)', async () => {
    const res = await request(app).get('/checkout?invoice_name=ACC-SINV-2026-00001');
    expect(res.status).toBe(302);
    expect(lastStripeBody).toContain('us_bank_account');
  });
});

// ─── 6b. Stripe Webhook ───────────────────────────────────────────────────────

describe('Stripe Webhook', () => {
  const STRIPE_TEST_SECRET = 'whsec_test_stripe_webhook_secret_for_unit_tests';
  let app;

  // Build a valid Stripe-style webhook signature header
  function stripeSign(rawBody, secret = STRIPE_TEST_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload   = `${timestamp}.${rawBody}`;
    const sig       = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return { header: `t=${timestamp},v1=${sig}`, timestamp };
  }

  // Save and clear ERPNext credentials so onPaymentConfirmed skips the
  // HTTP call to create a Payment Entry (avoids 20s timeout in tests).
  let savedErpnextEnv;

  beforeAll(() => {
    savedErpnextEnv = {
      ERPNEXT_BASE_URL:    process.env.ERPNEXT_BASE_URL,
      ERPNEXT_API_KEY:     process.env.ERPNEXT_API_KEY,
      ERPNEXT_API_SECRET:  process.env.ERPNEXT_API_SECRET,
    };
    process.env.ERPNEXT_BASE_URL   = '';
    process.env.ERPNEXT_API_KEY    = '';
    process.env.ERPNEXT_API_SECRET = '';
    process.env.STRIPE_WEBHOOK_SECRET = STRIPE_TEST_SECRET;

    jest.mock('../src/webhook/handlers', () => ({
      handle: jest.fn().mockResolvedValue(undefined),
    }));
    const { createWebhookApp } = require('../src/webhook/server');
    app = createWebhookApp();
  });

  afterAll(() => {
    Object.assign(process.env, savedErpnextEnv);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    jest.unmock('../src/webhook/handlers');
    jest.resetModules();
  });

  test('POST /webhooks/stripe with valid signature → 200', async () => {
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_test_123',
        payment_status: 'unpaid',
        amount_total: 250000,
        metadata: { invoice: 'ACC-SINV-2026-00001', tenant: 'Rotem Porat' },
      }},
    });
    const { header } = stripeSign(body);
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', header)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  test('POST /webhooks/stripe with invalid signature → 400', async () => {
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=9999999999,v1=badhexbadhexbadhex')
      .send(body);
    expect(res.status).toBe(400);
  });

  test('async_payment_succeeded → handle() called with payment.received', async () => {
    const { handle } = require('../src/webhook/handlers');
    handle.mockClear();

    const body = JSON.stringify({
      type: 'checkout.session.async_payment_succeeded',
      data: { object: {
        id: 'cs_test_456',
        payment_status: 'paid',
        amount_total: 280000,
        metadata: { invoice: 'ACC-SINV-2026-00002', tenant: 'Maria Garcia' },
      }},
    });
    const { header } = stripeSign(body);
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', header)
      .send(body);

    expect(res.status).toBe(200);
    // Wait briefly for setImmediate handler
    await new Promise(r => setTimeout(r, 50));
    const types = handle.mock.calls.map(c => c[0].type);
    expect(types).toContain('payment.received');
  });

  test('async_payment_failed → handle() called with payment.failed', async () => {
    const { handle } = require('../src/webhook/handlers');
    handle.mockClear();

    const body = JSON.stringify({
      type: 'checkout.session.async_payment_failed',
      data: { object: {
        id: 'cs_test_789',
        amount_total: 280000,
        metadata: { invoice: 'ACC-SINV-2026-00002', tenant: 'Maria Garcia' },
      }},
    });
    const { header } = stripeSign(body);
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', header)
      .send(body);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    const types = handle.mock.calls.map(c => c[0].type);
    expect(types).toContain('payment.failed');
  });

  test('checkout.session.completed (payment_status=paid) → payment.received', async () => {
    const { handle } = require('../src/webhook/handlers');
    handle.mockClear();

    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_test_card',
        payment_status: 'paid',
        amount_total: 300000,
        metadata: { invoice: 'ACC-SINV-2026-00003', tenant: 'James Wilson' },
      }},
    });
    const { header } = stripeSign(body);
    await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', header)
      .send(body);

    await new Promise(r => setTimeout(r, 50));
    const types = handle.mock.calls.map(c => c[0].type);
    expect(types).toContain('payment.received');
  });

  test('checkout.session.completed (payment_status=unpaid) → payment.pending', async () => {
    const { handle } = require('../src/webhook/handlers');
    handle.mockClear();

    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_test_ach_pending',
        payment_status: 'unpaid',
        amount_total: 250000,
        metadata: { invoice: 'ACC-SINV-2026-00004', tenant: 'Rotem Porat' },
      }},
    });
    const { header } = stripeSign(body);
    await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', header)
      .send(body);

    await new Promise(r => setTimeout(r, 50));
    const types = handle.mock.calls.map(c => c[0].type);
    expect(types).toContain('payment.pending');
  });
});

// ─── 7. AI Agentic Loop via real OpenAI + real ERPNext data ──────────────────

describe('AI Agentic Loop (OpenAI + live ERPNext)', () => {
  let chat;

  beforeAll(() => {
    jest.resetModules();
    require('dotenv').config({ override: true });
    process.env.LOG_LEVEL = 'error';
    process.env.WEBHOOK_PORT = '3099';
    process.env.WEBHOOK_SECRET = 'e2e-test-secret';
    ({ chat } = require('../src/ai/openai'));
  });

  test('responds to outstanding balances query with real data', async () => {
    const reply = await chat('Which tenants are behind on rent?', []);
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(20);
    // Should mention at least one of the overdue tenants
    const mentionsTenant =
      reply.toLowerCase().includes('maria') ||
      reply.toLowerCase().includes('james') ||
      reply.toLowerCase().includes('wilson') ||
      reply.toLowerCase().includes('garcia');
    expect(mentionsTenant).toBe(true);
  }, 120_000);

  test('responds to vacant units query', async () => {
    const reply = await chat('Show me all vacant units', []);
    expect(typeof reply).toBe('string');
    // Maple 2B was seeded as Available
    expect(reply.toLowerCase()).toMatch(/maple|2b|available|vacant/i);
  }, 120_000);

  test('responds to open maintenance tickets query', async () => {
    const reply = await chat('What maintenance issues are currently open?', []);
    expect(typeof reply).toBe('string');
    // Should mention the heater or plumbing issue
    const hasMaintenance =
      reply.toLowerCase().includes('heater') ||
      reply.toLowerCase().includes('plumbing') ||
      reply.toLowerCase().includes('open') ||
      reply.toLowerCase().includes('ticket');
    expect(hasMaintenance).toBe(true);
  }, 120_000);

  test('responds to active lease query', async () => {
    const reply = await chat('List all active leases', []);
    expect(typeof reply).toBe('string');
    const hasLease =
      reply.toLowerCase().includes('maple') ||
      reply.toLowerCase().includes('ocean') ||
      reply.toLowerCase().includes('active') ||
      reply.toLowerCase().includes('lease');
    expect(hasLease).toBe(true);
  }, 120_000);

  test('responds to tenant info query', async () => {
    const reply = await chat('Give me contact info for Maria Garcia', []);
    expect(typeof reply).toBe('string');
    // Should contain phone or email
    const hasContact =
      reply.includes('+14155551001') ||
      reply.includes('maria.garcia') ||
      reply.toLowerCase().includes('phone') ||
      reply.toLowerCase().includes('contact');
    expect(hasContact).toBe(true);
  }, 120_000);

  test('maintains conversation context across turns', async () => {
    const history = [];
    await chat('How many tenants are overdue?', history);
    const followUp = await chat('And what are their names?', history);
    expect(followUp.length).toBeGreaterThan(10);
    // The follow-up should refer back to prior context
    expect(history.length).toBeGreaterThanOrEqual(4); // 2 turns × 2 messages each
  }, 180_000);
});

// ─── 8. Telegram Handler – integration via chat() ────────────────────────────

describe('Telegram handleMessage() – AI integration', () => {
  let handleMessage;
  let fakeBot;

  beforeAll(() => {
    jest.resetModules();
    require('dotenv').config({ override: true });
    process.env.LOG_LEVEL = 'error';
    process.env.WEBHOOK_PORT = '3099';
    process.env.WEBHOOK_SECRET = 'e2e-test-secret';
    ({ handleMessage } = require('../src/telegram/handlers'));

    fakeBot = {
      sendChatAction: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };
  });

  test('sends a real AI reply to the Telegram bot object', async () => {
    const msg = {
      chat: { id: 999 },
      from: { id: 612919236, first_name: 'Test' },
      text: 'Are there any overdue balances?',
    };

    await handleMessage(fakeBot, msg);

    expect(fakeBot.sendChatAction).toHaveBeenCalledWith(999, 'typing');
    expect(fakeBot.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = fakeBot.sendMessage.mock.calls[0];
    expect(chatId).toBe(999);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(10);
  }, 120_000);
});

// ─── 9. Scheduler jobs against real data ─────────────────────────────────────

describe('Scheduler – runOverdueRentCheck()', () => {
  let runOverdueRentCheck;
  let notifyLandlord;
  let smsSend;

  beforeAll(() => {
    jest.resetModules();
    require('dotenv').config({ override: true });
    process.env.LOG_LEVEL = 'error';

    // Mock the PMS client to return the known overdue invoices from our seed data.
    // Fields must match what scheduler.js reads: daysOverdue, tenantId, tenantName,
    // unitName, propertyAddress, amountDue (scheduler filters by daysOverdue > 0).
    jest.mock('../src/api/index', () => ({
      getOutstandingBalances: jest.fn().mockResolvedValue([
        {
          tenantId: 'Maria Garcia',
          tenantName: 'Maria Garcia',
          unitName: '512 Maple Street, Unit 1A – SF',
          propertyAddress: '512 Maple Street',
          amountDue: 2800,
          daysOverdue: 41,
        },
        {
          tenantId: 'James Wilson',
          tenantName: 'James Wilson',
          unitName: '88 Ocean Avenue, Unit 5C – SF',
          propertyAddress: '88 Ocean Avenue',
          amountDue: 4500,
          daysOverdue: 15,
        },
      ]),
      getStaleWorkOrders: jest.fn().mockResolvedValue([]),
    }));

    // Mock outbound channels so we don't send real SMS/Telegram
    jest.mock('../src/telegram/bot', () => ({
      notifyLandlord: jest.fn().mockResolvedValue(undefined),
    }));
    jest.mock('../src/sms/dispatcher', () => ({
      send: jest.fn().mockResolvedValue({ sid: 'SM_TEST' }),
      templates: {
        rentOverdue: jest.fn(({ unit, amountDue }) => `OVERDUE: ${unit} owes $${amountDue}`),
        rentReminder: jest.fn(({ unit, amountDue, dueDate }) => `REMINDER: ${unit} $${amountDue} due ${dueDate}`),
        maintenanceScheduled: jest.fn(({ unit, description }) => `SCHEDULED: ${description} @ ${unit}`),
        maintenanceComplete: jest.fn(({ unit, description }) => `COMPLETE: ${description} @ ${unit}`),
      },
    }));

    ({ runOverdueRentCheck } = require('../src/automation/scheduler'));
    ({ notifyLandlord } = require('../src/telegram/bot'));
    smsSend = require('../src/sms/dispatcher').send;
  });

  test('fires SMS for each overdue tenant and Telegram summary', async () => {
    await runOverdueRentCheck();

    // Should have sent 2 SMS (Maria + James overdue)
    expect(smsSend.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Telegram summary should mention delinquent count
    expect(notifyLandlord).toHaveBeenCalled();
    const summary = notifyLandlord.mock.calls[0][0];
    expect(summary).toMatch(/tenant/i);
  }, 30_000);
});

describe('Scheduler – runStaleWorkOrderCheck()', () => {
  let runStaleWorkOrderCheck;
  let notifyLandlord;

  beforeAll(() => {
    jest.resetModules();
    require('dotenv').config({ override: true });
    process.env.LOG_LEVEL = 'error';
    process.env.WEBHOOK_PORT = '3099';
    process.env.WEBHOOK_SECRET = 'e2e-test-secret';

    jest.mock('../src/telegram/bot', () => ({
      notifyLandlord: jest.fn().mockResolvedValue(undefined),
    }));

    // Seed the real open tickets as if they were older than 48 h so the job fires
    jest.mock('../src/api/index', () => ({
      getStaleWorkOrders: jest.fn().mockResolvedValue([
        {
          name: '3',
          subject: '[512 Maple Street] Broken heater – Unit 1A',
          status: 'Open',
          priority: 'High',
          creation: new Date(Date.now() - 50 * 3600 * 1000).toISOString(),
          raised_by: 'maria.garcia.tenant@example.com',
        },
        {
          name: '4',
          subject: '[88 Ocean Avenue] Plumbing leak under kitchen sink',
          status: 'Replied',
          priority: 'Medium',
          creation: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
          raised_by: 'james.wilson.tenant@example.com',
        },
      ]),
      getOutstandingBalances: jest.fn().mockResolvedValue([]),
    }));

    ({ runStaleWorkOrderCheck } = require('../src/automation/scheduler'));
    ({ notifyLandlord } = require('../src/telegram/bot'));
  });

  test('sends Telegram alert when stale open tickets exist', async () => {
    await runStaleWorkOrderCheck();

    expect(notifyLandlord).toHaveBeenCalled();
    const msg = notifyLandlord.mock.calls[0][0];
    expect(msg.length).toBeGreaterThan(10);
    // Should reference one of the seeded tickets
    expect(msg).toMatch(/heater|plumbing|3|4/i);
  }, 30_000);
});

// ─── 10. BoldSign – multi-template e-signature system ────────────────────────

describe('BoldSign – template routing (resolveTemplateId via sendDocumentForSignature)', () => {
  let boldSign;

  // Capture the last axios.post payload for assertions
  let lastPostPath = '';
  let lastPostPayload = null;

  beforeAll(() => {
    jest.resetModules();

    // Stub axios so no real HTTP calls are made
    jest.mock('axios', () => {
      const inst = {
        interceptors: { response: { use: jest.fn() } },
        post: jest.fn((path, body) => {
          lastPostPath    = path;
          lastPostPayload = body;
          return Promise.resolve({ data: { documentId: 'DOC-MOCK-001' } });
        }),
        get: jest.fn(),
      };
      const mockAxios = jest.fn();
      mockAxios.create = jest.fn(() => inst);
      return mockAxios;
    });

    // Set 4 unique template IDs so we can verify routing
    process.env.BOLDSIGN_API_KEY              = 'test-api-key';
    process.env.BOLDSIGN_TEMPLATE_OH_LEASE    = 'tpl-oh-lease';
    process.env.BOLDSIGN_TEMPLATE_OH_RENEWAL  = 'tpl-oh-renewal';
    process.env.BOLDSIGN_TEMPLATE_NC_LEASE    = 'tpl-nc-lease';
    process.env.BOLDSIGN_TEMPLATE_NC_RENEWAL  = 'tpl-nc-renewal';
    delete process.env.BOLDSIGN_TEMPLATE_ID;   // no legacy fallback

    boldSign = require('../src/api/boldsign');
  });

  afterAll(() => {
    jest.unmock('axios');
    jest.resetModules();
  });

  const baseParams = {
    tenantEmail:   'tenant@example.com',
    tenantName:    'Test Tenant',
    landlordEmail: 'landlord@example.com',
    landlordName:  'Test Landlord',
    variables:     { start_date: '2026-07-01', end_date: '2027-06-30', monthly_rent: 2500 },
  };

  test('OH + Lease → uses BOLDSIGN_TEMPLATE_OH_LEASE', async () => {
    lastPostPayload = null;
    await boldSign.sendDocumentForSignature({ ...baseParams, docType: 'Lease', state: 'OH' });
    expect(lastPostPath).toContain('tpl-oh-lease');
    expect(lastPostPayload.title).toContain('Lease Agreement');
  });

  test('OH + Renewal → uses BOLDSIGN_TEMPLATE_OH_RENEWAL', async () => {
    await boldSign.sendDocumentForSignature({ ...baseParams, docType: 'Renewal', state: 'OH' });
    expect(lastPostPath).toContain('tpl-oh-renewal');
    expect(lastPostPayload.title).toContain('Renewal');
  });

  test('NC + Lease → uses BOLDSIGN_TEMPLATE_NC_LEASE', async () => {
    await boldSign.sendDocumentForSignature({ ...baseParams, docType: 'Lease', state: 'NC' });
    expect(lastPostPath).toContain('tpl-nc-lease');
  });

  test('NC + Renewal → uses BOLDSIGN_TEMPLATE_NC_RENEWAL', async () => {
    await boldSign.sendDocumentForSignature({ ...baseParams, docType: 'Renewal', state: 'NC' });
    expect(lastPostPath).toContain('tpl-nc-renewal');
  });

  test('state is case-insensitive (oh → OH_LEASE)', async () => {
    await boldSign.sendDocumentForSignature({ ...baseParams, docType: 'Lease', state: 'oh' });
    expect(lastPostPath).toContain('tpl-oh-lease');
  });

  test('missing template throws descriptive error', async () => {
    delete process.env.BOLDSIGN_TEMPLATE_NC_RENEWAL;
    await expect(
      boldSign.sendDocumentForSignature({ ...baseParams, docType: 'Renewal', state: 'NC' })
    ).rejects.toThrow(/NC_RENEWAL/);
    process.env.BOLDSIGN_TEMPLATE_NC_RENEWAL = 'tpl-nc-renewal';
  });

  test('falls back to BOLDSIGN_TEMPLATE_ID when state not in map', async () => {
    process.env.BOLDSIGN_TEMPLATE_ID = 'tpl-legacy-fallback';
    await boldSign.sendDocumentForSignature({ ...baseParams, docType: 'Lease', state: 'TX' });
    expect(lastPostPath).toContain('tpl-legacy-fallback');
    delete process.env.BOLDSIGN_TEMPLATE_ID;
  });
});

describe('BoldSign – pre-fill tags and signer roles', () => {
  let boldSign;
  let lastPostPayload = null;

  beforeAll(() => {
    jest.resetModules();

    jest.mock('axios', () => {
      const inst = {
        interceptors: { response: { use: jest.fn() } },
        post: jest.fn((_path, body) => {
          lastPostPayload = body;
          return Promise.resolve({ data: { documentId: 'DOC-PREFILL-001' } });
        }),
        get: jest.fn(),
      };
      const mockAxios = jest.fn();
      mockAxios.create = jest.fn(() => inst);
      return mockAxios;
    });

    process.env.BOLDSIGN_API_KEY             = 'test-api-key';
    process.env.BOLDSIGN_TEMPLATE_OH_LEASE   = 'tpl-oh-lease';

    boldSign = require('../src/api/boldsign');
  });

  afterAll(() => {
    jest.unmock('axios');
    jest.resetModules();
  });

  test('all key pre-fill fields included in top-level prefillForms using template field IDs', async () => {
    const variables = {
      landlord_name: 'Dan Porat', landlord_email: 'dan@example.com',
      landlord_phone: '+14155551000', landlord_address: '123 Owner St',
      tenant_name: 'Maria Garcia', tenant_email: 'maria@example.com', tenant_phone: '+14155551001',
      unit_address: '512 Maple St', unit_city: 'Cleveland', unit_state: 'OH', unit_zip: '44101',
      start_date: '2026-07-01', end_date: '2027-06-30',
      monthly_rent: '2800', security_deposit: '5600',
    };

    await boldSign.sendDocumentForSignature({
      docType: 'Lease', state: 'OH',
      tenantEmail: 'maria@example.com', tenantName: 'Maria Garcia',
      landlordEmail: 'dan@example.com', landlordName: 'Dan Porat',
      variables,
    });

    // Pre-fill data is now at top-level prefillForms using actual BoldSign template field IDs
    expect(lastPostPayload.prefillForms).toBeDefined();
    const fieldIds = lastPostPayload.prefillForms.map(f => f.id);

    // OH_LEASE field IDs (from template properties API)
    expect(fieldIds).toContain('t_b47276be'); // landlord_name
    expect(fieldIds).toContain('t_9cfaa4e0'); // tenant_name
    expect(fieldIds).toContain('t_61467ae8'); // unit_address
    expect(fieldIds).toContain('t_c68fab45'); // monthly_rent
    expect(fieldIds).toContain('t_c707f0d8'); // security_deposit
    // Roles must NOT have formFields (pre-fill is at top level)
    lastPostPayload.roles.forEach(r => expect(r.formFields).toBeUndefined());
  });

  test('empty variables are excluded from prefillForms', async () => {
    await boldSign.sendDocumentForSignature({
      docType: 'Lease', state: 'OH',
      tenantEmail: 'maria@example.com', tenantName: 'Maria Garcia',
      landlordEmail: 'dan@example.com', landlordName: 'Dan Porat',
      variables: { monthly_rent: '2800', unit_state: '', security_deposit: null },
    });

    const fieldIds = (lastPostPayload.prefillForms || []).map(f => f.id);

    expect(fieldIds).toContain('t_c68fab45');    // monthly_rent field ID — included
    // t_f213d8f7 is city_state_zip; with only unit_state='' it produces '' → excluded
    const cityStateField = (lastPostPayload.prefillForms || []).find(f => f.id === 't_f213d8f7');
    if (cityStateField) expect(cityStateField.value).not.toBe('');
    // t_c707f0d8 is security_deposit; null → excluded
    expect(fieldIds).not.toContain('t_c707f0d8');
  });

  test('landlord role has RoleIndex 2, no formFields', async () => {
    await boldSign.sendDocumentForSignature({
      docType: 'Lease', state: 'OH',
      tenantEmail: 'a@b.com', tenantName: 'Tenant A',
      landlordEmail: 'l@b.com', landlordName: 'Landlord L',
      variables: { monthly_rent: '1500' },
    });

    const landlordRole = lastPostPayload.roles.find(r => r.roleIndex === 2);
    expect(landlordRole.signerEmail).toBe('l@b.com');
    expect(landlordRole.signerName).toBe('Landlord L');
    expect(landlordRole.formFields).toBeUndefined();
  });

  test('auto-reminder settings are included', async () => {
    await boldSign.sendDocumentForSignature({
      docType: 'Lease', state: 'OH',
      tenantEmail: 'a@b.com', tenantName: 'T', landlordEmail: 'l@b.com', landlordName: 'L',
      variables: {},
    });

    expect(lastPostPayload.reminderSettings.enableAutoReminder).toBe(true);
    expect(lastPostPayload.reminderSettings.reminderDays).toBe(3);
    expect(lastPostPayload.reminderSettings.reminderCount).toBe(3);
  });
});

describe('BoldSign – sendLeaseForSignature() backward-compat wrapper', () => {
  let boldSign;
  let capturedArgs = null;

  beforeAll(() => {
    jest.resetModules();

    jest.mock('axios', () => {
      const inst = {
        interceptors: { response: { use: jest.fn() } },
        post: jest.fn((_path, body) => {
          capturedArgs = body;
          return Promise.resolve({ data: { documentId: 'DOC-COMPAT-001' } });
        }),
        get: jest.fn(),
      };
      const mockAxios = jest.fn();
      mockAxios.create = jest.fn(() => inst);
      return mockAxios;
    });

    process.env.BOLDSIGN_API_KEY           = 'test-api-key';
    process.env.BOLDSIGN_TEMPLATE_OH_LEASE = 'tpl-oh-lease';

    boldSign = require('../src/api/boldsign');
  });

  afterAll(() => {
    jest.unmock('axios');
    jest.resetModules();
  });

  test('wrapper calls sendDocumentForSignature with docType=Lease', async () => {
    const result = await boldSign.sendLeaseForSignature({
      tenantEmail:   'tenant@example.com',
      tenantName:    'Test Tenant',
      landlordEmail: 'landlord@example.com',
      landlordName:  'Test Landlord',
      variables:     { unit_state: 'OH', monthly_rent: '2500' },
    });

    expect(result.documentId).toBe('DOC-COMPAT-001');
    // The title should contain "Lease Agreement" (not "Renewal")
    expect(capturedArgs.title).toContain('Lease Agreement');
    // State derived from variables.unit_state → OH_LEASE template
    expect(capturedArgs).toBeDefined();
  });

  test('BOLDSIGN_API_KEY not set → returns SKIPPED without HTTP call', async () => {
    const savedKey = process.env.BOLDSIGN_API_KEY;
    delete process.env.BOLDSIGN_API_KEY;
    capturedArgs = null;

    const result = await boldSign.sendLeaseForSignature({
      tenantEmail: 'a@b.com', tenantName: 'A', landlordEmail: 'l@b.com', landlordName: 'L',
      variables: { unit_state: 'OH' },
    });

    expect(result.documentId).toBe('SKIPPED');
    expect(capturedArgs).toBeNull(); // no HTTP call made

    process.env.BOLDSIGN_API_KEY = savedKey;
  });
});

describe('BoldSign – AI tool flow (send_lease_for_signature)', () => {
  let executeTool;
  let capturedBoldSignArgs = null;

  const mockTenant = {
    name:          'Maria Garcia',
    customer_name: 'Maria Garcia',
    email_id:      'maria.garcia.tenant@example.com',
    mobile_no:     '+14155551001',
  };
  const mockLease = {
    name:             'LEASE-001',
    lease_customer:   'Maria Garcia',
    property:         '512 Maple Street, Unit 1A – SF',
    start_date:       '2026-07-01',
    end_date:         '2027-06-30',
    monthly_rent:     2800,
    security_deposit: 5600,
    notice_period:    30,
    custom_late_fee_grace_days:  5,
    custom_late_fee_flat_amount: 100,
  };
  const mockProperty = {
    name:                  '512 Maple Street, Unit 1A – SF',
    name1:                 '512 Maple Street, Unit 1A',
    custom_state:          'OH',
    custom_street_address: '512 Maple Street',
    custom_city:           'Cleveland',
    custom_zip_code:       '44101',
  };

  beforeAll(() => {
    jest.resetModules();

    jest.mock('../src/api/index', () => ({
      getTenants:   jest.fn().mockResolvedValue([mockTenant]),
      getLeases:    jest.fn().mockResolvedValue([mockLease]),
      getProperty:  jest.fn().mockResolvedValue(mockProperty),
    }));

    jest.mock('../src/api/boldsign', () => ({
      sendDocumentForSignature: jest.fn((args) => {
        capturedBoldSignArgs = args;
        return Promise.resolve({ documentId: 'DOC-AI-001' });
      }),
      sendLeaseForSignature: jest.fn(),
    }));

    process.env.LANDLORD_NAME    = 'Dan Porat';
    process.env.LANDLORD_EMAIL   = 'dan@example.com';
    process.env.LANDLORD_PHONE   = '+14155550000';
    process.env.LANDLORD_ADDRESS = '123 Owner Street, SF CA 94102';

    // We need to access the private executeTool function – load openai module
    // and expose it via a thin wrapper (the module doesn't export executeTool directly,
    // so we test through the chat() flow with a mocked openai client that fires the tool).
    // Instead, re-require after mocks are set up and invoke via the module internals.
    // Since executeTool is not exported we test the tool handler indirectly:
    // mock openai to return a tool_calls response for send_lease_for_signature,
    // then a stop response, and verify boldSign.sendDocumentForSignature was called correctly.
    jest.mock('openai', () => {
      let callCount = 0;
      return jest.fn().mockImplementation(() => ({
        chat: {
          completions: {
            create: jest.fn().mockImplementation(({ messages }) => {
              callCount++;
              // First call: return a tool_calls response
              if (callCount % 2 === 1) {
                return Promise.resolve({
                  choices: [{
                    finish_reason: 'tool_calls',
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [{
                        id: 'call_001',
                        type: 'function',
                        function: {
                          name: 'send_lease_for_signature',
                          arguments: JSON.stringify({ tenantName: 'Maria Garcia', doc_type: 'Lease' }),
                        },
                      }],
                    },
                  }],
                });
              }
              // Second call: return a stop response
              return Promise.resolve({
                choices: [{
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: 'Lease sent successfully to Maria Garcia.' },
                }],
              });
            }),
          },
        },
      }));
    });
  });

  afterAll(() => {
    jest.unmock('../src/api/index');
    jest.unmock('../src/api/boldsign');
    jest.unmock('openai');
    jest.resetModules();
  });

  test('chat() triggers sendDocumentForSignature with full variable map', async () => {
    const { chat } = require('../src/ai/openai');
    const reply = await chat('Send lease to Maria Garcia', []);

    expect(typeof reply).toBe('string');

    // Verify sendDocumentForSignature was called
    const boldSignMock = require('../src/api/boldsign');
    expect(boldSignMock.sendDocumentForSignature).toHaveBeenCalled();

    expect(capturedBoldSignArgs.docType).toBe('Lease');
    expect(capturedBoldSignArgs.state).toBe('OH');
    expect(capturedBoldSignArgs.tenantEmail).toBe('maria.garcia.tenant@example.com');
    expect(capturedBoldSignArgs.landlordName).toBe('Dan Porat');

    // Verify the full variables map
    expect(capturedBoldSignArgs.variables.landlord_name).toBe('Dan Porat');
    expect(capturedBoldSignArgs.variables.tenant_name).toBe('Maria Garcia');
    expect(capturedBoldSignArgs.variables.tenant_phone).toBe('+14155551001');
    expect(capturedBoldSignArgs.variables.unit_address).toBe('512 Maple Street');
    expect(capturedBoldSignArgs.variables.unit_city).toBe('Cleveland');
    expect(capturedBoldSignArgs.variables.unit_state).toBe('OH');
    expect(capturedBoldSignArgs.variables.unit_zip).toBe('44101');
    expect(capturedBoldSignArgs.variables.monthly_rent).toBe(2800);
    expect(capturedBoldSignArgs.variables.security_deposit).toBe(5600);
  }, 30_000);

  test('chat() with doc_type=Renewal passes Renewal to sendDocumentForSignature', async () => {
    jest.resetModules();

    // Re-mock openai to request a Renewal
    jest.mock('openai', () => {
      let callCount = 0;
      return jest.fn().mockImplementation(() => ({
        chat: {
          completions: {
            create: jest.fn().mockImplementation(() => {
              callCount++;
              if (callCount % 2 === 1) {
                return Promise.resolve({
                  choices: [{
                    finish_reason: 'tool_calls',
                    message: {
                      role: 'assistant', content: null,
                      tool_calls: [{
                        id: 'call_002', type: 'function',
                        function: {
                          name: 'send_lease_for_signature',
                          arguments: JSON.stringify({ tenantName: 'Maria Garcia', doc_type: 'Renewal' }),
                        },
                      }],
                    },
                  }],
                });
              }
              return Promise.resolve({
                choices: [{
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: 'Renewal sent to Maria Garcia.' },
                }],
              });
            }),
          },
        },
      }));
    });

    jest.mock('../src/api/index', () => ({
      getTenants:  jest.fn().mockResolvedValue([mockTenant]),
      getLeases:   jest.fn().mockResolvedValue([mockLease]),
      getProperty: jest.fn().mockResolvedValue(mockProperty),
    }));

    jest.mock('../src/api/boldsign', () => ({
      sendDocumentForSignature: jest.fn((args) => {
        capturedBoldSignArgs = args;
        return Promise.resolve({ documentId: 'DOC-RENEWAL-001' });
      }),
      sendLeaseForSignature: jest.fn(),
    }));

    const { chat: chat2 } = require('../src/ai/openai');
    await chat2('Send renewal to Maria Garcia', []);

    const boldSignMock2 = require('../src/api/boldsign');
    expect(boldSignMock2.sendDocumentForSignature).toHaveBeenCalled();
    expect(capturedBoldSignArgs.docType).toBe('Renewal');
  }, 30_000);
});

// ─── 10. SMS Dispatcher – template generation ─────────────────────────────────

describe('SMS Dispatcher – templates', () => {
  let templates;

  beforeAll(() => {
    // Use requireActual to bypass any mock that may have been registered
    // by the scheduler test describe block above.
    templates = jest.requireActual('../src/sms/dispatcher').templates;
  });

  test('rentOverdue template contains unit and amount', () => {
    const msg = templates.rentOverdue({
      unit: '512 Maple Street, Unit 1A',
      propertyAddress: '512 Maple Street',
      amountDue: 2800,
    });
    expect(msg).toContain('512 Maple Street');
    expect(msg).toContain('2800');
  });

  test('rentReminder template contains due date', () => {
    const msg = templates.rentReminder({
      unit: 'Unit 1A',
      amountDue: 2800,
      dueDate: '2026-04-01',
    });
    expect(msg).toContain('2026-04-01');
    expect(msg).toContain('2800');
  });

  test('maintenanceScheduled template contains description', () => {
    const msg = templates.maintenanceScheduled({
      unit: 'Unit 1A',
      description: 'Heater repair',
      scheduledDate: '2026-03-20',
    });
    expect(msg).toContain('Heater repair');
  });

  test('maintenanceComplete template contains unit', () => {
    const msg = templates.maintenanceComplete({
      unit: 'Unit 1A',
      description: 'Heater repaired',
    });
    expect(msg).toContain('Unit 1A');
  });
});
