'use strict';

/**
 * Tests for the ERPNext API client.
 * All HTTP calls are mocked via Jest – no real network requests.
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

  test('getVacantUnits filters by status=Vacant', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getVacantUnits();
    const [path, opts] = mockGet.mock.calls[0];
    expect(path).toBe('/api/resource/Property%20Unit');
    expect(JSON.parse(opts.params.filters)).toEqual([['status', '=', 'Vacant']]);
  });

  test('getUnits passes propertyId filter when provided', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getUnits({ propertyId: 'PROP-0001' });
    const [, opts] = mockGet.mock.calls[0];
    expect(JSON.parse(opts.params.filters)).toContainEqual(['property', '=', 'PROP-0001']);
  });

  // ── Leases & Tenants ────────────────────────────────────────────────────────

  test('getLeases maps status "active" to ERPNext "Active"', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getLeases({ status: 'active' });
    const [path, opts] = mockGet.mock.calls[0];
    expect(path).toBe('/api/resource/Rental%20Contract');
    expect(JSON.parse(opts.params.filters)).toContainEqual(['status', '=', 'Active']);
  });

  test('getLeases with status "all" sends empty filters', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getLeases({ status: 'all' });
    const [, opts] = mockGet.mock.calls[0];
    expect(JSON.parse(opts.params.filters)).toEqual([]);
  });

  test('getTenants always includes customer_group=Tenant filter', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getTenants();
    const [path, opts] = mockGet.mock.calls[0];
    expect(path).toBe('/api/resource/Customer');
    expect(JSON.parse(opts.params.filters)).toContainEqual(['customer_group', '=', 'Tenant']);
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

  test('getWorkOrders calls GET /api/resource/HD%20Ticket with no filters for "all"', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ name: 'HDT-0001', status: 'Open' }] } });
    const result = await client.getWorkOrders({ status: 'all' });
    const [path, opts] = mockGet.mock.calls[0];
    expect(path).toBe('/api/resource/HD%20Ticket');
    expect(JSON.parse(opts.params.filters)).toEqual([]);
    expect(result).toEqual([{ name: 'HDT-0001', status: 'Open' }]);
  });

  test('getWorkOrders maps status "open" → "Open"', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getWorkOrders({ status: 'open' });
    const [, opts] = mockGet.mock.calls[0];
    expect(JSON.parse(opts.params.filters)).toContainEqual(['status', '=', 'Open']);
  });

  test('getStaleWorkOrders passes creation cutoff and open statuses', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    await client.getStaleWorkOrders(48);
    const [, opts] = mockGet.mock.calls[0];
    const filters = JSON.parse(opts.params.filters);
    expect(filters).toContainEqual(['status', 'in', ['Open', 'Replied']]);
    const cutoffFilter = filters.find(([f]) => f === 'creation');
    expect(cutoffFilter).toBeDefined();
    expect(cutoffFilter[1]).toBe('<');
    // Cutoff should be approximately 48 h ago (within 10 s tolerance)
    const cutoffMs = new Date(cutoffFilter[2].replace(' ', 'T')).getTime();
    const expectedMs = Date.now() - 48 * 60 * 60 * 1000;
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(10_000);
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
