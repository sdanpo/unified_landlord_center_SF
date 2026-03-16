'use strict';

/**
 * Comprehensive scheduler tests covering:
 *   – runLeaseRenewalCheck  (milestone dedup, SMS, Telegram, ERPNext update)
 *   – runLateFeeCheck       (grace period, percentage vs flat, dedup, SMS on first day)
 */

// ─── Top-level mocks (required by Jest hoisting) ─────────────────────────────

const mockNotifyLandlord = jest.fn().mockResolvedValue(undefined);
const mockSmsSend        = jest.fn().mockResolvedValue({ sid: 'SM_TEST' });
const mockLeaseRenewalNotice = jest.fn(({ tenantName, daysLeft }) => `${tenantName}: ${daysLeft} days`);
const mockLateFeeCharged     = jest.fn(({ feeAmount }) => `Late fee: $${feeAmount}`);

const mockApi = {
  getExpiringLeases:           jest.fn(),
  getOutstandingBalances:      jest.fn(),
  getLease:                    jest.fn(),
  getTenant:                   jest.fn().mockResolvedValue({ mobile_no: '+14155551001' }),
  getTodayLateFeeForInvoice:   jest.fn().mockResolvedValue(false),
  hasAnyLateFeeForInvoice:     jest.fn().mockResolvedValue(false),
  createLateFeeInvoice:        jest.fn().mockResolvedValue({ name: 'SINV-LATEFEE-001' }),
  updateLease:                 jest.fn().mockResolvedValue({ name: 'ok' }),
};

jest.mock('../src/telegram/bot',   () => ({ notifyLandlord: mockNotifyLandlord }));
jest.mock('../src/sms/dispatcher', () => ({
  send:      mockSmsSend,
  templates: {
    leaseRenewalNotice: mockLeaseRenewalNotice,
    lateFeeCharged:     mockLateFeeCharged,
  },
}));
jest.mock('../src/api/index', () => mockApi);

const { runLeaseRenewalCheck, runLateFeeCheck } = require('../src/automation/scheduler');

beforeEach(() => {
  jest.clearAllMocks();
  // Restore default resolved values that some tests override
  mockApi.getTenant.mockResolvedValue({ mobile_no: '+14155551001' });
  mockApi.getTodayLateFeeForInvoice.mockResolvedValue(false);
  mockApi.hasAnyLateFeeForInvoice.mockResolvedValue(false);
  mockApi.createLateFeeInvoice.mockResolvedValue({ name: 'SINV-LATEFEE-001' });
  mockApi.updateLease.mockResolvedValue({ name: 'ok' });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysFromNow(n) {
  return new Date(Date.now() + n * 86_400_000).toISOString().split('T')[0];
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString().split('T')[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// runLeaseRenewalCheck
// ─────────────────────────────────────────────────────────────────────────────

describe('runLeaseRenewalCheck()', () => {
  test('does nothing when there are no expiring leases', async () => {
    mockApi.getExpiringLeases.mockResolvedValue([]);
    await runLeaseRenewalCheck();
    expect(mockSmsSend).not.toHaveBeenCalled();
    expect(mockNotifyLandlord).not.toHaveBeenCalled();
  });

  test('does nothing when no leases hit a milestone (e.g. 45 days)', async () => {
    mockApi.getExpiringLeases.mockResolvedValue([
      { name: 'L-001', end_date: daysFromNow(45), lease_customer: 'Maria Garcia', property: '512 Maple' },
    ]);
    await runLeaseRenewalCheck();
    expect(mockSmsSend).not.toHaveBeenCalled();
  });

  test.each([90, 60, 30, 14])('sends SMS and Telegram at the %d-day milestone', async (days) => {
    mockApi.getExpiringLeases.mockResolvedValue([
      { name: 'L-001', end_date: daysFromNow(days), lease_customer: 'Maria Garcia', property: '512 Maple' },
    ]);
    await runLeaseRenewalCheck();
    expect(mockSmsSend).toHaveBeenCalledTimes(1);
    expect(mockNotifyLandlord).toHaveBeenCalledTimes(1);
  });

  test('skips lease where renewal notice was sent within last 30 days', async () => {
    mockApi.getExpiringLeases.mockResolvedValue([
      {
        name: 'L-001', end_date: daysFromNow(30),
        lease_customer: 'Maria Garcia', property: '512 Maple',
        custom_renewal_notice_sent: daysAgo(5),   // sent 5 days ago
      },
    ]);
    await runLeaseRenewalCheck();
    expect(mockSmsSend).not.toHaveBeenCalled();
  });

  test('sends notice when last notice was >30 days ago', async () => {
    mockApi.getExpiringLeases.mockResolvedValue([
      {
        name: 'L-001', end_date: daysFromNow(30),
        lease_customer: 'Maria Garcia', property: '512 Maple',
        custom_renewal_notice_sent: daysAgo(35),  // old enough to resend
      },
    ]);
    await runLeaseRenewalCheck();
    expect(mockSmsSend).toHaveBeenCalledTimes(1);
  });

  test('marks custom_renewal_notice_sent on the Lease after sending', async () => {
    mockApi.getExpiringLeases.mockResolvedValue([
      { name: 'L-001', end_date: daysFromNow(14), lease_customer: 'Maria Garcia', property: '512 Maple' },
    ]);
    await runLeaseRenewalCheck();
    expect(mockApi.updateLease).toHaveBeenCalledWith('L-001',
      expect.objectContaining({ custom_renewal_notice_sent: expect.stringMatching(/\d{4}-\d{2}-\d{2}/) })
    );
  });

  test('skips SMS when tenant has no phone but still sends Telegram', async () => {
    mockApi.getTenant.mockResolvedValue({ mobile_no: '' });
    mockApi.getExpiringLeases.mockResolvedValue([
      { name: 'L-001', end_date: daysFromNow(30), lease_customer: 'Maria Garcia', property: '512 Maple' },
    ]);
    await runLeaseRenewalCheck();
    expect(mockSmsSend).not.toHaveBeenCalled();
    expect(mockNotifyLandlord).toHaveBeenCalled();
  });

  test('Telegram summary contains tenant name and days left', async () => {
    mockApi.getExpiringLeases.mockResolvedValue([
      { name: 'L-001', end_date: daysFromNow(60), lease_customer: 'James Wilson', property: '229 Watson' },
    ]);
    await runLeaseRenewalCheck();
    const msg = mockNotifyLandlord.mock.calls[0][0];
    expect(msg).toContain('James Wilson');
    expect(msg).toContain('60');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runLateFeeCheck
// ─────────────────────────────────────────────────────────────────────────────

describe('runLateFeeCheck()', () => {
  test('does nothing when there are no outstanding invoices', async () => {
    mockApi.getOutstandingBalances.mockResolvedValue([]);
    await runLateFeeCheck();
    expect(mockApi.createLateFeeInvoice).not.toHaveBeenCalled();
  });

  test('skips invoice with no linked Lease', async () => {
    mockApi.getOutstandingBalances.mockResolvedValue([
      { name: 'SINV-001', customer: 'Maria Garcia', due_date: daysAgo(10) }, // no custom_lease
    ]);
    await runLateFeeCheck();
    expect(mockApi.createLateFeeInvoice).not.toHaveBeenCalled();
  });

  test('skips invoice still within grace period (3 days overdue, 5-day grace)', async () => {
    mockApi.getOutstandingBalances.mockResolvedValue([
      { name: 'SINV-001', customer: 'Maria Garcia', due_date: daysAgo(3), custom_lease: 'L-001' },
    ]);
    mockApi.getLease.mockResolvedValue({
      name: 'L-001', custom_late_fee_grace_days: 5,
      custom_late_fee_type: 'Percentage', late_payment_interest_percentage: 5,
    });
    await runLateFeeCheck();
    expect(mockApi.createLateFeeInvoice).not.toHaveBeenCalled();
  });

  test('creates a percentage-based late fee after grace period', async () => {
    mockApi.getOutstandingBalances.mockResolvedValue([
      { name: 'SINV-001', customer: 'Maria Garcia', customer_name: 'Maria Garcia',
        due_date: daysAgo(8), custom_lease: 'L-001',
        outstanding_amount: 2800, custom_unit: 'Unit 1A' },
    ]);
    mockApi.getLease.mockResolvedValue({
      name: 'L-001', custom_late_fee_grace_days: 5,
      custom_late_fee_type: 'Percentage', late_payment_interest_percentage: 5,
    });
    await runLateFeeCheck();
    expect(mockApi.createLateFeeInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        feeAmount: 2800 * 0.05,   // 5% of $2800 = $140
        originalInvoiceName: 'SINV-001',
      })
    );
  });

  test('creates a flat-amount late fee after grace period', async () => {
    mockApi.getOutstandingBalances.mockResolvedValue([
      { name: 'SINV-001', customer: 'Maria Garcia', customer_name: 'Maria Garcia',
        due_date: daysAgo(8), custom_lease: 'L-001',
        outstanding_amount: 2800, custom_unit: 'Unit 1A' },
    ]);
    mockApi.getLease.mockResolvedValue({
      name: 'L-001', custom_late_fee_grace_days: 5,
      custom_late_fee_type: 'Flat Amount', custom_late_fee_flat_amount: 75,
    });
    await runLateFeeCheck();
    expect(mockApi.createLateFeeInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ feeAmount: 75 })
    );
  });

  test('skips creation when invoice already has a late fee today (dedup)', async () => {
    mockApi.getOutstandingBalances.mockResolvedValue([
      { name: 'SINV-001', customer: 'Maria Garcia',
        due_date: daysAgo(10), custom_lease: 'L-001', outstanding_amount: 2800 },
    ]);
    mockApi.getLease.mockResolvedValue({
      name: 'L-001', custom_late_fee_grace_days: 5,
      custom_late_fee_type: 'Percentage', late_payment_interest_percentage: 5,
    });
    mockApi.getTodayLateFeeForInvoice.mockResolvedValue(true);  // already charged today
    await runLateFeeCheck();
    expect(mockApi.createLateFeeInvoice).not.toHaveBeenCalled();
  });

  test('sends SMS on the first day a late fee is charged', async () => {
    mockApi.getOutstandingBalances.mockResolvedValue([
      { name: 'SINV-001', customer: 'Maria Garcia', customer_name: 'Maria Garcia',
        due_date: daysAgo(10), custom_lease: 'L-001',
        outstanding_amount: 2800, custom_unit: 'Unit 1A' },
    ]);
    mockApi.getLease.mockResolvedValue({
      name: 'L-001', custom_late_fee_grace_days: 5,
      custom_late_fee_type: 'Flat Amount', custom_late_fee_flat_amount: 50,
    });
    mockApi.hasAnyLateFeeForInvoice.mockResolvedValue(false); // first day
    await runLateFeeCheck();
    expect(mockSmsSend).toHaveBeenCalledTimes(1);
  });

  test('skips SMS on subsequent late fee days (avoids daily fatigue)', async () => {
    mockApi.getOutstandingBalances.mockResolvedValue([
      { name: 'SINV-001', customer: 'Maria Garcia', customer_name: 'Maria Garcia',
        due_date: daysAgo(10), custom_lease: 'L-001',
        outstanding_amount: 2800, custom_unit: 'Unit 1A' },
    ]);
    mockApi.getLease.mockResolvedValue({
      name: 'L-001', custom_late_fee_grace_days: 5,
      custom_late_fee_type: 'Flat Amount', custom_late_fee_flat_amount: 50,
    });
    mockApi.hasAnyLateFeeForInvoice.mockResolvedValue(true); // not the first day
    await runLateFeeCheck();
    expect(mockSmsSend).not.toHaveBeenCalled();
    expect(mockApi.createLateFeeInvoice).toHaveBeenCalled(); // still creates the invoice
  });

  test('sends Telegram summary listing all applied late fees', async () => {
    mockApi.getOutstandingBalances.mockResolvedValue([
      { name: 'SINV-001', customer: 'Maria Garcia', customer_name: 'Maria Garcia',
        due_date: daysAgo(10), custom_lease: 'L-001',
        outstanding_amount: 2800, custom_unit: 'Unit 1A' },
    ]);
    mockApi.getLease.mockResolvedValue({
      name: 'L-001', custom_late_fee_grace_days: 5,
      custom_late_fee_type: 'Flat Amount', custom_late_fee_flat_amount: 50,
    });
    await runLateFeeCheck();
    expect(mockNotifyLandlord).toHaveBeenCalled();
    const msg = mockNotifyLandlord.mock.calls[0][0];
    expect(msg).toContain('Maria Garcia');
  });

  test('does not send Telegram summary when no late fees were applied', async () => {
    mockApi.getOutstandingBalances.mockResolvedValue([]);
    await runLateFeeCheck();
    expect(mockNotifyLandlord).not.toHaveBeenCalled();
  });
});
