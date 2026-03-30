'use strict';

/**
 * Tests that the /help and /start Telegram commands mention ticket
 * creation and resolution after the new create/update_work_order feature.
 */

// Mock OpenAI chat so handlers.js can be loaded without a real API key
jest.mock('../src/ai/openai', () => ({ chat: jest.fn().mockResolvedValue('ok') }));

const { handleHelp, handleStart } = require('../src/telegram/handlers');

function mockBot() {
  return { sendMessage: jest.fn().mockResolvedValue({}) };
}

describe('/help command – maintenance section', () => {
  it('includes example queries for opening a ticket', async () => {
    const bot = mockBot();
    const msg = { chat: { id: 1 }, from: { id: 111111, first_name: 'Test' } };
    await handleHelp(bot, msg);
    const text = bot.sendMessage.mock.calls[0][1];
    expect(text).toContain('Open a ticket');
  });

  it('includes example query for resolving a ticket', async () => {
    const bot = mockBot();
    const msg = { chat: { id: 1 }, from: { id: 111111, first_name: 'Test' } };
    await handleHelp(bot, msg);
    const text = bot.sendMessage.mock.calls[0][1];
    expect(text).toContain('resolved');
  });

  it('includes example query for closing a ticket with a note', async () => {
    const bot = mockBot();
    const msg = { chat: { id: 1 }, from: { id: 111111, first_name: 'Test' } };
    await handleHelp(bot, msg);
    const text = bot.sendMessage.mock.calls[0][1];
    expect(text).toContain('Close the plumbing ticket');
  });
});

describe('/start command', () => {
  it('mentions the ability to open and close maintenance tickets', async () => {
    const bot = mockBot();
    const msg = { chat: { id: 1 }, from: { id: 111111, first_name: 'Bob' } };
    await handleStart(bot, msg);
    const text = bot.sendMessage.mock.calls[0][1];
    expect(text).toContain('open');
    expect(text).toContain('close');
  });
});
