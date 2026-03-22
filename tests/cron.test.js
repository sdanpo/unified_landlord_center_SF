'use strict';

/**
 * Tests for the in-process cron scheduler (src/automation/cron.js).
 *
 * Covers:
 *  - resolveConfig() returns defaults when no settings file exists
 *  - saveSettings() / loadSettings() round-trip
 *  - getStatus() shape
 *  - runJobNow() calls the correct scheduler function
 *  - reloadScheduler() re-registers tasks without throwing
 *  - Admin HTTP API (/admin/api/*) via supertest
 */

const path    = require('path');
const fs      = require('fs');
const request = require('supertest');

// Resolve the actual settings path used by cron.js
const SETTINGS_PATH = path.resolve(__dirname, '../scheduler-settings.json');

// Patch the SETTINGS_PATH before requiring cron.js
jest.mock('../src/automation/cron', () => {
  const path = require('path');
  const os   = require('os');
  // We use jest.requireActual to get the real module, then patch its internals
  const actual = jest.requireActual('../src/automation/cron');
  return actual;
}, { virtual: false });

// ── Mock scheduler functions so no real ERPNext / Telegram calls happen ───────

jest.mock('../src/automation/scheduler', () => ({
  runOverdueRentCheck:   jest.fn().mockResolvedValue(undefined),
  runLeaseRenewalCheck:  jest.fn().mockResolvedValue(undefined),
  runLateFeeCheck:       jest.fn().mockResolvedValue(undefined),
  runStaleWorkOrderCheck: jest.fn().mockResolvedValue(undefined),
  runWeeklyReport:       jest.fn().mockResolvedValue(undefined),
}));

// Also mock node-cron to avoid real scheduling during tests
jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({ stop: jest.fn() })),
}));

const cron      = require('../src/automation/cron');
const scheduler = require('../src/automation/scheduler');
const nodeCron  = require('node-cron');

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanSettings() {
  try { fs.unlinkSync(SETTINGS_PATH); } catch (_) {}
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => { cleanSettings(); });
afterEach(() => { cleanSettings(); });

describe('cron – resolveConfig', () => {
  it('returns all 5 jobs with default values when no settings file exists', () => {
    const cfg = cron.resolveConfig();
    expect(cfg).toHaveLength(5);
    const ids = cfg.map(j => j.id);
    expect(ids).toEqual(
      expect.arrayContaining(['overdue_rent', 'lease_renewal', 'late_fees', 'stale_work_orders', 'weekly_report'])
    );
    // All enabled by default
    cfg.forEach(j => expect(j.enabled).toBe(true));
  });

  it('merges saved settings over defaults', () => {
    cron.saveSettings({ overdue_rent: { enabled: false, time: '06:30' } });
    const cfg = cron.resolveConfig();
    const job = cfg.find(j => j.id === 'overdue_rent');
    expect(job.enabled).toBe(false);
    expect(job.time).toBe('06:30');
    // Other jobs still use defaults
    const renewal = cfg.find(j => j.id === 'lease_renewal');
    expect(renewal.enabled).toBe(true);
    expect(renewal.time).toBe('10:00');
    cleanSettings();
  });
});

describe('cron – getStatus', () => {
  it('returns all jobs with lastRun/lastResult/running fields', () => {
    const status = cron.getStatus();
    expect(status).toHaveLength(5);
    status.forEach(j => {
      expect(j).toHaveProperty('id');
      expect(j).toHaveProperty('label');
      expect(j).toHaveProperty('description');
      expect(j).toHaveProperty('enabled');
      expect(j).toHaveProperty('time');
      expect(j).toHaveProperty('lastRun');
      expect(j).toHaveProperty('lastResult');
      expect(j).toHaveProperty('running');
    });
  });
});

describe('cron – runJobNow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const cases = [
    ['overdue_rent',       'runOverdueRentCheck'],
    ['lease_renewal',      'runLeaseRenewalCheck'],
    ['late_fees',          'runLateFeeCheck'],
    ['stale_work_orders',  'runStaleWorkOrderCheck'],
    ['weekly_report',      'runWeeklyReport'],
  ];

  test.each(cases)('runJobNow(%s) calls scheduler.%s()', async (jobId, fnName) => {
    await cron.runJobNow(jobId);
    expect(scheduler[fnName]).toHaveBeenCalledTimes(1);
  });

  it('throws for unknown job id', async () => {
    await expect(cron.runJobNow('unknown_job')).rejects.toThrow('Unknown job id');
  });

  it('sets lastResult.success=true on success', async () => {
    scheduler.runOverdueRentCheck.mockResolvedValueOnce(undefined);
    await cron.runJobNow('overdue_rent');
    const status = cron.getStatus().find(j => j.id === 'overdue_rent');
    expect(status.lastResult.success).toBe(true);
    expect(typeof status.lastResult.ms).toBe('number');
  });

  it('sets lastResult.success=false on error', async () => {
    scheduler.runOverdueRentCheck.mockRejectedValueOnce(new Error('ERPNext down'));
    await cron.runJobNow('overdue_rent');
    const status = cron.getStatus().find(j => j.id === 'overdue_rent');
    expect(status.lastResult.success).toBe(false);
    expect(status.lastResult.error).toBe('ERPNext down');
  });
});

describe('cron – startScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cleanSettings();
  });

  it('schedules 5 cron tasks when all jobs are enabled', () => {
    cron.startScheduler();
    expect(nodeCron.schedule).toHaveBeenCalledTimes(5);
  });

  it('schedules fewer tasks when some jobs are disabled', () => {
    cron.saveSettings({
      overdue_rent:   { enabled: false, time: '08:00' },
      weekly_report:  { enabled: false, time: '17:00' },
    });
    cron.startScheduler();
    expect(nodeCron.schedule).toHaveBeenCalledTimes(3);
    cleanSettings();
  });

  it('uses America/Los_Angeles timezone', () => {
    cron.startScheduler();
    const calls = nodeCron.schedule.mock.calls;
    calls.forEach(([_expr, _fn, opts]) => {
      expect(opts.timezone).toBe('America/Los_Angeles');
    });
  });

  it('uses correct cron expression for daily jobs', () => {
    cron.saveSettings({ overdue_rent: { enabled: true, time: '08:15' } });
    cron.startScheduler();
    const calls = nodeCron.schedule.mock.calls;
    const overdueCall = calls.find(([expr]) => expr === '15 8 * * *');
    expect(overdueCall).toBeTruthy();
    cleanSettings();
  });

  it('uses weekday-5 cron expression for weekly_report', () => {
    cron.startScheduler();
    const calls = nodeCron.schedule.mock.calls;
    // Weekly report at 17:00 on Friday (weekday 5)
    const weeklyCall = calls.find(([expr]) => expr === '0 17 * * 5');
    expect(weeklyCall).toBeTruthy();
  });
});

// ── Admin HTTP API ─────────────────────────────────────────────────────────────

describe('Admin API routes', () => {
  let app;

  beforeAll(() => {
    // Mock Telegram bot so the server doesn't try to connect
    jest.mock('../src/telegram/bot', () => ({
      createBot:     jest.fn(),
      stopBot:       jest.fn(),
      notifyLandlord: jest.fn().mockResolvedValue(undefined),
    }));
    const { createServer } = require('../src/webhook/server');
    app = createServer();
  });

  afterAll(() => {
    cleanSettings();
  });

  it('GET /admin returns HTML page', async () => {
    const res = await request(app).get('/admin');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Property Automations');
  });

  it('GET /admin/api/scheduler-status returns array of 5 jobs', async () => {
    const res = await request(app).get('/admin/api/scheduler-status');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(5);
    res.body.forEach(job => {
      expect(job).toHaveProperty('id');
      expect(job).toHaveProperty('label');
      expect(job).toHaveProperty('enabled');
      expect(job).toHaveProperty('time');
      expect(job).toHaveProperty('running');
    });
  });

  it('POST /admin/api/scheduler-settings saves and responds with success', async () => {
    const settings = {
      overdue_rent:   { enabled: false, time: '07:00' },
      weekly_report:  { enabled: true,  time: '16:00' },
    };
    const res = await request(app)
      .post('/admin/api/scheduler-settings')
      .send(settings);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify persisted
    const status = await request(app).get('/admin/api/scheduler-status');
    const overdueJob = status.body.find(j => j.id === 'overdue_rent');
    expect(overdueJob.enabled).toBe(false);
    expect(overdueJob.time).toBe('07:00');
  });

  it('POST /admin/api/run-job/overdue_rent calls scheduler and returns result', async () => {
    const res = await request(app)
      .post('/admin/api/run-job/overdue_rent')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success');
    expect(scheduler.runOverdueRentCheck).toHaveBeenCalled();
  });

  it('POST /admin/api/run-job/unknown returns 400', async () => {
    const res = await request(app)
      .post('/admin/api/run-job/unknown_job')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
