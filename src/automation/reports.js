'use strict';

/**
 * Report Generator
 *
 * Aggregates financial and operational data from the PMS and delivers
 * a formatted weekly summary to the landlord.
 *
 * Delivery targets (configured via REPORT_DELIVERY env var):
 *   "telegram" – sends a formatted Markdown message directly to the
 *                landlord's Telegram chat (default, no extra setup required).
 *   "email"    – placeholder for SMTP / SendGrid integration.
 *   "gdrive"   – placeholder for Google Drive CSV upload.
 */

const logger = require('../logger');
const { config } = require('../config');
const pmsClient = require('../api/index');
const { notifyLandlord } = require('../telegram/bot');

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getWeekRange() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const fmt = (d) => d.toISOString().split('T')[0];
  return { startDate: fmt(monday), endDate: fmt(sunday) };
}

// ─── Data aggregation ─────────────────────────────────────────────────────────

async function aggregateWeeklyData({ jobId } = {}) {
  const { startDate, endDate } = getWeekRange();

  logger.info('Reports: aggregating weekly data', { jobId, startDate, endDate });

  const fetchStart = Date.now();

  const [ledger, outstanding, workOrders, leases] = await Promise.allSettled([
    pmsClient.getGeneralLedger({ startDate, endDate }),
    pmsClient.getOutstandingBalances(),
    pmsClient.getWorkOrders({ status: 'open' }),
    pmsClient.getLeases({ status: 'active' }),
  ]);

  const fetchElapsed = Date.now() - fetchStart;

  // Log the result of each ERPNext fetch individually
  function logFetchResult(label, result) {
    if (result.status === 'fulfilled') {
      const items = Array.isArray(result.value) ? result.value : result.value?.data || [];
      logger.info(`Reports: ${label} fetch succeeded`, { jobId, label, count: items.length, fetchElapsedMs: fetchElapsed });
    } else {
      logger.error(`Reports: ${label} fetch failed`, {
        jobId,
        label,
        error: result.reason?.message || String(result.reason),
        stack: result.reason?.stack,
      });
    }
  }

  logFetchResult('GL Entries', ledger);
  logFetchResult('Outstanding Balances', outstanding);
  logFetchResult('Open Work Orders', workOrders);
  logFetchResult('Active Leases', leases);

  return { startDate, endDate, ledger, outstanding, workOrders, leases, jobId };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatTelegramReport({ startDate, endDate, ledger, outstanding, workOrders, leases, jobId }) {
  const lines = [
    `📊 *Weekly Property Management Report*`,
    `📅 Period: ${startDate} → ${endDate}`,
    ``,
  ];

  // Financial section
  if (ledger.status === 'fulfilled') {
    const entries = Array.isArray(ledger.value) ? ledger.value : ledger.value?.data || [];
    const income = entries
      .filter((e) => (e.type || e.Type || '') === 'income')
      .reduce((s, e) => s + (e.amount || e.Amount || 0), 0);
    const expenses = entries
      .filter((e) => (e.type || e.Type || '') === 'expense')
      .reduce((s, e) => s + (e.amount || e.Amount || 0), 0);
    const net = income - expenses;

    logger.info('Reports: computed financials', {
      jobId,
      glEntryCount: entries.length,
      grossIncome: income.toFixed(2),
      totalExpenses: expenses.toFixed(2),
      netCashFlow: net.toFixed(2),
    });

    lines.push(`💰 *Financials*`);
    lines.push(`• Gross Income: $${income.toFixed(2)}`);
    lines.push(`• Expenses: $${expenses.toFixed(2)}`);
    lines.push(`• Net Cash Flow: $${net.toFixed(2)}`);
    lines.push(``);
  } else {
    logger.warn('Reports: skipping financial section – GL data unavailable', { jobId });
    lines.push(`💰 *Financials* – data unavailable`);
    lines.push(``);
  }

  // Delinquency section
  if (outstanding.status === 'fulfilled') {
    const overdue = (Array.isArray(outstanding.value) ? outstanding.value : outstanding.value?.data || [])
      .filter((b) => (b.amountDue || b.AmountDue || 0) > 0);

    const totalOwed = overdue.reduce((s, b) => s + (b.amountDue || b.AmountDue || 0), 0);

    logger.info('Reports: delinquency summary', {
      jobId,
      overdueCount: overdue.length,
      totalOwed: totalOwed.toFixed(2),
      tenants: overdue.map((b) => ({
        tenantName: b.tenantName || b.TenantName,
        unit: b.unitName || b.UnitName,
        amountDue: b.amountDue || b.AmountDue,
      })),
    });

    lines.push(`🚨 *Delinquencies* (${overdue.length} tenant(s))`);
    if (overdue.length === 0) {
      lines.push(`• All rents are current ✅`);
    } else {
      overdue.forEach((b) => {
        lines.push(
          `• ${b.tenantName || b.TenantName} (${b.unitName || b.UnitName}): ` +
            `$${b.amountDue || b.AmountDue}`
        );
      });
    }
    lines.push(``);
  } else {
    logger.warn('Reports: skipping delinquency section – outstanding balance data unavailable', { jobId });
    lines.push(`🚨 *Delinquencies* – data unavailable`);
    lines.push(``);
  }

  // Work orders section
  if (workOrders.status === 'fulfilled') {
    const open = Array.isArray(workOrders.value) ? workOrders.value : workOrders.value?.data || [];

    logger.info('Reports: open work orders summary', {
      jobId,
      openCount: open.length,
      byPriority: open.reduce((acc, wo) => {
        const p = wo.priority || 'Normal';
        acc[p] = (acc[p] || 0) + 1;
        return acc;
      }, {}),
    });

    lines.push(`🔧 *Open Work Orders* (${open.length})`);
    if (open.length === 0) {
      lines.push(`• No open maintenance tickets ✅`);
    } else {
      open.slice(0, 10).forEach((wo) => {
        lines.push(
          `• #${wo.id || wo.Id || wo.name} – ${wo.unit || wo.UnitName || wo.custom_unit}: ${wo.description || wo.subject || wo.Description || 'No description'}`
        );
      });
      if (open.length > 10) lines.push(`  …and ${open.length - 10} more`);
    }
    lines.push(``);
  } else {
    logger.warn('Reports: skipping work orders section – data unavailable', { jobId });
    lines.push(`🔧 *Open Work Orders* – data unavailable`);
    lines.push(``);
  }

  // Lease section
  if (leases.status === 'fulfilled') {
    const active = Array.isArray(leases.value) ? leases.value : leases.value?.data || [];
    const soon = active.filter((l) => {
      const end = new Date(l.endDate || l.EndDate || l.leaseToDate || l.end_date || '');
      if (isNaN(end.getTime())) return false;
      const daysLeft = (end.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      return daysLeft >= 0 && daysLeft <= 60;
    });

    logger.info('Reports: lease expiration summary', {
      jobId,
      activeLeasesTotal: active.length,
      expiringWithin60Days: soon.length,
      expiring: soon.map((l) => ({
        tenantName: l.tenantName || l.TenantName || l.tenant_name,
        unit: l.unitName || l.UnitName || l.property_unit,
        endDate: l.endDate || l.EndDate || l.end_date || l.leaseToDate,
      })),
    });

    lines.push(`📋 *Lease Expirations (next 60 days)* (${soon.length})`);
    if (soon.length === 0) {
      lines.push(`• No leases expiring soon ✅`);
    } else {
      soon.forEach((l) => {
        lines.push(
          `• ${l.tenantName || l.TenantName || l.tenant_name || 'Unknown'} (${l.unitName || l.UnitName || l.property_unit}): ` +
            `expires ${l.endDate || l.EndDate || l.end_date || l.leaseToDate}`
        );
      });
    }
  } else {
    logger.warn('Reports: skipping lease expiration section – data unavailable', { jobId });
    lines.push(`📋 *Lease Expirations* – data unavailable`);
  }

  return lines.join('\n');
}

// ─── Delivery backends ────────────────────────────────────────────────────────

async function deliverViaTelegram(reportText, { jobId } = {}) {
  logger.info('Reports: delivering via Telegram', { jobId, reportCharCount: reportText.length });

  const result = await Promise.allSettled([notifyLandlord(reportText)]);
  if (result[0].status === 'fulfilled') {
    logger.info('Reports: Telegram delivery succeeded', { jobId });
  } else {
    logger.error('Reports: Telegram delivery failed', {
      jobId,
      error: result[0].reason?.message,
      stack: result[0].reason?.stack,
    });
    throw result[0].reason;
  }
}

async function deliverViaEmail(_reportText, { jobId } = {}) {
  // Placeholder: integrate with SendGrid, Nodemailer, etc.
  logger.warn('Reports: email delivery is not yet implemented – configure an SMTP integration', { jobId });
}

async function deliverViaGDrive(_reportText, { jobId } = {}) {
  // Placeholder: integrate with Google Drive API (upload CSV/PDF).
  logger.warn('Reports: Google Drive delivery is not yet implemented – configure the Drive API integration', { jobId });
}

// ─── Public entry point ───────────────────────────────────────────────────────

async function generateWeeklyReport({ jobId } = {}) {
  logger.info('Reports: generateWeeklyReport called', { jobId, deliveryTarget: config.reports.delivery });

  const data = await aggregateWeeklyData({ jobId });

  logger.debug('Reports: formatting report text', { jobId });
  const reportText = formatTelegramReport(data);
  logger.info('Reports: report formatted', { jobId, charCount: reportText.length });

  switch (config.reports.delivery) {
    case 'email':
      await deliverViaEmail(reportText, { jobId });
      break;
    case 'gdrive':
      await deliverViaGDrive(reportText, { jobId });
      break;
    case 'telegram':
    default:
      await deliverViaTelegram(reportText, { jobId });
  }
}

module.exports = { generateWeeklyReport, aggregateWeeklyData, formatTelegramReport };
