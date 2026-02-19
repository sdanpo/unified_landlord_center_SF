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

async function aggregateWeeklyData() {
  const { startDate, endDate } = getWeekRange();

  const [ledger, outstanding, workOrders, leases] = await Promise.allSettled([
    pmsClient.getGeneralLedger({ startDate, endDate }),
    pmsClient.getOutstandingBalances(),
    pmsClient.getWorkOrders({ status: 'open' }),
    pmsClient.getLeases({ status: 'active' }),
  ]);

  return { startDate, endDate, ledger, outstanding, workOrders, leases };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatTelegramReport({ startDate, endDate, ledger, outstanding, workOrders, leases }) {
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

    lines.push(`💰 *Financials*`);
    lines.push(`• Gross Income: $${income.toFixed(2)}`);
    lines.push(`• Expenses: $${expenses.toFixed(2)}`);
    lines.push(`• Net Cash Flow: $${(income - expenses).toFixed(2)}`);
    lines.push(``);
  }

  // Delinquency section
  if (outstanding.status === 'fulfilled') {
    const overdue = (Array.isArray(outstanding.value) ? outstanding.value : outstanding.value?.data || [])
      .filter((b) => (b.amountDue || b.AmountDue || 0) > 0);

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
  }

  // Work orders section
  if (workOrders.status === 'fulfilled') {
    const open = Array.isArray(workOrders.value) ? workOrders.value : workOrders.value?.data || [];
    lines.push(`🔧 *Open Work Orders* (${open.length})`);
    if (open.length === 0) {
      lines.push(`• No open maintenance tickets ✅`);
    } else {
      open.slice(0, 10).forEach((wo) => {
        lines.push(
          `• #${wo.id || wo.Id} – ${wo.unit || wo.UnitName}: ${wo.description || wo.Description || 'No description'}`
        );
      });
      if (open.length > 10) lines.push(`  …and ${open.length - 10} more`);
    }
    lines.push(``);
  }

  // Lease section
  if (leases.status === 'fulfilled') {
    const active = Array.isArray(leases.value) ? leases.value : leases.value?.data || [];
    // Find leases expiring within 60 days
    const soon = active.filter((l) => {
      const end = new Date(l.endDate || l.EndDate || l.leaseToDate || '');
      if (isNaN(end.getTime())) return false;
      const daysLeft = (end.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      return daysLeft >= 0 && daysLeft <= 60;
    });

    lines.push(`📋 *Lease Expirations (next 60 days)* (${soon.length})`);
    if (soon.length === 0) {
      lines.push(`• No leases expiring soon ✅`);
    } else {
      soon.forEach((l) => {
        lines.push(
          `• ${l.tenantName || l.TenantName || 'Unknown'} (${l.unitName || l.UnitName}): ` +
            `expires ${l.endDate || l.EndDate || l.leaseToDate}`
        );
      });
    }
  }

  return lines.join('\n');
}

// ─── Delivery backends ────────────────────────────────────────────────────────

async function deliverViaTelegram(reportText) {
  await notifyLandlord(reportText);
  logger.info('Weekly report delivered via Telegram');
}

async function deliverViaEmail(_reportText) {
  // Placeholder: integrate with SendGrid, Nodemailer, etc.
  logger.warn('Email delivery is not yet implemented – configure an SMTP integration');
}

async function deliverViaGDrive(_reportText) {
  // Placeholder: integrate with Google Drive API (upload CSV/PDF).
  logger.warn('Google Drive delivery is not yet implemented – configure the Drive API integration');
}

// ─── Public entry point ───────────────────────────────────────────────────────

async function generateWeeklyReport() {
  const data = await aggregateWeeklyData();
  const reportText = formatTelegramReport(data);

  switch (config.reports.delivery) {
    case 'email':
      await deliverViaEmail(reportText);
      break;
    case 'gdrive':
      await deliverViaGDrive(reportText);
      break;
    case 'telegram':
    default:
      await deliverViaTelegram(reportText);
  }
}

module.exports = { generateWeeklyReport, aggregateWeeklyData, formatTelegramReport };
