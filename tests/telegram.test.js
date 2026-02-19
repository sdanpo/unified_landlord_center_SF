'use strict';

/**
 * Tests for Telegram security guard and message handlers.
 */

const { isAuthorized, guard } = require('../src/telegram/security');

// ─── Security / whitelist ─────────────────────────────────────────────────────

describe('Telegram security – isAuthorized()', () => {
  // setup.js sets TELEGRAM_ALLOWED_USER_IDS=111111,222222

  it('returns true for a whitelisted user ID (number)', () => {
    expect(isAuthorized(111111)).toBe(true);
    expect(isAuthorized(222222)).toBe(true);
  });

  it('returns true for a whitelisted user ID given as string', () => {
    expect(isAuthorized('111111')).toBe(true);
  });

  it('returns false for an unauthorized user ID', () => {
    expect(isAuthorized(999999)).toBe(false);
    expect(isAuthorized(0)).toBe(false);
  });

  it('returns false for undefined / null', () => {
    expect(isAuthorized(undefined)).toBe(false);
    expect(isAuthorized(null)).toBe(false);
  });
});

describe('Telegram security – guard() wrapper', () => {
  it('calls the inner handler when the user is authorized', async () => {
    const inner = jest.fn().mockResolvedValue(undefined);
    const wrapped = guard(inner);

    await wrapped({ from: { id: 111111 }, text: 'hello', chat: { id: 111111 } });

    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('silently drops messages from unauthorized users', async () => {
    const inner = jest.fn();
    const wrapped = guard(inner);

    await wrapped({ from: { id: 999999 }, text: 'hello', chat: { id: 999999 } });

    expect(inner).not.toHaveBeenCalled();
  });
});

// ─── Message handlers ─────────────────────────────────────────────────────────

jest.mock('../src/ai/openai', () => ({
  chat: jest.fn().mockResolvedValue('Mocked AI response.'),
}));

const { handleStart, handleHelp, handleClear, handleMessage } = require('../src/telegram/handlers');
const { chat } = require('../src/ai/openai');

function mockBot() {
  return {
    sendMessage: jest.fn().mockResolvedValue({}),
    sendChatAction: jest.fn().mockResolvedValue({}),
  };
}

describe('handleStart()', () => {
  it('sends a welcome message mentioning the bot capabilities', async () => {
    const bot = mockBot();
    const msg = { chat: { id: 1 }, from: { id: 111111, first_name: 'Alice' } };

    await handleStart(bot, msg);

    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    const text = bot.sendMessage.mock.calls[0][1];
    expect(text).toContain('Alice');
    expect(text).toContain('Outstanding rent');
  });
});

describe('handleHelp()', () => {
  it('sends a message containing example queries', async () => {
    const bot = mockBot();
    const msg = { chat: { id: 1 }, from: { id: 111111 } };

    await handleHelp(bot, msg);

    const text = bot.sendMessage.mock.calls[0][1];
    expect(text).toContain('late on rent');
    expect(text).toContain('/clear');
  });
});

describe('handleMessage()', () => {
  it('passes the message to the AI and sends the reply', async () => {
    const bot = mockBot();
    const msg = { chat: { id: 1 }, from: { id: 111111 }, text: 'Who owes rent?' };

    await handleMessage(bot, msg);

    expect(chat).toHaveBeenCalledWith('Who owes rent?', expect.any(Array));
    expect(bot.sendMessage).toHaveBeenCalledWith(1, 'Mocked AI response.', expect.any(Object));
  });

  it('ignores messages with no text', async () => {
    const bot = mockBot();
    const msg = { chat: { id: 1 }, from: { id: 111111 }, text: undefined };

    await handleMessage(bot, msg);

    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('sends an error message if the AI throws', async () => {
    chat.mockRejectedValueOnce(new Error('OpenAI timeout'));
    const bot = mockBot();
    const msg = { chat: { id: 1 }, from: { id: 111111 }, text: 'give me data' };

    await handleMessage(bot, msg);

    const text = bot.sendMessage.mock.calls[0][1];
    expect(text).toContain('error');
  });
});

describe('handleClear()', () => {
  it('sends a confirmation message', async () => {
    const bot = mockBot();
    const msg = { chat: { id: 1 }, from: { id: 111111 } };

    await handleClear(bot, msg);

    const text = bot.sendMessage.mock.calls[0][1];
    expect(text).toContain('cleared');
  });
});
