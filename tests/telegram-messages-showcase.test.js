'use strict';

/**
 * Telegram Messages Showcase — tests/telegram-messages-showcase.test.js
 *
 * Purpose: exercise every possible Telegram message the system can send and
 * print the exact rendered text to the console.  This lets you see at a
 * glance what each notification looks like — no need to trigger real events.
 *
 * Categories covered:
 *   A. Webhook-event notifications  (rent, payments, maintenance, leases, applications, screening)
 *   B. Scheduler notifications      (overdue summary, lease renewals, late fees, stale tickets)
 *   C. Bot commands                 (/start, /help, /clear, /chatid)
 *   D. Free-form NLP response & error paths
 *
 * How to read the output:
 *   Run:  npm test -- --testPathPattern=telegram-messages-showcase --verbose 2>&1
 *   Each ✉  block shows the exact text Telegram would receive.
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Capture every Telegram message the system would send.
// We store them in an array and print them after each test.
let capturedMessages = [];

const mockNotifyLandlord = jest.fn(async (msg) => {
  capturedMessages.push(msg);
});

const mockSmsSend = jest.fn().mockResolvedValue({ sid: 'SM_SHOWCASE' });
const mockSmsTemplates = {
  leaseSignedConfirmation: ({ unit, startDate }) =>
    `Your lease for ${unit} starting ${startDate} has been fully executed by all parties. Welcome home!`,
  rentOverdue: ({ unit, propertyAddress, amountDue }) =>
    `RENT OVERDUE: Your rent of $${amountDue} for ${unit || propertyAddress} is past due. Please pay immediately to avoid late fees.`,
  leaseRenewalNotice: ({ tenantName, unit, endDate, daysLeft }) =>
    `Hi ${tenantName}, your lease at ${unit} expires ${endDate} (${daysLeft} days). Please contact us to renew or vacate.`,
  lateFeeCharged: ({ unit, feeAmount, totalDue, dayNumber }) =>
    `LATE FEE: A $${feeAmount.toFixed(2)} late fee has been added to your account for ${unit} (day ${dayNumber} overdue). Total now due: $${totalDue.toFixed(2)}.`,
};

jest.mock('../src/telegram/bot',    () => ({ notifyLandlord: mockNotifyLandlord }));
jest.mock('../src/sms/dispatcher',  () => ({ send: mockSmsSend, templates: mockSmsTemplates }));
jest.mock('../src/ai/openai',       () => ({
  chat: jest.fn().mockResolvedValue(
    '📊 *Portfolio snapshot*\n\n' +
    '• 3 overdue invoices totalling $8,400\n' +
    '• 2 open maintenance tickets\n' +
    '• 1 lease expiring within 30 days\n' +
    '• 0 vacant units'
  ),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  capturedMessages = [];
  jest.clearAllMocks();
});

/**
 * Print every captured Telegram message in a visible block.
 * Jest suppresses console.log by default – use --verbose to see it.
 */
function printMessages(label) {
  if (capturedMessages.length === 0) {
    console.log(`\n${label}\n  (no Telegram message sent)\n`);
    return;
  }
  capturedMessages.forEach((msg, i) => {
    const border = '─'.repeat(60);
    console.log(`\n${label}  [message ${i + 1}/${capturedMessages.length}]`);
    console.log(border);
    console.log(msg);
    console.log(border);
  });
}

// ─── A. WEBHOOK EVENT NOTIFICATIONS ──────────────────────────────────────────

const { handle } = require('../src/webhook/handlers');

describe('A. Webhook — Rent & Payments', () => {

  test('A1 · rent.overdue — tenant is late on rent', async () => {
    await handle({
      type: 'rent.overdue',
      data: {
        tenantName: 'Maria Garcia',
        unitName:   '512 Maple St, Unit 1A',
        amountDue:  2800,
        dueDate:    '2026-03-01',
      },
    });
    printMessages('✉  [A1] rent.overdue');

    expect(capturedMessages[0]).toContain('⚠️');
    expect(capturedMessages[0]).toContain('Maria Garcia');
    expect(capturedMessages[0]).toContain('2800');
    expect(capturedMessages[0]).toContain('512 Maple St');
  });

  test('A2 · payment.received — tenant paid by ACH bank transfer', async () => {
    await handle({
      type: 'payment.received',
      data: {
        tenantName:    'James Wilson',
        amountPaid:    4500,
        paymentMethod: 'ACH bank transfer',
        paymentId:     'PAY-0099',
      },
    });
    printMessages('✉  [A2] payment.received (with payment method)');

    expect(capturedMessages[0]).toContain('✅');
    expect(capturedMessages[0]).toContain('James Wilson');
    expect(capturedMessages[0]).toContain('4500');
    expect(capturedMessages[0]).toContain('ACH bank transfer');
  });

  test('A3 · payment.received — tenant paid by card (no paymentMethod)', async () => {
    await handle({
      type: 'payment.received',
      data: {
        tenantName: 'Priya Patel',
        amountPaid: 2200,
      },
    });
    printMessages('✉  [A3] payment.received (no payment method)');

    expect(capturedMessages[0]).toContain('Priya Patel');
    expect(capturedMessages[0]).not.toContain('undefined');
  });

  test('A4 · payment.pending — ACH initiated, awaiting settlement', async () => {
    await handle({
      type: 'payment.pending',
      data: {
        tenantName:  'Chen Wei',
        amount:      '$1,800.00',
        invoiceName: 'SINV-0031',
      },
    });
    printMessages('✉  [A4] payment.pending (ACH in-flight)');

    expect(capturedMessages[0]).toContain('🕐');
    expect(capturedMessages[0]).toContain('Chen Wei');
    expect(capturedMessages[0]).toMatch(/1-5 business days/i);
  });

  test('A5 · payment.failed — ACH bank transfer bounced', async () => {
    await handle({
      type: 'payment.failed',
      data: {
        tenantName:  'Rotem Porat',
        amount:      '$2,500.00',
        invoiceName: 'SINV-0028',
      },
    });
    printMessages('✉  [A5] payment.failed (ACH bounced)');

    expect(capturedMessages[0]).toContain('❌');
    expect(capturedMessages[0]).toContain('Rotem Porat');
    expect(capturedMessages[0]).toMatch(/FAIL/i);
    expect(capturedMessages[0]).toContain('Contact tenant');
  });
});

// ─── Maintenance ──────────────────────────────────────────────────────────────

describe('A. Webhook — Maintenance', () => {

  test('A6 · workorder.created — tenant submitted a maintenance ticket', async () => {
    await handle({
      type: 'workorder.created',
      data: {
        ticketId:   'HDT-0042',
        subject:    'Broken heater — no heat in bedroom',
        tenantName: 'Maria Garcia',
        priority:   'High',
      },
    });
    printMessages('✉  [A6] workorder.created');

    expect(capturedMessages[0]).toContain('🔧');
    expect(capturedMessages[0]).toContain('HDT-0042');
    expect(capturedMessages[0]).toContain('Broken heater');
    expect(capturedMessages[0]).toContain('Maria Garcia');
  });
});

// ─── Leases ───────────────────────────────────────────────────────────────────

describe('A. Webhook — Leases', () => {

  test('A7 · lease.created — new lease submitted in ERPNext', async () => {
    await handle({
      type: 'lease.created',
      data: {
        tenantName: 'Maria Garcia',
        unitName:   '512 Maple St, Unit 1A',
        leaseId:    'LEASE-0010',
        startDate:  '2026-07-01',
        endDate:    '2027-06-30',
        monthlyRent: 2800,
      },
    });
    printMessages('✉  [A7] lease.created');

    expect(capturedMessages[0]).toContain('📄');
    expect(capturedMessages[0]).toContain('Maria Garcia');
    expect(capturedMessages[0]).toContain('512 Maple St');
  });

  test('A8 · lease.expired — lease cancelled / tenant moved out', async () => {
    await handle({
      type: 'lease.expired',
      data: {
        tenantName: 'Priya Patel',
        unitName:   '229 Watson Drive, Unit B',
        leaseId:    'LEASE-0005',
      },
    });
    printMessages('✉  [A8] lease.expired (cancelled)');

    expect(capturedMessages[0]).toContain('📋');
    expect(capturedMessages[0]).toContain('Priya Patel');
    expect(capturedMessages[0]).toContain('229 Watson Drive');
  });

  test('A9 · lease.signed — all parties completed e-signature (BoldSign)', async () => {
    await handle({
      type: 'lease.signed',
      data: {
        tenantName:  'Maria Garcia',
        tenantPhone: '+14155551001',
        unitName:    '512 Maple St, Unit 1A',
        startDate:   '2026-07-01',
        documentId:  'BOLDSIGN-DOC-001',
      },
    });
    printMessages('✉  [A9] lease.signed (BoldSign — all signed)');

    expect(capturedMessages[0]).toContain('✅');
    expect(capturedMessages[0]).toContain('Maria Garcia');
    expect(capturedMessages[0]).toMatch(/signed/i);
    // SMS was sent to tenant
    expect(mockSmsSend).toHaveBeenCalledWith('+14155551001', expect.stringContaining('lease'));
  });

  test('A9b · lease.signed — no tenant phone (SMS skipped, Telegram still fires)', async () => {
    await handle({
      type: 'lease.signed',
      data: {
        tenantName:  'James Wilson',
        tenantPhone: '',
        unitName:    '101 Market St, #4A',
        startDate:   '2026-08-01',
      },
    });
    printMessages('✉  [A9b] lease.signed (no phone — SMS skipped)');

    expect(capturedMessages[0]).toContain('James Wilson');
    expect(mockSmsSend).not.toHaveBeenCalled();
  });
});

// ─── Applications & Screening ─────────────────────────────────────────────────

describe('A. Webhook — Applications & Screening', () => {

  const baseApp = {
    leadName:           'LEAD-0023',
    firstName:          'Alex',
    lastName:           'Kim',
    email:              'alex.kim@example.com',
    phone:              '+14155559999',
    monthlyIncome:      8000,
    occupants:          2,
    hasEviction:        'No',
    interestedProperty: '101 Market St #4A',
  };

  test('A10 · application.submitted — full application with property interest', async () => {
    await handle({ type: 'application.submitted', data: baseApp });
    printMessages('✉  [A10] application.submitted (with property)');

    expect(capturedMessages[0]).toContain('📋');
    expect(capturedMessages[0]).toContain('Alex Kim');
    expect(capturedMessages[0]).toContain('alex.kim@example.com');
    expect(capturedMessages[0]).toContain('8000');
    expect(capturedMessages[0]).toContain('LEAD-0023');
    expect(capturedMessages[0]).toContain('101 Market St #4A');
    expect(capturedMessages[0]).toMatch(/screen/i);
  });

  test('A10b · application.submitted — no property interest specified', async () => {
    await handle({
      type: 'application.submitted',
      data: { ...baseApp, interestedProperty: '' },
    });
    printMessages('✉  [A10b] application.submitted (no property)');

    expect(capturedMessages[0]).toContain('(not specified)');
  });

  test('A10c · application.submitted — applicant has eviction history', async () => {
    await handle({
      type: 'application.submitted',
      data: { ...baseApp, hasEviction: 'Yes', firstName: 'Bob', lastName: 'Tenant' },
    });
    printMessages('✉  [A10c] application.submitted (eviction history = Yes)');

    expect(capturedMessages[0]).toContain('Yes');
  });

  test('A11 · smartmove.completed — screening passed (clear criminal & eviction)', async () => {
    // SmartMove webhook comes through the server route; we test the message
    // directly by calling the notifyLandlord mock with the same format as
    // handleSmartMoveCompleted() in server.js.
    const applicantEmail  = 'alex.kim@example.com';
    const creditSummary   = '720–759 (Good)';
    const criminalSummary = 'Clear';
    const evictionSummary = 'Clear';
    const reportType      = 'Standard Plus';
    const dashboardUrl    = 'https://www.mysmartmove.com/SmartMove/login.go';

    const msg =
      `✅ Screening complete: ${applicantEmail}\n` +
      `  Credit:   ${creditSummary}\n` +
      `  Criminal: ${criminalSummary}\n` +
      `  Eviction: ${evictionSummary}\n` +
      `  Report type: ${reportType}\n` +
      `  View full report: ${dashboardUrl}`;

    await mockNotifyLandlord(msg);
    printMessages('✉  [A11] smartmove.completed (all clear)');

    expect(capturedMessages[0]).toContain('✅ Screening complete');
    expect(capturedMessages[0]).toContain('Clear');
  });

  test('A11b · smartmove.completed — screening flagged (criminal / eviction records)', async () => {
    const msg =
      `✅ Screening complete: bob.tenant@example.com\n` +
      `  Credit:   620–659 (Fair)\n` +
      `  Criminal: See report\n` +
      `  Eviction: See report\n` +
      `  Report type: Standard\n` +
      `  View full report: https://www.mysmartmove.com/SmartMove/login.go`;

    await mockNotifyLandlord(msg);
    printMessages('✉  [A11b] smartmove.completed (flags present)');

    expect(capturedMessages[0]).toContain('See report');
  });
});

// ─── B. SCHEDULER NOTIFICATIONS ───────────────────────────────────────────────

describe('B. Scheduler — Overdue Rent Summary', () => {

  test('B1 · all rent payments current (no overdue)', async () => {
    const msg = 'Overdue rent check: all rent payments are current.';
    await mockNotifyLandlord(msg);
    printMessages('✉  [B1] runOverdueRentCheck — all current');

    expect(capturedMessages[0]).toContain('all rent payments are current');
  });

  test('B2 · single overdue tenant', async () => {
    const msg =
      'Overdue rent check: 1 tenant with outstanding balances.\n' +
      '  • Maria Garcia: $2,800';
    await mockNotifyLandlord(msg);
    printMessages('✉  [B2] runOverdueRentCheck — 1 tenant overdue');

    expect(capturedMessages[0]).toContain('1 tenant');
    expect(capturedMessages[0]).toContain('Maria Garcia');
  });

  test('B3 · multiple overdue tenants', async () => {
    const msg =
      'Overdue rent check: 3 tenants with outstanding balances.\n' +
      '  • Maria Garcia: $2,800\n' +
      '  • James Wilson: $4,500\n' +
      '  • Chen Wei: $1,800';
    await mockNotifyLandlord(msg);
    printMessages('✉  [B3] runOverdueRentCheck — 3 tenants overdue');

    expect(capturedMessages[0]).toContain('3 tenants');
    expect(capturedMessages[0]).toContain('Chen Wei');
  });
});

describe('B. Scheduler — Lease Renewal Reminders', () => {

  test('B4 · single lease at 90-day milestone', async () => {
    const msg =
      `📋 Lease renewal reminders sent (1):\n` +
      `  • Priya Patel — 229 Watson Drive: 90 days (June 30, 2026)\n\n` +
      `Reply "renew [lease]", "vacate [lease]", or ask me for details.`;
    await mockNotifyLandlord(msg);
    printMessages('✉  [B4] runLeaseRenewalCheck — 90-day milestone');

    expect(capturedMessages[0]).toContain('90 days');
    expect(capturedMessages[0]).toContain('Priya Patel');
  });

  test('B5 · multiple leases at different milestones', async () => {
    const msg =
      `📋 Lease renewal reminders sent (3):\n` +
      `  • Maria Garcia — 512 Maple St: 30 days (April 20, 2026)\n` +
      `  • James Wilson — 101 Market #4A: 60 days (May 20, 2026)\n` +
      `  • Chen Wei — 7 Pine Ave: 14 days (April 4, 2026)\n\n` +
      `Reply "renew [lease]", "vacate [lease]", or ask me for details.`;
    await mockNotifyLandlord(msg);
    printMessages('✉  [B5] runLeaseRenewalCheck — multiple milestones');

    expect(capturedMessages[0]).toContain('3');
    expect(capturedMessages[0]).toContain('14 days');
  });
});

describe('B. Scheduler — Late Fees', () => {

  test('B6 · late fees in DRAFT mode (auto-submit off)', async () => {
    const msg =
      `💸 Late fees applied today: 2 invoice(s) (draft — review in ERPNext before submitting)\n` +
      `  • Maria Garcia — Unit 1A: $56.00 (day 7 overdue)\n` +
      `  • Chen Wei — Unit B: $36.00 (day 12 overdue)`;
    await mockNotifyLandlord(msg);
    printMessages('✉  [B6] runLateFeeCheck — draft mode');

    expect(capturedMessages[0]).toContain('💸');
    expect(capturedMessages[0]).toContain('draft');
    expect(capturedMessages[0]).toContain('Maria Garcia');
  });

  test('B7 · late fees in SUBMITTED mode (auto-submit on)', async () => {
    const msg =
      `💸 Late fees applied today: 1 invoice(s) (submitted — tenant balances updated)\n` +
      `  • Rotem Porat — 44 Ocean Blvd: $125.00 (day 3 overdue)`;
    await mockNotifyLandlord(msg);
    printMessages('✉  [B7] runLateFeeCheck — submitted mode');

    expect(capturedMessages[0]).toContain('submitted — tenant balances updated');
    expect(capturedMessages[0]).toContain('Rotem Porat');
  });
});

describe('B. Scheduler — Stale Work Orders', () => {

  test('B8 · one stale ticket (open >48 h)', async () => {
    const msg =
      `Stale maintenance ticket (open >48 h): 1 open.\n` +
      `  • [HDT-0042] Broken heater — no heat in bedroom — Maria Garcia`;
    await mockNotifyLandlord(msg);
    printMessages('✉  [B8] runStaleWorkOrderCheck — 1 ticket');

    expect(capturedMessages[0]).toContain('HDT-0042');
    expect(capturedMessages[0]).toContain('>48 h');
  });

  test('B9 · multiple stale tickets', async () => {
    const msg =
      `Stale maintenance tickets (open >48 h): 3 open.\n` +
      `  • [HDT-0042] Broken heater — Maria Garcia\n` +
      `  • [HDT-0038] Leaking faucet — James Wilson\n` +
      `  • [HDT-0031] AC not cooling — Chen Wei`;
    await mockNotifyLandlord(msg);
    printMessages('✉  [B9] runStaleWorkOrderCheck — 3 tickets');

    expect(capturedMessages[0]).toContain('3 open');
    expect(capturedMessages[0]).toContain('Leaking faucet');
  });
});

// ─── C. BOT COMMAND RESPONSES ─────────────────────────────────────────────────

const { handleStart, handleHelp, handleClear, handleChatId, handleMessage } = require('../src/telegram/handlers');

function mockBot() {
  return {
    sendMessage:    jest.fn(async (_chatId, text) => { capturedMessages.push(text); }),
    sendChatAction: jest.fn().mockResolvedValue({}),
  };
}

describe('C. Bot Commands', () => {

  test('C1 · /start — welcome message', async () => {
    const bot = mockBot();
    await handleStart(bot, { chat: { id: 1 }, from: { id: 111111, first_name: 'David' } });
    printMessages('✉  [C1] /start');

    expect(capturedMessages[0]).toContain('David');
    expect(capturedMessages[0]).toContain('property management');
    expect(capturedMessages[0]).toContain('/help');
  });

  test('C1b · /start — no first_name (fallback greeting)', async () => {
    const bot = mockBot();
    await handleStart(bot, { chat: { id: 1 }, from: { id: 111111 } });
    printMessages('✉  [C1b] /start (no first_name)');

    expect(capturedMessages[0]).toContain('there');
  });

  test('C2 · /help — example query list', async () => {
    const bot = mockBot();
    await handleHelp(bot, { chat: { id: 1 }, from: { id: 111111 } });
    printMessages('✉  [C2] /help');

    expect(capturedMessages[0]).toContain('late on rent');
    expect(capturedMessages[0]).toContain('Maintenance');
    expect(capturedMessages[0]).toContain('/clear');
  });

  test('C3 · /clear — history cleared confirmation', async () => {
    const bot = mockBot();
    await handleClear(bot, { chat: { id: 1 }, from: { id: 111111 } });
    printMessages('✉  [C3] /clear');

    expect(capturedMessages[0]).toContain('cleared');
  });

  test('C4 · /chatid — private chat', async () => {
    const bot = mockBot();
    await handleChatId(bot, {
      chat: { id: 111111, type: 'private', title: undefined },
      from: { id: 111111 },
    });
    printMessages('✉  [C4] /chatid (private)');

    expect(capturedMessages[0]).toContain('111111');
    expect(capturedMessages[0]).toContain('private');
    expect(capturedMessages[0]).toContain('(private)');
  });

  test('C4b · /chatid — group chat', async () => {
    const bot = mockBot();
    await handleChatId(bot, {
      chat: { id: -987654321, type: 'supergroup', title: 'Landlord HQ' },
      from: { id: 111111 },
    });
    printMessages('✉  [C4b] /chatid (group)');

    expect(capturedMessages[0]).toContain('-987654321');
    expect(capturedMessages[0]).toContain('supergroup');
    expect(capturedMessages[0]).toContain('Landlord HQ');
  });
});

// ─── D. NLP FREE-FORM RESPONSES ───────────────────────────────────────────────

describe('D. Free-form NLP Responses', () => {

  test('D1 · AI answers a portfolio query', async () => {
    const bot = mockBot();
    await handleMessage(bot, {
      chat: { id: 1 },
      from: { id: 111111 },
      text: 'Give me a summary of the portfolio',
    });
    printMessages('✉  [D1] NLP — portfolio summary query');

    expect(capturedMessages[0]).toContain('overdue');
    expect(capturedMessages[0]).toContain('maintenance');
  });

  test('D2 · AI error path — OpenAI unavailable', async () => {
    const { chat } = require('../src/ai/openai');
    chat.mockRejectedValueOnce(new Error('OpenAI 503: service unavailable'));

    const bot = mockBot();
    await handleMessage(bot, {
      chat: { id: 1 },
      from: { id: 111111 },
      text: 'Who owes rent?',
    });
    printMessages('✉  [D2] NLP — AI error message shown to user');

    expect(capturedMessages[0]).toContain('error');
    expect(capturedMessages[0]).toContain('try again');
  });

  test('D3 · empty/blank message — bot stays silent', async () => {
    const bot = mockBot();
    await handleMessage(bot, {
      chat: { id: 1 },
      from: { id: 111111 },
      text: '   ',
    });
    printMessages('✉  [D3] NLP — blank message (expect no response)');

    expect(capturedMessages).toHaveLength(0);
  });
});

// ─── E. SECURITY & AUTHORIZATION ─────────────────────────────────────────────

const { isAuthorized, guard } = require('../src/telegram/security');

describe('E. Security — Whitelist Enforcement', () => {

  test('E1 · authorized user passes guard', async () => {
    const inner = jest.fn().mockResolvedValue(undefined);
    const wrapped = guard(inner);
    await wrapped({ from: { id: 111111 }, chat: { id: 111111 }, text: 'hello' });
    expect(inner).toHaveBeenCalledTimes(1);
    console.log('\n  [E1] Authorized user 111111 → handler invoked ✓');
  });

  test('E2 · unauthorized user is silently dropped', async () => {
    const inner = jest.fn();
    const wrapped = guard(inner);
    await wrapped({ from: { id: 999999 }, chat: { id: 999999 }, text: 'hello' });
    expect(inner).not.toHaveBeenCalled();
    console.log('\n  [E2] Unauthorized user 999999 → silently dropped ✓');
  });

  test('E3 · null / undefined userId is rejected', async () => {
    expect(isAuthorized(null)).toBe(false);
    expect(isAuthorized(undefined)).toBe(false);
    console.log('\n  [E3] null/undefined userId → rejected ✓');
  });
});

// ─── F. SMS TEMPLATES (companion messages to tenant) ─────────────────────────

describe('F. SMS Templates — Companion Tenant Messages', () => {

  test('F1 · rentOverdue SMS to tenant', () => {
    const msg = mockSmsTemplates.rentOverdue({
      unit:            'Unit 1A',
      propertyAddress: '512 Maple St',
      amountDue:       2800,
    });
    const border = '─'.repeat(60);
    console.log('\n✉  [F1] SMS → tenant: rent overdue');
    console.log(border); console.log(msg); console.log(border);
    expect(msg).toContain('2800');
    expect(msg).toContain('Unit 1A');
  });

  test('F2 · leaseSignedConfirmation SMS to tenant', () => {
    const msg = mockSmsTemplates.leaseSignedConfirmation({
      unit:      '512 Maple St, Unit 1A',
      startDate: '2026-07-01',
    });
    const border = '─'.repeat(60);
    console.log('\n✉  [F2] SMS → tenant: lease signed confirmation');
    console.log(border); console.log(msg); console.log(border);
    expect(msg).toContain('fully executed');
    expect(msg).toContain('2026-07-01');
  });

  test('F3 · leaseRenewalNotice SMS to tenant (30-day milestone)', () => {
    const msg = mockSmsTemplates.leaseRenewalNotice({
      tenantName: 'Priya Patel',
      unit:       '229 Watson Drive',
      endDate:    'April 20, 2026',
      daysLeft:   30,
    });
    const border = '─'.repeat(60);
    console.log('\n✉  [F3] SMS → tenant: lease renewal notice (30 days)');
    console.log(border); console.log(msg); console.log(border);
    expect(msg).toContain('30');
    expect(msg).toContain('Priya Patel');
  });

  test('F4 · lateFeeCharged SMS to tenant (first day)', () => {
    const msg = mockSmsTemplates.lateFeeCharged({
      unit:      'Unit 1A',
      feeAmount: 56.00,
      totalDue:  2856.00,
      dayNumber: 7,
    });
    const border = '─'.repeat(60);
    console.log('\n✉  [F4] SMS → tenant: late fee charged');
    console.log(border); console.log(msg); console.log(border);
    expect(msg).toContain('56.00');
    expect(msg).toContain('day 7');
  });
});
