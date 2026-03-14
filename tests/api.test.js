'use strict';

/**
 * Tests for the ERPNext API client.
 * All HTTP calls are mocked via Jest – no real network requests.
 *
 * Note: Frappe v15 rejects several fields as list-query filters on certain
 * DocTypes (customer_group, status on HD Ticket, lease_status on Lease, etc.).
 * The client therefore fetches all records with no server-side filter for
 * those fields and filters the results client-side.  Tests below verify
 * the actual current behaviour.
 */

jest.mock('axios');
const axios = require('axios');

const ERPNextClient = require('../src/api/erpnext');

// ─── Shared mock setup ────────────────────────────────────────────────────────

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPut = jest.fn();

const mockHttpInstance = {
  get: mockGet,
  post: mockPost,
  put: mockPut,
  interceptors: {
    response: { use: jest.fn() },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  axios.create.mockReturnValue(mockHttpInstance);
});

// ─── ERPNext client ───────────────────────────────────────────────────────────

describe('ERPNextClient', () => {
  let client;

  beforeEach(() => {
    client = new ERPNextClient({
      baseUrl: 'https://erpnext.test.local',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
    });
  });

  // ── Auth header ─────────────────────────────────────────────────────────────

  test('creates axios instance with token auth header', () => {
    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://erpnext.test.local',
        headers: expect.objectContaining({
          Authorization: 'token test-key:test-secret',
        }),
      })
    );
  });

  // ── Properties & Units ──────────────────────────────────────────────────────

  test('getProperties calls GET /api/resource/Property', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ name: 'PROP-0001', property_name: 'Test Building' }] } });
    const result = await client.getProperties();
    expect(mockGet).toHaveBeenCalledWith(
      '/api/resource/Property',
      expect.objectContaining({ params: expect.objectContaining({ filters: '[]' }) })
    );
    expect(result).toEqual([{ name: 'PROP-0001', property_name: 'Test Building' }]);
  });

  test('getVacantUnits queries Property with status=Available filter', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getVacantUnits();
    const [path, opts] = mockGet.mock.calls[0];
    expect(path).toBe('/api/resource/Property');
    expect(JSON.parse(opts.params.filters)).toContainEqual(['status', '=', 'Available']);
  });

  test('getUnits passes parent_property filter when propertyId provided', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getUnits({ propertyId: 'PROP-0001' });
    const [path, opts] = mockGet.mock.calls[0];
    expect(path).toBe('/api/resource/Property');
    expect(JSON.parse(opts.params.filters)).toContainEqual(['parent_property', '=', 'PROP-0001']);
  });

  // ── Leases & Tenants ────────────────────────────────────────────────────────
  // Frappe v15 rejects lease_status as a server-side filter on Lease.
  // The client fetches all leases (fields: ['*']) and filters client-side.

  test('getLeases fetches all Lease records (no server-side status filter)', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getLeases({ status: 'active' });
    const [path, opts] = mockGet.mock.calls[0];
    expect(path).toBe('/api/resource/Lease');
    // No status filter sent to the server
    expect(JSON.parse(opts.params.filters)).toEqual([]);
  });

  test('getLeases returns only Active leases when status="active"', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: [
          { name: 'LEASE-0001', lease_status: 'Active' },
          { name: 'LEASE-0002', lease_status: 'Closed' },
        ],
      },
    });
    const result = await client.getLeases({ status: 'active' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('LEASE-0001');
  });

  test('getTenants fetches all Customer records (no server-side customer_group filter)', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getTenants();
    const [path, opts] = mockGet.mock.calls[0];
    expect(path).toBe('/api/resource/Customer');
    // customer_group filter is applied client-side, not sent to the server
    const filters = JSON.parse(opts.params.filters);
    expect(filters.some(([f]) => f === 'customer_group')).toBe(false);
  });

  test('getTenants returns only customers in the "Tenant" group', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: [
          { name: 'CUST-0001', customer_name: 'Alice', customer_group: 'Tenant' },
          { name: 'CUST-0002', customer_name: 'Bob',   customer_group: 'Individual' },
        ],
      },
    });
    const result = await client.getTenants();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('CUST-0001');
  });

  test('getTenant fetches single Customer document', async () => {
    mockGet.mockResolvedValue({ data: { data: { name: 'CUST-0001', customer_name: 'Jane Doe' } } });
    const result = await client.getTenant('CUST-0001');
    expect(mockGet).toHaveBeenCalledWith('/api/resource/Customer/CUST-0001');
    expect(result.customer_name).toBe('Jane Doe');
  });

  // ── Financials ──────────────────────────────────────────────────────────────

  test('getOutstandingBalances filters for submitted invoices past due', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getOutstandingBalances();
    const [path, opts] = mockGet.mock.calls[0];
    expect(path).toBe('/api/resource/Sales%20Invoice');
    const filters = JSON.parse(opts.params.filters);
    expect(filters).toContainEqual(['docstatus', '=', 1]);
    expect(filters).toContainEqual(['outstanding_amount', '>', 0]);
    expect(filters.some(([f]) => f === 'due_date')).toBe(true);
  });

  test('getLeaseLedger filters by custom_lease', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getLeaseLedger('RC-0001');
    const [, opts] = mockGet.mock.calls[0];
    expect(JSON.parse(opts.params.filters)).toContainEqual(['custom_lease', '=', 'RC-0001']);
  });

  test('getGeneralLedger passes date range filters', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getGeneralLedger({ startDate: '2026-01-01', endDate: '2026-01-31' });
    const [path, opts] = mockGet.mock.calls[0];
    expect(path).toBe('/api/resource/GL%20Entry');
    const filters = JSON.parse(opts.params.filters);
    expect(filters).toContainEqual(['posting_date', '>=', '2026-01-01']);
    expect(filters).toContainEqual(['posting_date', '<=', '2026-01-31']);
  });

  // ── Work Orders ─────────────────────────────────────────────────────────────
  // Frappe v15 rejects status as a server-side filter on HD Ticket.
  // The client fetches all tickets and filters client-side.

  test('getWorkOrders calls GET /api/resource/HD%20Ticket with no server-side filters', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ name: 'HDT-0001', status: 'Open' }] } });
    const result = await client.getWorkOrders({ status: 'all' });
    const [path, opts] = mockGet.mock.calls[0];
    expect(path).toBe('/api/resource/HD%20Ticket');
    expect(JSON.parse(opts.params.filters)).toEqual([]);
    expect(result).toEqual([{ name: 'HDT-0001', status: 'Open' }]);
  });

  test('getWorkOrders with status="open" returns only Open tickets (client-side filter)', async () => {
    mockGet.mockResolvedValue({
      data: {
        data: [
          { name: 'HDT-0001', status: 'Open' },
          { name: 'HDT-0002', status: 'Resolved' },
        ],
      },
    });
    const result = await client.getWorkOrders({ status: 'open' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('HDT-0001');
    // No status filter sent to the server
    const [, opts] = mockGet.mock.calls[0];
    expect(JSON.parse(opts.params.filters)).toEqual([]);
  });

  test('getStaleWorkOrders fetches all tickets and filters by age client-side', async () => {
    const twoHoursAgo   = new Date(Date.now() - 2  * 60 * 60 * 1000).toISOString();
    const seventyHrsAgo = new Date(Date.now() - 70 * 60 * 60 * 1000).toISOString();

    mockGet.mockResolvedValue({
      data: {
        data: [
          { name: 'HDT-0001', status: 'Open',   creation: seventyHrsAgo }, // stale
          { name: 'HDT-0002', status: 'Replied', creation: twoHoursAgo  }, // fresh
          { name: 'HDT-0003', status: 'Resolved',creation: seventyHrsAgo }, // resolved – excluded
        ],
      },
    });

    const result = await client.getStaleWorkOrders(48);

    // No server-side filters
    const [, opts] = mockGet.mock.calls[0];
    expect(JSON.parse(opts.params.filters)).toEqual([]);

    // Only the 70-h-old open ticket qualifies
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('HDT-0001');
  });

  test('updateWorkOrder calls PUT on the correct resource path', async () => {
    mockPut.mockResolvedValue({ data: { data: { name: 'HDT-0001', status: 'Resolved' } } });
    await client.updateWorkOrder('HDT-0001', { status: 'Resolved' });
    expect(mockPut).toHaveBeenCalledWith(
      '/api/resource/HD%20Ticket/HDT-0001',
      { status: 'Resolved' }
    );
  });
});

// ─── PMS factory ──────────────────────────────────────────────────────────────

describe('PMS API factory', () => {
  test('exports an ERPNextClient instance', () => {
    const pmsClient = require('../src/api/index');
    expect(pmsClient).toBeInstanceOf(ERPNextClient);
  });
});
