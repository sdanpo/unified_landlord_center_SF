'use strict';

/**
 * Tests for the tenant portal setup script and the tenant-scoped
 * ERPNext client methods.
 *
 * All HTTP calls are mocked – no real network requests.
 */

jest.mock('axios');
const axios = require('axios');

// ── Shared mock HTTP instance ─────────────────────────────────────────────────

const mockGet  = jest.fn();
const mockPost = jest.fn();
const mockPut  = jest.fn();

const mockHttpInstance = {
  get: mockGet,
  post: mockPost,
  put: mockPut,
  interceptors: { response: { use: jest.fn() } },
};

// resetAllMocks clears both call history AND mockReturnValueOnce queues,
// preventing leftover mock state from one test contaminating the next.
beforeEach(() => {
  jest.resetAllMocks();
  axios.create.mockReturnValue(mockHttpInstance);
});

// ─────────────────────────────────────────────────────────────────────────────
// Section A – Portal setup script helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('Portal setup script – helper functions', () => {
  // Load the module inside beforeAll so that axios.create is already mocked
  // when the module-level `const http = axios.create({...})` runs.
  let helpers;

  beforeAll(() => {
    axios.create.mockReturnValue(mockHttpInstance);
    helpers = require('../scripts/setup-tenant-portal');
  });

  // ── getDoc ─────────────────────────────────────────────────────────────────

  describe('getDoc', () => {
    test('returns document data on 200', async () => {
      mockGet.mockResolvedValue({ data: { data: { name: 'CUST-0001' } } });
      const result = await helpers.getDoc('Customer', 'CUST-0001');
      expect(result).toEqual({ name: 'CUST-0001' });
    });

    test('returns null on 404', async () => {
      const err = new Error('Not found');
      err.response = { status: 404 };
      mockGet.mockRejectedValue(err);
      const result = await helpers.getDoc('Customer', 'CUST-MISSING');
      expect(result).toBeNull();
    });

    test('re-throws non-404 errors', async () => {
      const err = new Error('Server error');
      err.response = { status: 500 };
      mockGet.mockRejectedValue(err);
      await expect(helpers.getDoc('Customer', 'X')).rejects.toThrow('Server error');
    });
  });

  // ── upsert ────────────────────────────────────────────────────────────────

  describe('upsert', () => {
    test('PUTs when document already exists', async () => {
      mockGet.mockResolvedValue({ data: { data: { name: 'Stripe' } } });
      mockPut.mockResolvedValue({ data: { data: { name: 'Stripe' } } });
      await helpers.upsert('Stripe Settings', 'Stripe', { publishable_key: 'pk_test_x' });
      expect(mockPut).toHaveBeenCalledWith(
        '/api/resource/Stripe%20Settings/Stripe',
        { publishable_key: 'pk_test_x' }
      );
      expect(mockPost).not.toHaveBeenCalled();
    });

    test('POSTs when document does not exist (404)', async () => {
      const notFound = new Error('Not found');
      notFound.response = { status: 404 };
      mockGet.mockRejectedValue(notFound);
      mockPost.mockResolvedValue({ data: { data: { name: 'Stripe' } } });
      await helpers.upsert('Stripe Settings', 'Stripe', { publishable_key: 'pk_test_x' });
      expect(mockPost).toHaveBeenCalledWith(
        '/api/resource/Stripe%20Settings',
        expect.objectContaining({ name: 'Stripe', publishable_key: 'pk_test_x' })
      );
      expect(mockPut).not.toHaveBeenCalled();
    });
  });

  // ── listDocs ──────────────────────────────────────────────────────────────

  describe('listDocs', () => {
    test('returns data array from response', async () => {
      mockGet.mockResolvedValue({
        data: { data: [{ name: 'CUST-0001' }, { name: 'CUST-0002' }] },
      });
      const result = await helpers.listDocs('Customer', [], ['name']);
      expect(result).toHaveLength(2);
    });

    test('returns empty array when data key is missing', async () => {
      mockGet.mockResolvedValue({ data: {} });
      const result = await helpers.listDocs('Customer');
      expect(result).toEqual([]);
    });

    test('passes filters and fields as JSON query params', async () => {
      mockGet.mockResolvedValue({ data: { data: [] } });
      await helpers.listDocs(
        'Customer',
        [['customer_group', '=', 'Tenant']],
        ['name', 'email_id']
      );
      const [, opts] = mockGet.mock.calls[0];
      expect(JSON.parse(opts.params.filters)).toContainEqual(['customer_group', '=', 'Tenant']);
      expect(JSON.parse(opts.params.fields)).toContain('email_id');
    });
  });

  // ── ensurePortalUser ──────────────────────────────────────────────────────

  describe('ensurePortalUser', () => {
    const tenant = {
      name: 'CUST-0001',
      customer_name: 'Jane Doe',
      customer_group: 'Tenant',
      email_id: 'jane@example.com',
    };

    test('skips tenant with no email', async () => {
      const result = await helpers.ensurePortalUser({ ...tenant, email_id: '' });
      expect(result).toEqual({ skipped: true, reason: 'no_email' });
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockPost).not.toHaveBeenCalled();
    });

    test('creates Website User and links to Customer when user does not exist', async () => {
      const notFound = new Error('Not found');
      notFound.response = { status: 404 };

      // Call 1: getDoc('User', email) → 404 (user does not exist)
      // Call 2: getDoc('Customer', ...) → current doc with empty portal_users
      mockGet
        .mockRejectedValueOnce(notFound)
        .mockResolvedValueOnce({
          data: { data: { name: 'CUST-0001', portal_users: [] } },
        });
      mockPost.mockResolvedValue({ data: { data: { name: 'jane@example.com' } } });
      mockPut.mockResolvedValue({ data: { data: {} } });

      const result = await helpers.ensurePortalUser(tenant);
      expect(result).toMatchObject({ skipped: false, linked: true });

      // User created via POST
      expect(mockPost).toHaveBeenCalledWith(
        '/api/resource/User',
        expect.objectContaining({
          email: 'jane@example.com',
          user_type: 'Website User',
          roles: expect.arrayContaining([{ role: 'Customer' }]),
        })
      );
      // Customer updated with portal_users
      expect(mockPut).toHaveBeenCalledWith(
        '/api/resource/Customer/CUST-0001',
        expect.objectContaining({
          portal_users: expect.arrayContaining([{ user: 'jane@example.com' }]),
        })
      );
    });

    test('does not re-link when portal user is already linked', async () => {
      // Call 1: getDoc('User', email) → exists
      // Call 2: getDoc('Customer', ...) → already has portal_users entry
      mockGet
        .mockResolvedValueOnce({ data: { data: { name: 'jane@example.com' } } })
        .mockResolvedValueOnce({
          data: {
            data: {
              name: 'CUST-0001',
              portal_users: [{ user: 'jane@example.com' }],
            },
          },
        });
      mockPut.mockResolvedValue({ data: { data: {} } });

      const result = await helpers.ensurePortalUser(tenant);
      expect(result).toMatchObject({ skipped: false, alreadyLinked: true });

      // No Customer PUT should be issued
      const customerPuts = mockPut.mock.calls.filter(([path]) =>
        path.includes('/Customer/')
      );
      expect(customerPuts).toHaveLength(0);
    });

    test('splits multi-word customer name into first_name / last_name', async () => {
      const notFound = new Error('Not found');
      notFound.response = { status: 404 };

      mockGet
        .mockRejectedValueOnce(notFound)
        .mockResolvedValueOnce({
          data: { data: { name: 'CUST-0002', portal_users: [] } },
        });
      mockPost.mockResolvedValue({ data: { data: {} } });
      mockPut.mockResolvedValue({ data: { data: {} } });

      await helpers.ensurePortalUser({
        name: 'CUST-0002',
        customer_name: 'John Michael Smith',
        email_id: 'john@example.com',
      });

      expect(mockPost).toHaveBeenCalledWith(
        '/api/resource/User',
        expect.objectContaining({ first_name: 'John', last_name: 'Michael Smith' })
      );
    });
  });

  // ── PORTAL_MENU_ITEMS ─────────────────────────────────────────────────────

  describe('PORTAL_MENU_ITEMS', () => {
    test('includes invoices page with Customer role', () => {
      const item = helpers.PORTAL_MENU_ITEMS.find(m => m.route === '/invoices');
      expect(item).toBeDefined();
      expect(item.enabled).toBe(1);
      expect(item.role).toBe('Customer');
      expect(item.reference_doctype).toBe('Sales Invoice');
    });

    test('does NOT include /payments (no portal page in ERPNext v15 — causes 404)', () => {
      const item = helpers.PORTAL_MENU_ITEMS.find(m => m.route === '/payments');
      expect(item).toBeUndefined();
    });

    test('includes helpdesk page', () => {
      const item = helpers.PORTAL_MENU_ITEMS.find(m => m.route === '/helpdesk');
      expect(item).toBeDefined();
      expect(item.enabled).toBe(1);
    });

    test('does NOT include /me (duplicate of built-in My Account in portal header)', () => {
      const item = helpers.PORTAL_MENU_ITEMS.find(m => m.route === '/me');
      expect(item).toBeUndefined();
    });

    test('all items have required fields (title, route, enabled)', () => {
      for (const item of helpers.PORTAL_MENU_ITEMS) {
        expect(item).toHaveProperty('title');
        expect(item).toHaveProperty('route');
        expect(item).toHaveProperty('enabled');
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section B – ERPNextClient: tenant-scoped portal data methods
// ─────────────────────────────────────────────────────────────────────────────

describe('ERPNextClient – tenant portal methods', () => {
  const ERPNextClient = require('../src/api/erpnext');
  let client;

  beforeEach(() => {
    client = new ERPNextClient({
      baseUrl: 'https://erpnext.test.local',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
    });
  });

  // ── getTenantInvoices ─────────────────────────────────────────────────────

  describe('getTenantInvoices', () => {
    test('filters by customer and docstatus=1', async () => {
      mockGet.mockResolvedValue({ data: { data: [] } });
      await client.getTenantInvoices('CUST-0001');
      const [path, opts] = mockGet.mock.calls[0];
      expect(path).toBe('/api/resource/Sales%20Invoice');
      const filters = JSON.parse(opts.params.filters);
      expect(filters).toContainEqual(['customer', '=', 'CUST-0001']);
      expect(filters).toContainEqual(['docstatus', '=', 1]);
    });

    test('adds outstanding_amount > 0 filter for status="unpaid"', async () => {
      mockGet.mockResolvedValue({ data: { data: [] } });
      await client.getTenantInvoices('CUST-0001', { status: 'unpaid' });
      const filters = JSON.parse(mockGet.mock.calls[0][1].params.filters);
      expect(filters).toContainEqual(['outstanding_amount', '>', 0]);
    });

    test('adds outstanding_amount = 0 filter for status="paid"', async () => {
      mockGet.mockResolvedValue({ data: { data: [] } });
      await client.getTenantInvoices('CUST-0001', { status: 'paid' });
      const filters = JSON.parse(mockGet.mock.calls[0][1].params.filters);
      expect(filters).toContainEqual(['outstanding_amount', '=', 0]);
    });

    test('returns invoice list', async () => {
      const mockInvoices = [{
        name: 'SINV-00001',
        posting_date: '2026-02-01',
        due_date: '2026-03-01',
        grand_total: 2500,
        outstanding_amount: 2500,
        status: 'Unpaid',
        custom_unit: 'Unit 1A',
        custom_lease: 'RC-0001',
      }];
      mockGet.mockResolvedValue({ data: { data: mockInvoices } });
      const result = await client.getTenantInvoices('CUST-0001');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('SINV-00001');
      expect(result[0].grand_total).toBe(2500);
    });
  });

  // ── getTenantPayments ─────────────────────────────────────────────────────

  describe('getTenantPayments', () => {
    test('filters by party_type=Customer and party=customerId', async () => {
      mockGet.mockResolvedValue({ data: { data: [] } });
      await client.getTenantPayments('CUST-0001');
      const [path, opts] = mockGet.mock.calls[0];
      expect(path).toBe('/api/resource/Payment%20Entry');
      const filters = JSON.parse(opts.params.filters);
      expect(filters).toContainEqual(['party_type', '=', 'Customer']);
      expect(filters).toContainEqual(['party', '=', 'CUST-0001']);
      expect(filters).toContainEqual(['docstatus', '=', 1]);
    });

    test('returns payment records', async () => {
      const mockPayments = [{
        name: 'PE-00001',
        posting_date: '2026-01-15',
        paid_amount: 2500,
        mode_of_payment: 'Stripe',
        custom_unit: 'Unit 1A',
      }];
      mockGet.mockResolvedValue({ data: { data: mockPayments } });
      const result = await client.getTenantPayments('CUST-0001');
      expect(result).toHaveLength(1);
      expect(result[0].paid_amount).toBe(2500);
    });
  });

  // ── getTenantTickets ──────────────────────────────────────────────────────

  describe('getTenantTickets', () => {
    test('fetches all HD Tickets with no server-side customer filter (Frappe v15 limit)', async () => {
      mockGet.mockResolvedValue({ data: { data: [] } });
      await client.getTenantTickets('CUST-0001');
      const [path, opts] = mockGet.mock.calls[0];
      expect(path).toBe('/api/resource/HD%20Ticket');
      const filters = JSON.parse(opts.params.filters);
      expect(filters.some(([f]) => f === 'customer')).toBe(false);
    });

    test('returns only tickets belonging to the specified customer (client-side filter)', async () => {
      mockGet.mockResolvedValue({
        data: {
          data: [
            { name: 'HDT-0001', customer: 'CUST-0001', status: 'Open',     subject: 'Leak in bathroom' },
            { name: 'HDT-0002', customer: 'CUST-0002', status: 'Open',     subject: 'AC not working'   },
            { name: 'HDT-0003', customer: 'CUST-0001', status: 'Resolved', subject: 'Broken door'      },
          ],
        },
      });
      const result = await client.getTenantTickets('CUST-0001');
      expect(result).toHaveLength(2);
      expect(result.every(t => t.customer === 'CUST-0001')).toBe(true);
    });

    test('returns empty array when tenant has no tickets', async () => {
      mockGet.mockResolvedValue({
        data: { data: [{ name: 'HDT-0001', customer: 'CUST-0002', status: 'Open' }] },
      });
      const result = await client.getTenantTickets('CUST-0001');
      expect(result).toHaveLength(0);
    });
  });
});
