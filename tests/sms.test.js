'use strict';

/**
 * Tests for the SMS dispatcher (Twilio backend).
 * ERPNext has no outbound SMS API; Twilio is the sole transport.
 */

jest.mock('axios');
const axios = require('axios');
const { send, templates } = require('../src/sms/dispatcher');

const TWILIO_URL = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`;

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Twilio transport ─────────────────────────────────────────────────────────

describe('send() – Twilio', () => {
  it('POSTs to the Twilio Messages endpoint with correct params', async () => {
    axios.post.mockResolvedValue({ data: { sid: 'SM123', status: 'queued' } });

    const result = await send({ phone: '+15550001234', message: 'Your rent is due.' });

    expect(axios.post).toHaveBeenCalledWith(
      TWILIO_URL,
      expect.stringContaining('To=%2B15550001234'),
      expect.objectContaining({
        auth: {
          username: process.env.TWILIO_ACCOUNT_SID,
          password: process.env.TWILIO_AUTH_TOKEN,
        },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    );
    expect(result.sid).toBe('SM123');
  });

  it('includes the From number and message body in the POST', async () => {
    axios.post.mockResolvedValue({ data: { sid: 'SM456' } });

    await send({ phone: '+15559998888', message: 'Test message' });

    const [, body] = axios.post.mock.calls[0];
    expect(body).toContain(`From=${encodeURIComponent(process.env.TWILIO_FROM_NUMBER)}`);
    expect(body).toContain('Body=Test+message');
  });

  it('throws when phone is missing', async () => {
    await expect(send({ message: 'Hello' })).rejects.toThrow('phone is required');
  });

  it('throws when message is missing', async () => {
    await expect(send({ phone: '+15550001234' })).rejects.toThrow('message is required');
  });

  it('accepts optional tenantId for log context without error', async () => {
    axios.post.mockResolvedValue({ data: { sid: 'SM789' } });
    await expect(
      send({ tenantId: 'CUST-0001', phone: '+15550001234', message: 'Hi' })
    ).resolves.not.toThrow();
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
    const msg = templates.rentReminder({ unit: 'Unit 2B', amountDue: 1500, dueDate: '2026-03-01' });
    expect(msg).toContain('2026-03-01');
    expect(msg).toContain('$1500');
  });

  it('maintenanceScheduled includes scheduled date', () => {
    const msg = templates.maintenanceScheduled({
      unit: 'Unit 1A',
      description: 'Broken heater',
      scheduledDate: '2026-02-25',
    });
    expect(msg).toContain('Broken heater');
    expect(msg).toContain('2026-02-25');
  });

  it('maintenanceComplete includes unit and description', () => {
    const msg = templates.maintenanceComplete({ unit: 'Unit 1A', description: 'Broken heater' });
    expect(msg).toContain('Unit 1A');
    expect(msg).toContain('Broken heater');
    expect(msg).toContain('completed');
  });
});
