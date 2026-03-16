'use strict';

/**
 * Unit tests for src/webhook/handlers.js
 *
 * Covers every event type routed through handle():
 *   rent.overdue, payment.received, payment.pending, payment.failed,
 *   workorder.created, lease.created, lease.expired,
 *   application.submitted, lease.signed, <unknown>
 */

const mockNotify = jest.fn().mockResolvedValue(undefined);
const mockSmsSend = jest.fn().mockResolvedValue({ sid: 'SM_TEST' });
const mockTemplates = {
  leaseSignedConfirmation: jest.fn(({ unit, startDate }) =>
    `Your lease for ${unit} starting ${startDate} is fully signed.`
  ),
};

jest.mock('../src/telegram/bot', () => ({ notifyLandlord: mockNotify }));
jest.mock('../src/sms/dispatcher', () => ({
  send:      mockSmsSend,
  templates: mockTemplates,
}));

const { handle } = require('../src/webhook/handlers');

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── rent.overdue ─────────────────────────────────────────────────────────────

describe('handle({ type: "rent.overdue" })', () => {
  test('sends Telegram alert with tenant name, unit, and amount', async () => {
    await handle({
      type: 'rent.overdue',
      data: { tenantName: 'Maria Garcia', unitName: '512 Maple St, Unit 1A', amountDue: 2800 },
    });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain('Maria Garcia');
    expect(msg).toContain('2800');
    expect(msg).toContain('512 Maple St');
  });
});

// ─── payment.received ────────────────────────────────────────────────────────

describe('handle({ type: "payment.received" })', () => {
  test('includes tenant name, amount, and payment method', async () => {
    await handle({
      type: 'payment.received',
      data: { tenantName: 'James Wilson', amountPaid: 4500, paymentMethod: 'ACH bank transfer' },
    });
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain('James Wilson');
    expect(msg).toContain('4500');
    expect(msg).toContain('ACH bank transfer');
  });

  test('omits "via" clause when paymentMethod is not provided', async () => {
    await handle({
      type: 'payment.received',
      data: { tenantName: 'Priya Patel', amountPaid: 2200 },
    });
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain('Priya Patel');
    expect(msg).toContain('2200');
    expect(msg).not.toContain('undefined');
  });
});

// ─── payment.pending ─────────────────────────────────────────────────────────

describe('handle({ type: "payment.pending" })', () => {
  test('sends an ACH-pending Telegram message with invoice name and amount', async () => {
    await handle({
      type: 'payment.pending',
      data: { tenantName: 'Chen Wei', amount: '$1800.00', invoiceName: 'SINV-0001' },
    });
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain('Chen Wei');
    expect(msg).toContain('SINV-0001');
    expect(msg).toMatch(/pending|ACH/i);
  });
});

// ─── payment.failed ──────────────────────────────────────────────────────────

describe('handle({ type: "payment.failed" })', () => {
  test('sends a failure Telegram message with tenant and invoice', async () => {
    await handle({
      type: 'payment.failed',
      data: { tenantName: 'Rotem Porat', amount: '$2500.00', invoiceName: 'SINV-0002' },
    });
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain('Rotem Porat');
    expect(msg).toContain('SINV-0002');
    expect(msg).toMatch(/fail|FAIL/i);
  });
});

// ─── workorder.created ────────────────────────────────────────────────────────

describe('handle({ type: "workorder.created" })', () => {
  test('sends ticket ID, subject, and tenant name', async () => {
    await handle({
      type: 'workorder.created',
      data: { ticketId: 'HDT-0042', subject: 'Broken heater', tenantName: 'Maria Garcia' },
    });
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain('HDT-0042');
    expect(msg).toContain('Broken heater');
    expect(msg).toContain('Maria Garcia');
  });
});

// ─── lease.created ───────────────────────────────────────────────────────────

describe('handle({ type: "lease.created" })', () => {
  test('sends tenant name and unit name', async () => {
    await handle({
      type: 'lease.created',
      data: { tenantName: 'Maria Garcia', unitName: '512 Maple St, Unit 1A' },
    });
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain('Maria Garcia');
    expect(msg).toContain('512 Maple St');
  });
});

// ─── lease.expired ───────────────────────────────────────────────────────────

describe('handle({ type: "lease.expired" })', () => {
  test('sends tenant name and unit', async () => {
    await handle({
      type: 'lease.expired',
      data: { tenantName: 'Priya Patel', unitName: '229 Watson Drive' },
    });
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain('Priya Patel');
    expect(msg).toContain('229 Watson Drive');
  });
});

// ─── application.submitted ───────────────────────────────────────────────────

describe('handle({ type: "application.submitted" })', () => {
  const app = {
    leadName: 'LEAD-0001',
    firstName: 'Alex',
    lastName: 'Kim',
    email: 'alex.kim@example.com',
    phone: '+14155559999',
    monthlyIncome: 8000,
    occupants: 2,
    hasEviction: 'No',
    interestedProperty: '101 Market St #4A',
  };

  test('sends applicant name, email, income, and occupant count', async () => {
    await handle({ type: 'application.submitted', data: app });
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain('Alex');
    expect(msg).toContain('Kim');
    expect(msg).toContain('alex.kim@example.com');
    expect(msg).toContain('8000');
    expect(msg).toContain('2');
  });

  test('includes "screen" prompt with leadName so landlord can trigger SmartMove', async () => {
    await handle({ type: 'application.submitted', data: app });
    const msg = mockNotify.mock.calls[0][0];
    expect(msg.toLowerCase()).toContain('screen');
    expect(msg).toContain('LEAD-0001');
  });

  test('includes eviction history field', async () => {
    await handle({ type: 'application.submitted', data: app });
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain('No'); // hasEviction
  });

  test('includes interested property in notification', async () => {
    await handle({ type: 'application.submitted', data: app });
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain('101 Market St #4A');
  });

  test('shows "(not specified)" when interestedProperty is absent', async () => {
    const appNoProperty = { ...app, interestedProperty: '' };
    await handle({ type: 'application.submitted', data: appNoProperty });
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain('(not specified)');
  });
});

// ─── lease.signed ────────────────────────────────────────────────────────────

describe('handle({ type: "lease.signed" })', () => {
  const data = {
    tenantName: 'Maria Garcia',
    tenantPhone: '+14155551001',
    unitName: '512 Maple St, Unit 1A',
    startDate: '2026-07-01',
  };

  test('sends Telegram alert confirming all signatures received', async () => {
    await handle({ type: 'lease.signed', data });
    const msg = mockNotify.mock.calls[0][0];
    expect(msg).toContain('Maria Garcia');
    expect(msg).toContain('512 Maple St');
    expect(msg.toLowerCase()).toContain('sign');
  });

  test('sends SMS to tenant phone using leaseSignedConfirmation template', async () => {
    await handle({ type: 'lease.signed', data });
    expect(mockTemplates.leaseSignedConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ unit: data.unitName, startDate: data.startDate })
    );
    expect(mockSmsSend).toHaveBeenCalledWith('+14155551001', expect.any(String));
  });

  test('skips SMS send when tenantPhone is missing', async () => {
    await handle({ type: 'lease.signed', data: { ...data, tenantPhone: '' } });
    expect(mockSmsSend).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalled(); // Telegram still fires
  });
});

// ─── unknown event type ───────────────────────────────────────────────────────

describe('handle() with unknown event type', () => {
  test('does not throw and does not call notifyLandlord', async () => {
    await expect(handle({ type: 'planet.aligned', data: {} })).resolves.toBeUndefined();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
