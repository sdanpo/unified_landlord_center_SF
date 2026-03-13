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

// ─── Timing helper ───────────────────────────────────────────────────────────

function elapsed(startMs) {
  return `${Date.now() - startMs}ms`;
}

// ─── Job: daily overdue-rent sweep ───────────────────────────────────────────

/**
 * Polls the PMS every morning for balances past due.
 * Acts as a safety net when the "rent.overdue" webhook is not emitted
 * (e.g. for balances that were already delinquent before the system was set up).
 */
async function runOverdueRentCheck() {
  const jobStart = Date.now();
  const jobId = `overdue-rent-${Date.now().toString(36)}`;

  logger.info('Scheduler job starting: overdue rent check', { jobId, scheduledAt: new Date().toISOString() });

  try {
    logger.debug('Scheduler: fetching outstanding balances from ERPNext', { jobId });
    const fetchStart = Date.now();
    const balances = await pmsClient.getOutstandingBalances();
    logger.info('Scheduler: outstanding balances fetched', {
      jobId,
      fetchElapsedMs: Date.now() - fetchStart,
      rawCount: Array.isArray(balances) ? balances.length : (balances?.data?.length ?? 'unknown'),
    });

    const overdue = (Array.isArray(balances) ? balances : balances?.data || [])
      .filter((b) => (b.daysOverdue || b.DaysOverdue || 0) > 0);

    logger.info('Scheduler: overdue tenants identified', {
      jobId,
      overdueCount: overdue.length,
      tenants: overdue.map((b) => ({
        tenantId: b.tenantId || b.TenantId,
        tenantName: b.tenantName || b.TenantName,
        unit: b.unitName || b.UnitName,
        amountDue: b.amountDue || b.AmountDue,
        daysOverdue: b.daysOverdue || b.DaysOverdue,
      })),
    });

    if (overdue.length === 0) {
      logger.info('Scheduler: no overdue balances found – nothing to do', { jobId, elapsedMs: elapsed(jobStart) });
      return;
    }

    // Dispatch SMS to each delinquent tenant
    logger.info('Scheduler: dispatching SMS reminders', { jobId, count: overdue.length });

    const smsResults = await Promise.allSettled(
      overdue.map((b) => {
        const msg = sms.templates.rentOverdue({
          unit: b.unitName || b.UnitName,
          propertyAddress: b.propertyAddress || b.PropertyAddress || '',
          amountDue: b.amountDue || b.AmountDue,
        });
        logger.debug('Scheduler: sending overdue SMS', {
          jobId,
          tenantId: b.tenantId || b.TenantId,
          unit: b.unitName || b.UnitName,
          msgLength: msg.length,
        });
        return sms.send({ tenantId: b.tenantId || b.TenantId, message: msg });
      })
    );

    // Log each SMS outcome individually
    smsResults.forEach((result, i) => {
      const b = overdue[i];
      const tenantId = b.tenantId || b.TenantId;
      const unit = b.unitName || b.UnitName;
      if (result.status === 'fulfilled') {
        logger.info('Scheduler: SMS dispatched successfully', {
          jobId,
          tenantId,
          unit,
          twilioSid: result.value?.sid,
        });
      } else {
        logger.error('Scheduler: SMS dispatch failed', {
          jobId,
          tenantId,
          unit,
          error: result.reason?.message || String(result.reason),
          stack: result.reason?.stack,
        });
      }
    });

    const successCount = smsResults.filter((r) => r.status === 'fulfilled').length;
    const failCount = smsResults.length - successCount;

    logger.info('Scheduler: SMS dispatch summary', { jobId, total: overdue.length, successCount, failCount });

    // Summary alert to landlord
    const lines = overdue
      .map(
        (b) =>
          `• ${b.tenantName || b.TenantName} (${b.unitName || b.UnitName}): ` +
          `$${b.amountDue || b.AmountDue} – ${b.daysOverdue || b.DaysOverdue} day(s) overdue`
      )
      .join('\n');

    const telegramMsg =
      `🚨 *Daily Rent Delinquency Report*\n\n` +
        `${overdue.length} tenant(s) are past due:\n${lines}\n\n` +
        `SMS reminders dispatched to ${successCount}/${overdue.length} tenants.`;

    logger.debug('Scheduler: sending Telegram summary to landlord', {
      jobId,
      msgLength: telegramMsg.length,
    });

    const telegramResult = await Promise.allSettled([notifyLandlord(telegramMsg)]);
    if (telegramResult[0].status === 'fulfilled') {
      logger.info('Scheduler: Telegram landlord summary sent', { jobId });
    } else {
      logger.error('Scheduler: Telegram landlord summary failed', {
        jobId,
        error: telegramResult[0].reason?.message,
      });
    }

    logger.info('Scheduler job complete: overdue rent check', {
      jobId,
      overdueCount: overdue.length,
      smsSentCount: successCount,
      smsFailedCount: failCount,
      totalElapsedMs: elapsed(jobStart),
    });
  } catch (err) {
    logger.error('Scheduler job failed: overdue rent check', {
      jobId,
      error: err.message,
      stack: err.stack,
      totalElapsedMs: elapsed(jobStart),
    });
    await notifyLandlord(`⚠️ Automated rent check failed: ${err.message}`).catch((tgErr) => {
      logger.error('Scheduler: could not send failure alert to Telegram', { jobId, error: tgErr.message });
    });
  }
}

// ─── Job: stale work-order alert ─────────────────────────────────────────────

/**
 * Checks for maintenance tickets that have been open for > 48 hours.
 * Pushes a Telegram alert to the landlord for each one found.
 */
async function runStaleWorkOrderCheck() {
  const jobStart = Date.now();
  const jobId = `stale-wo-${Date.now().toString(36)}`;
  const STALE_HOURS = 48;

  logger.info('Scheduler job starting: stale work-order check', {
    jobId,
    staleThresholdHours: STALE_HOURS,
    scheduledAt: new Date().toISOString(),
  });

  try {
    logger.debug('Scheduler: fetching stale work orders from ERPNext', { jobId, staleHours: STALE_HOURS });
    const fetchStart = Date.now();
    const stale = await pmsClient.getStaleWorkOrders(STALE_HOURS);
    const items = Array.isArray(stale) ? stale : stale?.data || [];

    logger.info('Scheduler: stale work orders fetched', {
      jobId,
      fetchElapsedMs: Date.now() - fetchStart,
      staleCount: items.length,
      tickets: items.map((wo) => ({
        id: wo.name || wo.id || wo.Id,
        unit: wo.custom_unit || wo.unit || wo.UnitName,
        subject: wo.subject || wo.description || wo.Description,
        priority: wo.priority,
        status: wo.status,
        creation: wo.creation,
      })),
    });

    if (items.length === 0) {
      logger.info('Scheduler: no stale work orders found – nothing to do', {
        jobId,
        elapsedMs: elapsed(jobStart),
      });
      return;
    }

    const now = Date.now();
    const lines = items
      .map((wo) => {
        const created = new Date(wo.createdAt || wo.CreatedDateTime || wo.created_at || wo.creation);
        const hoursOpen = isNaN(created.getTime())
          ? '?'
          : Math.round((now - created.getTime()) / (1000 * 60 * 60));

        logger.debug('Scheduler: stale ticket detail', {
          jobId,
          ticketId: wo.name || wo.id || wo.Id,
          unit: wo.custom_unit || wo.unit,
          hoursOpen,
          priority: wo.priority,
        });

        return (
          `• *Ticket #${wo.name || wo.id || wo.Id}* – Unit ${wo.custom_unit || wo.unit || wo.UnitName || 'N/A'}\n` +
          `  Issue: ${wo.subject || wo.description || wo.Description || 'N/A'}\n` +
          `  Open for: ${hoursOpen} hours\n` +
          `  Priority: ${wo.priority || 'Normal'}\n` +
          `  Vendor: ${wo.vendorName || wo.VendorName || 'Not assigned'}`
        );
      })
      .join('\n\n');

    const telegramMsg =
      `⚠️ *Stale Maintenance Tickets*\n\n` +
        `${items.length} work order(s) have been open for more than ${STALE_HOURS} hours:\n\n` +
        lines;

    logger.debug('Scheduler: sending stale-ticket Telegram alert', {
      jobId,
      ticketCount: items.length,
      msgLength: telegramMsg.length,
    });

    const telegramResult = await Promise.allSettled([notifyLandlord(telegramMsg)]);
    if (telegramResult[0].status === 'fulfilled') {
      logger.info('Scheduler: Telegram stale-ticket alert sent', { jobId });
    } else {
      logger.error('Scheduler: Telegram stale-ticket alert failed', {
        jobId,
        error: telegramResult[0].reason?.message,
        stack: telegramResult[0].reason?.stack,
      });
    }

    logger.info('Scheduler job complete: stale work-order check', {
      jobId,
      staleCount: items.length,
      totalElapsedMs: elapsed(jobStart),
    });
  } catch (err) {
    logger.error('Scheduler job failed: stale work-order check', {
      jobId,
      error: err.message,
      stack: err.stack,
      totalElapsedMs: elapsed(jobStart),
    });
  }
}

// ─── Job: weekly financial report ────────────────────────────────────────────

async function runWeeklyReport() {
  const jobStart = Date.now();
  const jobId = `weekly-report-${Date.now().toString(36)}`;

  logger.info('Scheduler job starting: weekly financial report', {
    jobId,
    scheduledAt: new Date().toISOString(),
  });

  try {
    await generateWeeklyReport({ jobId });

    logger.info('Scheduler job complete: weekly financial report', {
      jobId,
      totalElapsedMs: elapsed(jobStart),
    });
  } catch (err) {
    logger.error('Scheduler job failed: weekly financial report', {
      jobId,
      error: err.message,
      stack: err.stack,
      totalElapsedMs: elapsed(jobStart),
    });
    await notifyLandlord(`⚠️ Weekly report generation failed: ${err.message}`).catch((tgErr) => {
      logger.error('Scheduler: could not send failure alert to Telegram', { jobId, error: tgErr.message });
    });
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

  logger.info('Automation scheduler started', {
    jobCount: jobs.length,
    jobs: [
      { name: 'overdue-rent-check', cron: '0 8 * * *', tz: 'America/Los_Angeles' },
      { name: 'stale-work-order-check', cron: '0 9 * * *', tz: 'America/Los_Angeles' },
      { name: 'weekly-report', cron: '0 17 * * 5', tz: 'America/Los_Angeles' },
    ],
  });
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
