'use strict';

/**
 * Tests for the automation scheduler job functions.
 */

// Mock all external dependencies before importing scheduler
jest.mock('../src/api/index', () => ({
  getOutstandingBalances: jest.fn(),
  getStaleWorkOrders: jest.fn(),
  getWorkOrders: jest.fn(),
  getGeneralLedger: jest.fn(),
  getLeases: jest.fn(),
  sendSMS: jest.fn(),
}));

jest.mock('../src/sms/dispatcher', () => ({
  send: jest.fn().mockResolvedValue({}),
  templates: {
    rentOverdue: jest.fn().mockReturnValue('Overdue SMS text'),
  },
}));

jest.mock('../src/telegram/bot', () => ({
  notifyLandlord: jest.fn().mockResolvedValue({}),
}));

const pmsClient = require('../src/api/index');
const { notifyLandlord } = require('../src/telegram/bot');
const sms = require('../src/sms/dispatcher');
const { runOverdueRentCheck, runStaleWorkOrderCheck } = require('../src/automation/scheduler');

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── runOverdueRentCheck ──────────────────────────────────────────────────────

describe('runOverdueRentCheck()', () => {
  it('sends SMS to each delinquent tenant and notifies the landlord', async () => {
    pmsClient.getOutstandingBalances.mockResolvedValue([
      { tenantId: 't1', tenantName: 'John Doe', unitName: 'Unit 3A', propertyAddress: '123 Main', amountDue: 1200, daysOverdue: 5 },
      { tenantId: 't2', tenantName: 'Jane Smith', unitName: 'Unit 5B', propertyAddress: '123 Main', amountDue: 900, daysOverdue: 2 },
    ]);

    await runOverdueRentCheck();

    expect(sms.send).toHaveBeenCalledTimes(2);
    expect(notifyLandlord).toHaveBeenCalledTimes(1);
    const alertText = notifyLandlord.mock.calls[0][0];
    expect(alertText).toContain('2 tenant(s)');
  });

  it('does not send SMS when all balances are current', async () => {
    pmsClient.getOutstandingBalances.mockResolvedValue([]);

    await runOverdueRentCheck();

    expect(sms.send).not.toHaveBeenCalled();
    expect(notifyLandlord).not.toHaveBeenCalled();
  });

  it('notifies landlord of error when PMS call fails', async () => {
    pmsClient.getOutstandingBalances.mockRejectedValue(new Error('API down'));

    await runOverdueRentCheck();

    expect(notifyLandlord).toHaveBeenCalledTimes(1);
    const errorMsg = notifyLandlord.mock.calls[0][0];
    expect(errorMsg).toContain('failed');
  });

  it('handles data wrapped in a .data envelope', async () => {
    pmsClient.getOutstandingBalances.mockResolvedValue({
      data: [
        { tenantId: 't3', tenantName: 'Bob', unitName: 'Unit 1C', amountDue: 500, daysOverdue: 1 },
      ],
    });

    await runOverdueRentCheck();

    expect(sms.send).toHaveBeenCalledTimes(1);
  });
});

// ─── runStaleWorkOrderCheck ───────────────────────────────────────────────────

describe('runStaleWorkOrderCheck()', () => {
  it('sends Telegram alert for stale work orders', async () => {
    const twoDaysAgo = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    pmsClient.getStaleWorkOrders.mockResolvedValue([
      { id: 'WO1', unit: 'Unit 4B', description: 'Plumbing leak', createdAt: twoDaysAgo, vendorName: 'PlumbCo' },
    ]);

    await runStaleWorkOrderCheck();

    expect(notifyLandlord).toHaveBeenCalledTimes(1);
    const alertText = notifyLandlord.mock.calls[0][0];
    expect(alertText).toContain('WO1');
    expect(alertText).toContain('Unit 4B');
  });

  it('stays silent when there are no stale work orders', async () => {
    pmsClient.getStaleWorkOrders.mockResolvedValue([]);

    await runStaleWorkOrderCheck();

    expect(notifyLandlord).not.toHaveBeenCalled();
  });
});
