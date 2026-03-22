'use strict';

/**
 * In-process cron scheduler.
 *
 * Reads schedule settings from scheduler-settings.json (written by the admin UI).
 * Falls back to sensible defaults.  Each job is idempotent and self-contained.
 *
 * Exposes:
 *   startScheduler()   – register all cron jobs
 *   runJobNow(id)      – trigger a specific job immediately (returns Promise)
 *   getStatus()        – returns status of all jobs (for admin UI)
 *   saveSettings(cfg)  – persist scheduler settings (called by admin API)
 *   loadSettings()     – read current settings from disk
 */

const cron    = require('node-cron');
const path    = require('path');
const fs      = require('fs');
const logger  = require('../logger');

const SETTINGS_PATH = path.resolve(__dirname, '../../scheduler-settings.json');

// ── Defaults ────────────────────────────────────────────────────────────────

const JOB_DEFS = [
  {
    id:          'overdue_rent',
    label:       'Daily Overdue Rent Check',
    description: 'Scans for overdue rent invoices and sends SMS reminders to tenants. Sends a summary to your Telegram.',
    defaultTime: '08:00',
    defaultEnabled: true,
  },
  {
    id:          'lease_renewal',
    label:       'Lease Renewal Reminders',
    description: 'Alerts you and tenants at 90/60/30/14 days before a lease expires so renewals never slip through.',
    defaultTime: '10:00',
    defaultEnabled: true,
  },
  {
    id:          'late_fees',
    label:       'Daily Late Fee Check',
    description: 'Creates late fee invoices for tenants past the grace period. First-day SMS sent to tenant.',
    defaultTime: '10:30',
    defaultEnabled: true,
  },
  {
    id:          'stale_work_orders',
    label:       'Stale Work Order Alert',
    description: 'Notifies you of open maintenance tickets that have been waiting more than 48 hours.',
    defaultTime: '09:00',
    defaultEnabled: true,
  },
  {
    id:          'weekly_report',
    label:       'Weekly Portfolio Report',
    description: 'Sends a Friday summary: outstanding balances, open work orders, and upcoming lease expirations.',
    defaultTime: '17:00',
    defaultEnabled: true,
    weeklyDay:   5,  // 5 = Friday (1=Monday … 7=Sunday in node-cron)
  },
];

// ── Settings I/O ─────────────────────────────────────────────────────────────

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    logger.warn('Could not read scheduler-settings.json, using defaults', { error: err.message });
  }
  return {};
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
    logger.info('Scheduler settings saved', { path: SETTINGS_PATH });
    return true;
  } catch (err) {
    logger.error('Failed to save scheduler settings', { error: err.message });
    return false;
  }
}

/** Merges saved settings with defaults, returns full config for all jobs */
function resolveConfig() {
  const saved = loadSettings();
  return JOB_DEFS.map(def => ({
    ...def,
    time:    (saved[def.id]?.time    ?? def.defaultTime),
    enabled: (saved[def.id]?.enabled ?? def.defaultEnabled),
  }));
}

// ── Runtime state ─────────────────────────────────────────────────────────────

const jobState = {};  // id → { task, lastRun, lastResult, running }

for (const def of JOB_DEFS) {
  jobState[def.id] = { task: null, lastRun: null, lastResult: null, running: false };
}

function getStatus() {
  const cfg = resolveConfig();
  return cfg.map(j => ({
    ...j,
    lastRun:    jobState[j.id]?.lastRun   ?? null,
    lastResult: jobState[j.id]?.lastResult ?? null,
    running:    jobState[j.id]?.running    ?? false,
  }));
}

// ── Job runner ────────────────────────────────────────────────────────────────

const scheduler = require('./scheduler');

const JOB_FN = {
  overdue_rent:    () => scheduler.runOverdueRentCheck(),
  lease_renewal:   () => scheduler.runLeaseRenewalCheck(),
  late_fees:       () => scheduler.runLateFeeCheck(),
  stale_work_orders: () => scheduler.runStaleWorkOrderCheck(),
  weekly_report:   () => scheduler.runWeeklyReport(),
};

async function _execute(id) {
  if (jobState[id]?.running) {
    logger.warn('Skipping job – already running', { job: id });
    return;
  }
  jobState[id].running = true;
  const start = Date.now();
  try {
    logger.info('Scheduler job starting', { job: id });
    await JOB_FN[id]();
    const elapsed = Date.now() - start;
    jobState[id].lastRun    = new Date().toISOString();
    jobState[id].lastResult = { success: true, ms: elapsed };
    logger.info('Scheduler job completed', { job: id, ms: elapsed });
  } catch (err) {
    jobState[id].lastRun    = new Date().toISOString();
    jobState[id].lastResult = { success: false, error: err.message };
    logger.error('Scheduler job failed', { job: id, error: err.message });
  } finally {
    jobState[id].running = false;
  }
}

// ── Cron expression builder ───────────────────────────────────────────────────

function _cronExpr(time, weeklyDay) {
  const [hh, mm] = time.split(':').map(Number);
  if (weeklyDay !== undefined) {
    // Specific weekday: "mm hh * * weekday"
    return `${mm} ${hh} * * ${weeklyDay}`;
  }
  return `${mm} ${hh} * * *`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Start (or restart) all cron tasks based on current settings. */
function startScheduler() {
  // Stop any existing tasks
  for (const id of Object.keys(jobState)) {
    if (jobState[id].task) {
      jobState[id].task.stop();
      jobState[id].task = null;
    }
  }

  const cfg = resolveConfig();

  for (const job of cfg) {
    if (!job.enabled) {
      logger.info('Scheduler job disabled – skipped', { job: job.id });
      continue;
    }

    const expr = _cronExpr(job.time, job.weeklyDay);
    try {
      const task = cron.schedule(expr, () => _execute(job.id), { timezone: 'America/Los_Angeles' });
      jobState[job.id].task = task;
      logger.info('Scheduler job registered', { job: job.id, cron: expr, label: job.label });
    } catch (err) {
      logger.error('Failed to schedule job', { job: job.id, error: err.message });
    }
  }

  logger.info('In-process scheduler started', { jobs: cfg.filter(j => j.enabled).map(j => j.id) });
}

/** Immediately execute a single job by id (used by "Run Now" button). */
async function runJobNow(id) {
  if (!JOB_FN[id]) throw new Error(`Unknown job id: ${id}`);
  await _execute(id);
  return jobState[id].lastResult;
}

/** Reload settings and restart all cron tasks (called after settings are saved). */
function reloadScheduler() {
  logger.info('Reloading scheduler with new settings');
  startScheduler();
}

module.exports = { startScheduler, runJobNow, getStatus, saveSettings, loadSettings, resolveConfig, reloadScheduler, JOB_DEFS };
