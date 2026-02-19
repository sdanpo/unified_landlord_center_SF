'use strict';

/**
 * Automation Scheduler
 *
 * Implements the proactive alert and reporting workflows described in the PRD:
 *
 *   ┌─────────────────────────────────────────────────────────────────────────┐
 *   │ Job                  │ Schedule           │ Purpose                      │
 *   ├─────────────────────────────────────────────────────────────────────────┤
 *   │ Overdue rent check   │ Daily 8:00 AM      │ Catch any rent that the PMS  │
 *   │                      │                    │ webhook may have missed       │
 *   ├─────────────────────────────────────────────────────────────────────────┤
 *   │ Stale work orders    │ Daily 9:00 AM      │ Alert landlord to maintenance │
 *   │                      │                    │ tickets open > 48 h           │
 *   ├─────────────────────────────────────────────────────────────────────────┤
 *   │ Weekly report        │ Friday 5:00 PM     │ Cash-flow + rent-roll summary │
 *   └─────────────────────────────────────────────────────────────────────────┘
 *
 * All cron expressions use the node-cron format (seconds optional):
 *   "minute hour dayOfMonth month dayOfWeek"
 */

const cron = require('node-cron');
const logger = require('../logger');
const pmsClient = require('../api/index');
const sms = require('../sms/dispatcher');
const { notifyLandlord } = require('../telegram/bot');
const { generateWeeklyReport } = require('./reports');

const jobs = [];

// ─── Job: daily overdue-rent sweep ───────────────────────────────────────────

/**
 * Polls the PMS every morning for balances past due.
 * Acts as a safety net when the "rent.overdue" webhook is not emitted
 * (e.g. for balances that were already delinquent before the system was set up).
 */
async function runOverdueRentCheck() {
  logger.info('Scheduler: running overdue rent check');

  try {
    const balances = await pmsClient.getOutstandingBalances();
    const overdue = (Array.isArray(balances) ? balances : balances?.data || [])
      .filter((b) => (b.daysOverdue || b.DaysOverdue || 0) > 0);

    if (overdue.length === 0) {
      logger.info('Scheduler: no overdue balances found');
      return;
    }

    // Dispatch SMS to each delinquent tenant
    const smsResults = await Promise.allSettled(
      overdue.map((b) => {
        const msg = sms.templates.rentOverdue({
          unit: b.unitName || b.UnitName,
          propertyAddress: b.propertyAddress || b.PropertyAddress || '',
          amountDue: b.amountDue || b.AmountDue,
        });
        return sms.send({ tenantId: b.tenantId || b.TenantId, message: msg });
      })
    );

    const successCount = smsResults.filter((r) => r.status === 'fulfilled').length;

    // Summary alert to landlord
    const lines = overdue
      .map(
        (b) =>
          `• ${b.tenantName || b.TenantName} (${b.unitName || b.UnitName}): ` +
          `$${b.amountDue || b.AmountDue} – ${b.daysOverdue || b.DaysOverdue} day(s) overdue`
      )
      .join('\n');

    await notifyLandlord(
      `🚨 *Daily Rent Delinquency Report*\n\n` +
        `${overdue.length} tenant(s) are past due:\n${lines}\n\n` +
        `SMS reminders dispatched to ${successCount}/${overdue.length} tenants.`
    );
  } catch (err) {
    logger.error('Scheduler: overdue rent check failed', { error: err.message });
    await notifyLandlord(`⚠️ Automated rent check failed: ${err.message}`);
  }
}

// ─── Job: stale work-order alert ─────────────────────────────────────────────

/**
 * Checks for maintenance tickets that have been open for > 48 hours.
 * Pushes a Telegram alert to the landlord for each one found.
 */
async function runStaleWorkOrderCheck() {
  logger.info('Scheduler: running stale work-order check (> 48 h)');

  try {
    const stale = await pmsClient.getStaleWorkOrders(48);
    const items = Array.isArray(stale) ? stale : stale?.data || [];

    if (items.length === 0) {
      logger.info('Scheduler: no stale work orders found');
      return;
    }

    const now = Date.now();
    const lines = items
      .map((wo) => {
        const created = new Date(wo.createdAt || wo.CreatedDateTime || wo.created_at);
        const hoursOpen = Math.round((now - created.getTime()) / (1000 * 60 * 60));
        return (
          `• *Ticket #${wo.id || wo.Id}* – Unit ${wo.unit || wo.UnitName || 'N/A'}\n` +
          `  Issue: ${wo.description || wo.Description || 'N/A'}\n` +
          `  Open for: ${hoursOpen} hours\n` +
          `  Vendor: ${wo.vendorName || wo.VendorName || 'Not assigned'}`
        );
      })
      .join('\n\n');

    await notifyLandlord(
      `⚠️ *Stale Maintenance Tickets*\n\n` +
        `${items.length} work order(s) have been open for more than 48 hours:\n\n` +
        lines
    );
  } catch (err) {
    logger.error('Scheduler: stale work-order check failed', { error: err.message });
  }
}

// ─── Job: weekly financial report ────────────────────────────────────────────

async function runWeeklyReport() {
  logger.info('Scheduler: generating weekly financial report');
  try {
    await generateWeeklyReport();
  } catch (err) {
    logger.error('Scheduler: weekly report generation failed', { error: err.message });
    await notifyLandlord(`⚠️ Weekly report generation failed: ${err.message}`);
  }
}

// ─── Scheduler startup ────────────────────────────────────────────────────────

function start() {
  // Daily overdue rent check at 08:00 local time
  jobs.push(
    cron.schedule('0 8 * * *', runOverdueRentCheck, { timezone: 'America/Los_Angeles' })
  );

  // Daily stale work-order alert at 09:00 local time
  jobs.push(
    cron.schedule('0 9 * * *', runStaleWorkOrderCheck, { timezone: 'America/Los_Angeles' })
  );

  // Weekly report every Friday at 17:00 local time
  jobs.push(
    cron.schedule('0 17 * * 5', runWeeklyReport, { timezone: 'America/Los_Angeles' })
  );

  logger.info('Automation scheduler started', { jobCount: jobs.length });
}

function stop() {
  jobs.forEach((j) => j.stop());
  jobs.length = 0;
  logger.info('Automation scheduler stopped');
}

module.exports = {
  start,
  stop,
  // Export individual job runners for testing and manual triggers
  runOverdueRentCheck,
  runStaleWorkOrderCheck,
  runWeeklyReport,
};
