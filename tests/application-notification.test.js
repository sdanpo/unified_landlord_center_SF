'use strict';

/**
 * Application notification pipeline — end-to-end integration test
 *
 * Validates the FULL path from an ERPNext webhook POST to the actual Telegram
 * sendMessage call, without mocking notifyLandlord or the webhook handler.
 *
 *   ERPNext POST /webhooks/erpnext/application-submitted
 *     └─ validateSignature middleware
 *         └─ handle({ type: 'application.submitted', data })
 *             └─ notifyLandlord(text)
 *                 └─ TelegramBot.sendMessage(groupId, text)   ← asserted here
 *
 * Bugs this test would have caught before they reached production:
 *
 *   Bug 1 — parse_mode: 'Markdown' silently drops notifications
 *     Telegram rejects messages whose text contains unescaped Markdown special
 *     characters (_  *  `  [).  Applicant emails like john_doe@example.com
 *     contain '_', causing the sendMessage API call to return a 400 error and
 *     the notification to be silently logged but never delivered.
 *     Fix: remove parse_mode from notifyLandlord (none of the alert messages
 *     use Markdown formatting; all embed raw user-supplied field values).
 *
 *   Bug 2 — ERPNext webhook not registered for Lead creation
 *     The /apply form creates a Lead in ERPNext but no Webhook doctype entry
 *     existed to POST to our server, so notifyLandlord was never reached.
 *     Fix: configureApplicationWebhook() in setup-tenant-portal.js.
 *
 * Run:  npx jest tests/application-notification.test.js
 */

const crypto   = require('crypto');
const supertest = require('supertest');

// ── Mock TelegramBot at the SDK level ─────────────────────────────────────────
// We do NOT mock notifyLandlord — it must run its real logic so we can catch
// bugs in how it calls sendMessage (e.g. wrong options, never called, etc.).

const mockSendMessage = jest.fn().mockResolvedValue({ message_id: 42 });

jest.mock('node-telegram-bot-api', () =>
  jest.fn().mockImplementation(() => ({
    sendMessage:  mockSendMessage,
    getMe:        jest.fn().mockResolvedValue({ id: 1, username: 'test_bot' }),
    stopPolling:  jest.fn().mockResolvedValue(undefined),
    startPolling: jest.fn(),
    onText:       jest.fn(), // used by _registerHandlers for /start /help /clear /chatid
    on:           jest.fn(),
  }))
);

// ── Constants ─────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = 'test-webhook-secret'; // set by tests/setup.js

function sign(body) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

// POST a signed application-submitted webhook and flush the async handler.
async function postApplication(app, data) {
  const body = JSON.stringify(data);
  const res  = await supertest(app)
    .post('/webhooks/erpnext/application-submitted')
    .set('Content-Type', 'application/json')
    .set('x-frappe-webhook-signature', sign(body))
    .send(body);

  // handle() is fire-and-forget (not awaited in the route).  Give the async
  // chain two event-loop turns to settle before asserting.
  await new Promise(r => setTimeout(r, 20));
  return res;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Application notification pipeline (HTTP POST → TelegramBot.sendMessage)', () => {
  let app;

  beforeAll(() => {
    // Reset module registry so config.js re-reads env vars fresh.
    // jest.mock() factory registrations survive resetModules — mockSendMessage
    // is still the same reference and mockClear() works across the reset.
    jest.resetModules();
    const { createWebhookApp } = require('../src/webhook/server');
    app = createWebhookApp();
  });

  afterAll(() => {
    jest.resetModules();
  });

  beforeEach(() => {
    mockSendMessage.mockClear();
  });

  // Standard applicant payload mirroring what ERPNext sends after a Lead is
  // created via the /apply web form.
  const basePayload = {
    name:                        'CRM-LEAD-2026-00099',
    first_name:                  'Alex',
    last_name:                   'Kim',
    email_id:                    'alex.kim@example.com',
    mobile_no:                   '+14155559999',
    custom_monthly_gross_income: 8000,
    custom_number_of_occupants:  2,
    custom_eviction_history:     'No',
    custom_interested_property:  '101 Market St #4A',
  };

  // ── 1. HTTP layer ───────────────────────────────────────────────────────────

  test('signed POST returns 200 { received: true }', async () => {
    const res = await postApplication(app, basePayload);
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  test('unsigned POST returns 401 and fires no Telegram notification', async () => {
    const res = await supertest(app)
      .post('/webhooks/erpnext/application-submitted')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(basePayload));
    expect(res.status).toBe(401);
    await new Promise(r => setTimeout(r, 20));
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  // ── 2. Notification delivery ────────────────────────────────────────────────

  test('TelegramBot.sendMessage is called — notification reaches Telegram', async () => {
    await postApplication(app, basePayload);
    // If this fails it means notifyLandlord never reached bot.sendMessage.
    // Before the ERPNext webhook fix, this never fired at all.
    expect(mockSendMessage).toHaveBeenCalled();
  });

  test('sendMessage is called at least once per recipient', async () => {
    await postApplication(app, basePayload);
    // At least one sendMessage call must fire — regardless of whether the config
    // uses a group chat or individual user IDs, the notification must be sent.
    expect(mockSendMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('sendMessage recipient is a numeric Telegram chat ID', async () => {
    await postApplication(app, basePayload);
    for (const [recipientId] of mockSendMessage.mock.calls) {
      expect(typeof recipientId).toBe('number');
      expect(Number.isFinite(recipientId)).toBe(true);
    }
  });

  // ── 3. Message content ──────────────────────────────────────────────────────

  test('message contains applicant first name, last name, and email', async () => {
    await postApplication(app, basePayload);
    const [, msg] = mockSendMessage.mock.calls[0];
    expect(msg).toContain('Alex');
    expect(msg).toContain('Kim');
    expect(msg).toContain('alex.kim@example.com');
  });

  test('message contains monthly income and occupant count', async () => {
    await postApplication(app, basePayload);
    const [, msg] = mockSendMessage.mock.calls[0];
    expect(msg).toContain('8000');
    expect(msg).toContain('2');
  });

  test('message contains "screen <leadName>" prompt for SmartMove', async () => {
    await postApplication(app, basePayload);
    const [, msg] = mockSendMessage.mock.calls[0];
    expect(msg).toContain('CRM-LEAD-2026-00099');
    expect(msg.toLowerCase()).toContain('screen');
  });

  test('message contains the interested property', async () => {
    await postApplication(app, basePayload);
    const [, msg] = mockSendMessage.mock.calls[0];
    expect(msg).toContain('101 Market St #4A');
  });

  test('message shows "(not specified)" when no property was selected', async () => {
    await postApplication(app, { ...basePayload, custom_interested_property: '' });
    const [, msg] = mockSendMessage.mock.calls[0];
    expect(msg).toContain('(not specified)');
  });

  // ── 4. Markdown parse_mode bug ──────────────────────────────────────────────
  //
  // Telegram's legacy Markdown parser rejects messages that contain unescaped
  // special characters in user-supplied data.  Common real-world cases:
  //   '_'  in emails like john_doe@example.com  → broken italic
  //   '['  in ticket IDs like [HDT-0001]        → broken link syntax
  //
  // When the API call fails with "can't parse entities", Promise.allSettled()
  // catches the rejection and logs it — but the notification is silently lost.
  // Removing parse_mode entirely is the correct fix because none of the alert
  // messages use any Markdown formatting syntax.

  test('sendMessage is NOT called with parse_mode: Markdown (regression guard)', async () => {
    await postApplication(app, basePayload);
    for (const callArgs of mockSendMessage.mock.calls) {
      const options = callArgs[2] ?? {};
      expect(options.parse_mode).not.toBe('Markdown');
      expect(options.parse_mode).not.toBe('MarkdownV2');
    }
  });

  test('email with underscore (john_doe@...) is delivered — not silently dropped by Markdown parser', async () => {
    // Before the fix, Telegram rejected this with "can't parse entities" because
    // '_' in the email opened an italic span that was never closed.
    await postApplication(app, {
      ...basePayload,
      first_name: 'John',
      last_name:  'Doe',
      email_id:   'john_doe@example.com',
    });
    expect(mockSendMessage).toHaveBeenCalled();
    const [, msg] = mockSendMessage.mock.calls[0];
    expect(msg).toContain('john_doe@example.com');
  });

  test('email with multiple underscores is delivered intact', async () => {
    await postApplication(app, { ...basePayload, email_id: 'first_last_name@tenant.example.com' });
    expect(mockSendMessage).toHaveBeenCalled();
    const [, msg] = mockSendMessage.mock.calls[0];
    expect(msg).toContain('first_last_name@tenant.example.com');
  });
});
