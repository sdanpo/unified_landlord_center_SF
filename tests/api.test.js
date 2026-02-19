'use strict';

/**
 * Tests for the PMS API clients (DoorLoop and Buildium).
 * All HTTP calls are mocked via Jest – no real network requests.
 */

jest.mock('axios');
const axios = require('axios');

const DoorLoopClient = require('../src/api/doorloop');
const BuildiumClient = require('../src/api/buildium');

// ─── Shared mock setup ────────────────────────────────────────────────────────

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPatch = jest.fn();

const mockHttpInstance = {
  get: mockGet,
  post: mockPost,
  patch: mockPatch,
  interceptors: {
    response: { use: jest.fn() },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  axios.create.mockReturnValue(mockHttpInstance);
});

// ─── DoorLoop client ──────────────────────────────────────────────────────────

describe('DoorLoopClient', () => {
  let client;

  beforeEach(() => {
    client = new DoorLoopClient({ apiKey: 'test-key', baseUrl: 'https://api.doorloop.com/v1' });
  });

  test('getProperties calls GET /properties', async () => {
    mockGet.mockResolvedValue({ data: [{ id: '1', name: 'Test Building' }] });
    const result = await client.getProperties();
    expect(mockGet).toHaveBeenCalledWith('/properties', { params: {} });
    expect(result).toEqual([{ id: '1', name: 'Test Building' }]);
  });

  test('getOutstandingBalances calls GET /rentals/outstandingbalances', async () => {
    const mockBalances = [
      { leaseId: 'L1', tenantName: 'John Doe', unitName: 'Unit 3A', amountDue: 1200, daysOverdue: 5 },
    ];
    mockGet.mockResolvedValue({ data: mockBalances });
    const result = await client.getOutstandingBalances();
    expect(mockGet).toHaveBeenCalledWith('/rentals/outstandingbalances', { params: {} });
    expect(result).toEqual(mockBalances);
  });

  test('getWorkOrders calls GET /workorders', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'WO1', status: 'open' }] });
    const result = await client.getWorkOrders({ status: 'open' });
    expect(mockGet).toHaveBeenCalledWith('/workorders', { params: { status: 'open' } });
    expect(result).toEqual([{ id: 'WO1', status: 'open' }]);
  });

  test('getStaleWorkOrders passes createdBefore param', async () => {
    mockGet.mockResolvedValue({ data: [] });
    await client.getStaleWorkOrders(48);
    const [endpoint, opts] = mockGet.mock.calls[0];
    expect(endpoint).toBe('/workorders');
    expect(opts.params.status).toBe('open');
    expect(opts.params.createdBefore).toBeDefined();
    // createdBefore should be approximately 48 hours ago
    const cutoff = new Date(opts.params.createdBefore).getTime();
    const expected = Date.now() - 48 * 60 * 60 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(5000); // within 5 seconds
  });

  test('getVacantUnits calls GET /units with vacant:true', async () => {
    mockGet.mockResolvedValue({ data: [] });
    await client.getVacantUnits();
    expect(mockGet).toHaveBeenCalledWith('/units', { params: { vacant: true } });
  });

  test('getLeases accepts status param', async () => {
    mockGet.mockResolvedValue({ data: [] });
    await client.getLeases({ status: 'active' });
    expect(mockGet).toHaveBeenCalledWith('/leases', { params: { status: 'active' } });
  });

  test('sendSMS posts to /communications/sms', async () => {
    mockPost.mockResolvedValue({ data: { id: 'sms-1', status: 'sent' } });
    const result = await client.sendSMS('tenant-42', 'Your rent is due.');
    expect(mockPost).toHaveBeenCalledWith('/communications/sms', {
      tenantId: 'tenant-42',
      message: 'Your rent is due.',
    });
    expect(result).toEqual({ id: 'sms-1', status: 'sent' });
  });

  test('updateWorkOrder patches the correct endpoint', async () => {
    mockPatch.mockResolvedValue({ data: { id: 'WO1', status: 'completed' } });
    await client.updateWorkOrder('WO1', { status: 'completed' });
    expect(mockPatch).toHaveBeenCalledWith('/workorders/WO1', { status: 'completed' });
  });
});

// ─── Buildium client ──────────────────────────────────────────────────────────

describe('BuildiumClient', () => {
  let client;

  beforeEach(() => {
    client = new BuildiumClient({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      baseUrl: 'https://api.buildium.com/v1',
    });
  });

  test('getOutstandingBalances calls GET /leases/outstandingbalances', async () => {
    mockGet.mockResolvedValue({ data: [] });
    await client.getOutstandingBalances();
    expect(mockGet).toHaveBeenCalledWith('/leases/outstandingbalances', { params: {} });
  });

  test('getWorkOrders calls GET /tasks/maintenancerequests', async () => {
    mockGet.mockResolvedValue({ data: [] });
    await client.getWorkOrders();
    expect(mockGet).toHaveBeenCalledWith('/tasks/maintenancerequests', { params: {} });
  });

  test('getStaleWorkOrders uses date-only cutoff for Buildium', async () => {
    mockGet.mockResolvedValue({ data: [] });
    await client.getStaleWorkOrders(48);
    const [, opts] = mockGet.mock.calls[0];
    // Buildium uses date-only (YYYY-MM-DD) not full ISO
    expect(opts.params.createdDateTimeTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── PMS factory ──────────────────────────────────────────────────────────────

describe('PMS API factory', () => {
  test('returns a DoorLoopClient when PMS_PROVIDER=doorloop', () => {
    // config is already loaded with doorloop from setup.js
    const pmsClient = require('../src/api/index');
    expect(pmsClient).toBeInstanceOf(DoorLoopClient);
  });
});
