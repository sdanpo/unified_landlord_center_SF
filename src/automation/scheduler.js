'use strict';

/**
 * Scheduled jobs for the property management system.
 *
 * These functions are invoked on a cron schedule (ERPNext Scheduler Events
 * or an external cron).  Each function is self-contained and idempotent —
 * safe to call multiple times.
 */

const api    = require('../api/index');
const logger = require('../logger');

// Lazily loaded to avoid circular dependencies
function getNotifyLandlord() {
  return require('../telegram/bot').notifyLandlord;
}
function getSms() {
  return require('../sms/dispatcher');
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function daysOverdue(dueDateStr) {
  const due  = new Date(dueDateStr);
  const diff = Date.now() - due.getTime();
  return Math.floor(diff / 86_400_000);
}

// ─── Overdue Rent Check ───────────────────────────────────────────────────────

/**
 * Check for overdue invoices and send SMS reminders to tenants.
 * Fires a Telegram summary to the landlord after dispatching all SMSs.
 */
async function runOverdueRentCheck() {
  const notifyLandlord = getNotifyLandlord();
  const sms            = getSms();

  let invoices;
  try {
    invoices = await api.getOutstandingBalances();
  } catch (err) {
    logger.error('Overdue rent check: could not fetch invoices', { error: err.message });
    return;
  }

  // api.getOutstandingBalances() may return raw ERPNext fields or pre-mapped objects;
  // normalise both shapes here.
  const overdue = invoices
    .map(inv => ({
      tenantId:        inv.tenantId   || inv.customer,
      tenantName:      inv.tenantName || inv.customer_name,
      unitName:        inv.unitName   || inv.custom_unit   || '',
      propertyAddress: inv.propertyAddress || inv.custom_property || '',
      amountDue:       inv.amountDue  ?? inv.outstanding_amount,
      daysOverdue:     inv.daysOverdue ?? (inv.due_date ? daysOverdue(inv.due_date) : 0),
      mobile_no:       inv.mobile_no  || '',
    }))
    .filter(inv => inv.daysOverdue > 0);

  logger.info('Overdue rent check', { total: invoices.length, overdue: overdue.length });

  for (const inv of overdue) {
    const phone = inv.mobile_no || '';
    try {
      const msg = sms.templates.rentOverdue({
        unit:            inv.unitName,
        propertyAddress: inv.propertyAddress,
        amountDue:       inv.amountDue,
      });
      await sms.send(phone, msg);
    } catch (err) {
      logger.error('Failed to send overdue SMS', { tenant: inv.tenantName, error: err.message });
    }
  }

  // Telegram summary to landlord
  try {
    const plural = overdue.length === 1 ? 'tenant' : 'tenants';
    const summary = overdue.length === 0
      ? 'Overdue rent check: all rent payments are current.'
      : `Overdue rent check: ${overdue.length} ${plural} with outstanding balances.\n` +
        overdue.map(t => `  • ${t.tenantName}: $${t.amountDue}`).join('\n');
    await notifyLandlord(summary);
  } catch (err) {
    logger.error('Failed to send Telegram rent summary', { error: err.message });
  }
}

// ─── Stale Work Order Check ───────────────────────────────────────────────────

/**
 * Alert the landlord about open maintenance tickets older than the threshold.
 */
async function runStaleWorkOrderCheck() {
  const notifyLandlord = getNotifyLandlord();

  let tickets;
  try {
    tickets = await api.getStaleWorkOrders();
  } catch (err) {
    logger.error('Stale work order check: could not fetch tickets', { error: err.message });
    return;
  }

  if (!tickets || tickets.length === 0) return;

  logger.info('Stale work orders found', { count: tickets.length });

  const plural  = tickets.length === 1 ? 'ticket' : 'tickets';
  const message = `Stale maintenance ${plural} (open >48 h): ${tickets.length} open.\n` +
    tickets.slice(0, 10).map(t =>
      `  • [${t.name || t.ticket_name}] ${t.subject || t.description} — ${t.customer_name || t.customer || ''}`
    ).join('\n');

  try {
    await notifyLandlord(message);
  } catch (err) {
    logger.error('Failed to send stale work order alert', { error: err.message });
  }
}

module.exports = { runOverdueRentCheck, runStaleWorkOrderCheck };
