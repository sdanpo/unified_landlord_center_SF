'use strict';

/**
 * Tests for the create_work_order and update_work_order flows:
 *   - ERPNextClient.createWorkOrder()
 *   - ERPNextClient.updateWorkOrder()
 *   - AI tool executor: create_work_order (with and without tenant lookup)
 *   - AI tool executor: update_work_order (status, priority, description, error case)
 */

const axios = require('axios');
const ERPNextClient = require('../src/api/erpnext');

// ─── ERPNextClient unit tests ─────────────────────────────────────────────────

jest.mock('axios');

function buildClient() {
  const mockHttp = {
    get:  jest.fn(),
    post: jest.fn(),
    put:  jest.fn(),
    interceptors: { response: { use: jest.fn() } },
  };
  axios.create = jest.fn().mockReturnValue(mockHttp);
  const client = new ERPNextClient({
    baseUrl:   'https://erpnext.test.local',
    apiKey:    'key',
    apiSecret: 'secret',
  });
  return { client, mockHttp };
}

describe('ERPNextClient.createWorkOrder()', () => {
  it('POST /api/resource/HD Ticket with required subject', async () => {
    const { client, mockHttp } = buildClient();
    const created = { name: 'HD-TICKET-0099', subject: 'Broken dishwasher', status: 'Open', priority: 'Medium' };
    mockHttp.post = jest.fn().mockResolvedValue({ data: { data: created } });

    const result = await client.createWorkOrder({ subject: 'Broken dishwasher' });

    expect(mockHttp.post).toHaveBeenCalledTimes(1);
    const [url, payload] = mockHttp.post.mock.calls[0];
    expect(url).toContain('HD%20Ticket');
    expect(payload.subject).toBe('Broken dishwasher');
    expect(payload.priority).toBe('Medium'); // default
    expect(result.name).toBe('HD-TICKET-0099');
  });

  it('includes all optional fields when provided', async () => {
    const { client, mockHttp } = buildClient();
    const created = { name: 'HD-TICKET-0100', subject: 'HVAC issue', status: 'Open', priority: 'Urgent' };
    mockHttp.post = jest.fn().mockResolvedValue({ data: { data: created } });

    await client.createWorkOrder({
      subject:        'HVAC issue',
      description:    'Not cooling properly',
      priority:       'Urgent',
      customer:       'CUST-001',
      raisedBy:       'landlord@example.com',
      customUnit:     'Unit 3A',
      customProperty: 'Oak Street Property',
    });

    const payload = mockHttp.post.mock.calls[0][1];
    expect(payload.description).toBe('Not cooling properly');
    expect(payload.priority).toBe('Urgent');
    expect(payload.customer).toBe('CUST-001');
    expect(payload.raised_by).toBe('landlord@example.com');
    expect(payload.custom_unit).toBe('Unit 3A');
    expect(payload.custom_property).toBe('Oak Street Property');
  });

  it('throws when subject is missing', async () => {
    const { client } = buildClient();
    await expect(client.createWorkOrder({ description: 'No subject' }))
      .rejects.toThrow('subject is required');
  });
});

describe('ERPNextClient.updateWorkOrder()', () => {
  it('PUT /api/resource/HD Ticket/:name with the given payload', async () => {
    const { client, mockHttp } = buildClient();
    const updated = { name: 'HD-TICKET-0042', status: 'Resolved' };
    mockHttp.put = jest.fn().mockResolvedValue({ data: { data: updated } });

    const result = await client.updateWorkOrder('HD-TICKET-0042', { status: 'Resolved' });

    expect(mockHttp.put).toHaveBeenCalledTimes(1);
    const [url, payload] = mockHttp.put.mock.calls[0];
    expect(url).toContain('HD-TICKET-0042');
    expect(payload.status).toBe('Resolved');
    expect(result.status).toBe('Resolved');
  });
});

// ─── AI tool executor tests ───────────────────────────────────────────────────

// Mock pmsClient (the API index) so executeTool uses our stubs
jest.mock('../src/api/index', () => ({
  getTenants:             jest.fn(),
  createWorkOrder:        jest.fn(),
  updateWorkOrder:        jest.fn(),
  getWorkOrder:           jest.fn(),
  getVendor:              jest.fn(),
  getOutstandingBalances: jest.fn().mockResolvedValue([]),
  getWorkOrders:          jest.fn().mockResolvedValue([]),
  getStaleWorkOrders:     jest.fn().mockResolvedValue([]),
  getLeases:              jest.fn().mockResolvedValue([]),
  getVacantUnits:         jest.fn().mockResolvedValue([]),
  getGeneralLedger:       jest.fn().mockResolvedValue([]),
  getTenant:              jest.fn(),
  getExpiringLeases:      jest.fn().mockResolvedValue([]),
  getVendors:             jest.fn().mockResolvedValue([]),
  assignVendor:           jest.fn().mockResolvedValue({}),
  getCRMLeads:            jest.fn().mockResolvedValue([]),
  getCRMLead:             jest.fn(),
  updateCRMLead:          jest.fn().mockResolvedValue({}),
  getLease:               jest.fn(),
  getProperty:            jest.fn(),
}));

// mockCreate is declared with the `mock` prefix so Jest's hoisting allows
// it to be referenced inside the jest.mock() factory function.
const mockCreate = jest.fn();

// Mock OpenAI so we control model responses without hitting the API
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
});

const pmsClient = require('../src/api/index');
const { chat }  = require('../src/ai/openai');

/**
 * Primes mockCreate so the first completion returns a tool_call
 * and the second returns a stop-response with content "Done."
 */
function mockOpenAIToolCall(toolName, toolArgs) {
  mockCreate
    .mockResolvedValueOnce({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id:       'call_test_1',
            type:     'function',
            function: { name: toolName, arguments: JSON.stringify(toolArgs) },
          }],
        },
      }],
    })
    .mockResolvedValueOnce({
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Done.' },
      }],
    });
}

describe('AI executor – create_work_order', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a ticket with subject only, no tenant lookup', async () => {
    pmsClient.createWorkOrder.mockResolvedValue({
      name:     'HD-TICKET-0099',
      subject:  'Broken window – Unit 5B',
      status:   'Open',
      priority: 'Medium',
    });

    mockOpenAIToolCall('create_work_order', {
      subject:  'Broken window – Unit 5B',
      priority: 'Medium',
    });

    const reply = await chat('Open a ticket: broken window in Unit 5B', []);
    expect(reply).toBe('Done.');

    expect(pmsClient.getTenants).not.toHaveBeenCalled();
    expect(pmsClient.createWorkOrder).toHaveBeenCalledTimes(1);
    const callArgs = pmsClient.createWorkOrder.mock.calls[0][0];
    expect(callArgs.subject).toBe('Broken window – Unit 5B');
    expect(callArgs.priority).toBe('Medium');
  });

  it('resolves tenant and propagates unit when tenantName is provided', async () => {
    pmsClient.getTenants.mockResolvedValue([{
      name:            'CUST-001',
      customer_name:   'Alice Smith',
      custom_unit:     'Unit 3A',
      custom_property: 'Oak St',
    }]);
    pmsClient.createWorkOrder.mockResolvedValue({
      name:     'HD-TICKET-0100',
      subject:  'Leaking faucet',
      status:   'Open',
      priority: 'High',
    });

    mockOpenAIToolCall('create_work_order', {
      subject:    'Leaking faucet',
      priority:   'High',
      tenantName: 'Alice',
    });

    await chat('Create ticket for Alice – leaking faucet, high priority', []);

    expect(pmsClient.getTenants).toHaveBeenCalledWith({ name: 'Alice' });
    const callArgs = pmsClient.createWorkOrder.mock.calls[0][0];
    expect(callArgs.customer).toBe('CUST-001');
    expect(callArgs.customUnit).toBe('Unit 3A');
    expect(callArgs.customProperty).toBe('Oak St');
    expect(callArgs.subject).toBe('Leaking faucet');
  });

  it('still creates ticket when tenant lookup returns no results', async () => {
    pmsClient.getTenants.mockResolvedValue([]);
    pmsClient.createWorkOrder.mockResolvedValue({
      name: 'HD-TICKET-0101', subject: 'Pest issue', status: 'Open', priority: 'Urgent',
    });

    mockOpenAIToolCall('create_work_order', {
      subject:    'Pest issue',
      priority:   'Urgent',
      tenantName: 'Unknown Tenant',
    });

    await chat('Urgent: pest issue, tenant Unknown Tenant', []);

    expect(pmsClient.createWorkOrder).toHaveBeenCalledTimes(1);
    const callArgs = pmsClient.createWorkOrder.mock.calls[0][0];
    expect(callArgs.customer).toBeUndefined();
    expect(callArgs.subject).toBe('Pest issue');
  });
});

describe('AI executor – update_work_order', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates status to Resolved', async () => {
    pmsClient.updateWorkOrder.mockResolvedValue({ name: 'HD-TICKET-0042', status: 'Resolved' });

    mockOpenAIToolCall('update_work_order', {
      ticketName: 'HD-TICKET-0042',
      status:     'Resolved',
    });

    await chat('Mark HD-TICKET-0042 as resolved', []);

    expect(pmsClient.updateWorkOrder).toHaveBeenCalledWith(
      'HD-TICKET-0042',
      { status: 'Resolved' }
    );
  });

  it('updates priority only', async () => {
    pmsClient.updateWorkOrder.mockResolvedValue({ name: 'HD-TICKET-0050', priority: 'Urgent' });

    mockOpenAIToolCall('update_work_order', {
      ticketName: 'HD-TICKET-0050',
      priority:   'Urgent',
    });

    await chat('Set ticket HD-TICKET-0050 to urgent', []);

    expect(pmsClient.updateWorkOrder).toHaveBeenCalledWith(
      'HD-TICKET-0050',
      { priority: 'Urgent' }
    );
  });

  it('updates status and description together', async () => {
    pmsClient.updateWorkOrder.mockResolvedValue({ name: 'HD-TICKET-0055', status: 'Closed' });

    mockOpenAIToolCall('update_work_order', {
      ticketName:  'HD-TICKET-0055',
      status:      'Closed',
      description: "Fixed by Mike's Plumbing on 2026-03-30",
    });

    await chat('Close HD-TICKET-0055, note: fixed by vendor', []);

    expect(pmsClient.updateWorkOrder).toHaveBeenCalledWith(
      'HD-TICKET-0055',
      { status: 'Closed', description: "Fixed by Mike's Plumbing on 2026-03-30" }
    );
  });

  it('does not call updateWorkOrder when no update fields are passed', async () => {
    // Simulate model passing only ticketName with no other fields
    mockCreate
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant', content: null,
            tool_calls: [{
              id:   'call_test_err',
              type: 'function',
              function: {
                name:      'update_work_order',
                arguments: JSON.stringify({ ticketName: 'HD-TICKET-0099' }),
              },
            }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Error reported.' } }],
      });


    const reply = await chat('Update HD-TICKET-0099', []);
    // The executor throws → model receives the error result and replies normally
    expect(reply).toBe('Error reported.');
    expect(pmsClient.updateWorkOrder).not.toHaveBeenCalled();
  });
});
