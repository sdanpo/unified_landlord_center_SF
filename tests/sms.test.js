'use strict';

/**
 * Tests for the SMS dispatcher.
 */

jest.mock('axios');
jest.mock('../src/api/index', () => ({
  sendSMS: jest.fn().mockResolvedValue({ id: 'pms-sms-1' }),
  sendSMSToPhone: jest.fn().mockResolvedValue({ id: 'pms-sms-2' }),
}));

const axios = require('axios');
const pmsClient = require('../src/api/index');
const { send, templates } = require('../src/sms/dispatcher');

beforeEach(() => {
  jest.clearAllMocks();
  // Default: USE_TWILIO=false (from setup.js)
});

// ─── Native PMS backend ───────────────────────────────────────────────────────

describe('send() – PMS backend (USE_TWILIO=false)', () => {
  it('calls pmsClient.sendSMS() when tenantId is provided', async () => {
    await send({ tenantId: 'T1', message: 'Your rent is due.' });
    expect(pmsClient.sendSMS).toHaveBeenCalledWith('T1', 'Your rent is due.');
  });

  it('calls pmsClient.sendSMSToPhone() when only phone is provided', async () => {
    await send({ phone: '+15550001234', message: 'Your rent is due.' });
    expect(pmsClient.sendSMSToPhone).toHaveBeenCalledWith('+15550001234', 'Your rent is due.');
  });

  it('throws when neither tenantId nor phone is provided', async () => {
    await expect(send({ message: 'Hello' })).rejects.toThrow();
  });

  it('throws when message is missing', async () => {
    await expect(send({ tenantId: 'T1' })).rejects.toThrow('message is required');
  });
});

// ─── Message templates ────────────────────────────────────────────────────────

describe('SMS templates', () => {
  it('rentOverdue includes amount and unit', () => {
    const msg = templates.rentOverdue({ unit: 'Unit 3A', propertyAddress: '123 Main', amountDue: 1200 });
    expect(msg).toContain('$1200');
    expect(msg).toContain('Unit 3A');
    expect(msg).toContain('past due');
  });

  it('rentReminder includes due date', () => {
    const msg = templates.rentReminder({ unit: 'Unit 2B', amountDue: 1500, dueDate: '2026-02-01' });
    expect(msg).toContain('2026-02-01');
    expect(msg).toContain('$1500');
  });

  it('maintenanceComplete includes unit and description', () => {
    const msg = templates.maintenanceComplete({ unit: 'Unit 1A', description: 'Broken heater' });
    expect(msg).toContain('Unit 1A');
    expect(msg).toContain('Broken heater');
    expect(msg).toContain('completed');
  });
});
