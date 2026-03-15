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

// ─── Lease Renewal Check ──────────────────────────────────────────────────────

/**
 * Check for leases expiring within the next 90 days.
 * Sends SMS reminders to tenants at 90 / 60 / 30 / 14-day milestones and a
 * Telegram summary to the landlord.  Uses custom_renewal_notice_sent on Lease
 * to prevent duplicate alerts within the same 30-day window.
 */
async function runLeaseRenewalCheck() {
  const notifyLandlord = getNotifyLandlord();
  const sms            = getSms();

  let leases;
  try {
    leases = await api.getExpiringLeases(90);
  } catch (err) {
    logger.error('Lease renewal check: could not fetch leases', { error: err.message });
    return;
  }

  if (!leases || leases.length === 0) {
    logger.info('Lease renewal check: no leases expiring within 90 days');
    return;
  }

  const today    = new Date(); today.setHours(0, 0, 0, 0);
  const THIRTY   = 30 * 86_400_000;
  const alerts   = [];

  for (const lease of leases) {
    const end      = new Date(lease.end_date);
    const daysLeft = Math.ceil((end.getTime() - today.getTime()) / 86_400_000);

    // Only alert at 90, 60, 30, or 14-day milestones
    const isMilestone = [90, 60, 30, 14].includes(daysLeft);
    if (!isMilestone) continue;

    // Deduplicate: skip if we already sent a notice within the last 30 days
    if (lease.custom_renewal_notice_sent) {
      const lastSent = new Date(lease.custom_renewal_notice_sent);
      if (today.getTime() - lastSent.getTime() < THIRTY) continue;
    }

    // Fetch tenant phone number
    let mobile = '';
    try {
      const tenant = await api.getTenant(lease.lease_customer);
      mobile = tenant?.mobile_no || '';
    } catch (_) { /* phone optional */ }

    const tenantName = lease.lease_customer || 'Tenant';
    const unit       = lease.property || '';
    const endDateStr = end.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // SMS to tenant
    if (mobile) {
      try {
        const msg = sms.templates.leaseRenewalNotice({ tenantName, unit, endDate: endDateStr, daysLeft });
        await sms.send(mobile, msg);
      } catch (err) {
        logger.error('Failed to send lease renewal SMS', { lease: lease.name, error: err.message });
      }
    }

    // Mark notice sent in ERPNext
    try {
      await api.updateLease(lease.name, {
        custom_renewal_notice_sent: today.toISOString().split('T')[0],
      });
    } catch (err) {
      logger.error('Failed to update custom_renewal_notice_sent', { lease: lease.name, error: err.message });
    }

    alerts.push({ tenantName, unit, endDateStr, daysLeft, lease: lease.name });
  }

  logger.info('Lease renewal check complete', { expiring: leases.length, alerted: alerts.length });

  if (alerts.length === 0) return;

  // Telegram summary to landlord
  try {
    const lines = alerts.map(a =>
      `  • ${a.tenantName} — ${a.unit}: ${a.daysLeft} days (${a.endDateStr})`
    ).join('\n');
    await notifyLandlord(
      `📋 Lease renewal reminders sent (${alerts.length}):\n${lines}\n\n` +
      'Reply "renew [lease]", "vacate [lease]", or ask me for details.'
    );
  } catch (err) {
    logger.error('Failed to send Telegram lease renewal summary', { error: err.message });
  }
}

// ─── Daily Late Fee Check ─────────────────────────────────────────────────────

/**
 * For each overdue rent invoice, calculate and create a daily late fee Sales Invoice
 * once the lease's grace period has elapsed.
 *
 * Deduplication: a late fee is only created once per invoice per calendar day
 * (checked via custom_is_late_fee + custom_original_invoice + custom_late_fee_date).
 *
 * SMS is sent only on the first day a late fee is charged (not every day).
 *
 * Invoice submission behaviour is controlled by LATE_FEE_AUTO_SUBMIT env var:
 *   "1"  → docstatus=1 (submitted, immediately visible on tenant's portal)
 *   "0"  → docstatus=0 (draft, accountant must review before submitting)
 */
async function runLateFeeCheck() {
  const notifyLandlord = getNotifyLandlord();
  const sms            = getSms();
  const autoSubmit     = process.env.LATE_FEE_AUTO_SUBMIT === '1';
  const today          = new Date().toISOString().split('T')[0];

  let invoices;
  try {
    invoices = await api.getOutstandingBalances();
  } catch (err) {
    logger.error('Late fee check: could not fetch overdue invoices', { error: err.message });
    return;
  }

  if (!invoices || invoices.length === 0) return;

  const applied = [];

  for (const inv of invoices) {
    // Need a linked Lease to get grace period and fee configuration
    const leaseId = inv.custom_lease || inv.leaseId;
    if (!leaseId) continue;

    let lease;
    try {
      lease = await api.getLease(leaseId);
    } catch (_) {
      continue;
    }

    const graceDays = Number(lease.custom_late_fee_grace_days ?? 5);
    const daysOD    = inv.daysOverdue ?? (inv.due_date ? daysOverdue(inv.due_date) : 0);

    if (daysOD <= graceDays) continue; // still within grace period

    // Calculate the fee for today
    const outstandingAmt = Number(inv.amountDue ?? inv.outstanding_amount ?? 0);
    const feeType        = lease.custom_late_fee_type || 'Percentage';
    let feeAmount;
    if (feeType === 'Flat Amount') {
      feeAmount = Number(lease.custom_late_fee_flat_amount || 0);
    } else {
      // Percentage: use late_payment_interest_percentage (already on Lease)
      const pct = Number(lease.late_payment_interest_percentage || 0);
      feeAmount = outstandingAmt * (pct / 100);
    }

    if (!feeAmount || feeAmount <= 0) continue;

    // Dedup: skip if we already created a late fee for this invoice today
    let alreadyCharged;
    try {
      alreadyCharged = await api.getTodayLateFeeForInvoice(inv.name, today);
    } catch (_) {
      alreadyCharged = false;
    }
    if (alreadyCharged) continue;

    // Is this the FIRST late fee day? (for SMS decision)
    let isFirstDay = true;
    try {
      isFirstDay = !(await api.hasAnyLateFeeForInvoice(inv.name));
    } catch (_) { /* default to sending SMS */ }

    // Create the late fee invoice
    let lateFeeInv;
    try {
      lateFeeInv = await api.createLateFeeInvoice({
        customer:            inv.tenantId  || inv.customer,
        company:             inv.company   || '',
        feeAmount,
        today,
        originalInvoiceName: inv.name,
        customUnit:          inv.unitName  || inv.custom_unit     || '',
        customProperty:      inv.propertyAddress || inv.custom_property || '',
        customLease:         leaseId,
        autoSubmit,
      });
      logger.info('Late fee invoice created', { name: lateFeeInv.name, amount: feeAmount, invoice: inv.name });
    } catch (err) {
      logger.error('Failed to create late fee invoice', { invoice: inv.name, error: err.message });
      continue;
    }

    applied.push({
      tenantName: inv.tenantName || inv.customer_name,
      unitName:   inv.unitName   || inv.custom_unit || '',
      feeAmount,
      daysOD,
      invoiceName: lateFeeInv.name,
    });

    // SMS only on first day (avoid daily fatigue)
    if (isFirstDay) {
      const mobile = inv.mobile_no || '';
      if (mobile) {
        try {
          const msg = sms.templates.lateFeeCharged({
            unit:      inv.unitName || inv.custom_unit || '',
            feeAmount,
            totalDue:  outstandingAmt + feeAmount,
            dayNumber: daysOD,
          });
          await sms.send(mobile, msg);
        } catch (err) {
          logger.error('Failed to send late fee SMS', { tenant: inv.tenantName, error: err.message });
        }
      }
    }
  }

  logger.info('Late fee check complete', { invoices: invoices.length, applied: applied.length });

  if (applied.length === 0) return;

  // Telegram daily summary to landlord
  try {
    const submitNote = autoSubmit ? '(submitted — tenant balances updated)' : '(draft — review in ERPNext before submitting)';
    const lines = applied.map(a =>
      `  • ${a.tenantName} — ${a.unitName}: $${a.feeAmount.toFixed(2)} (day ${a.daysOD} overdue)`
    ).join('\n');
    await notifyLandlord(
      `💸 Late fees applied today: ${applied.length} invoice(s) ${submitNote}\n${lines}`
    );
  } catch (err) {
    logger.error('Failed to send Telegram late fee summary', { error: err.message });
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

module.exports = { runOverdueRentCheck, runStaleWorkOrderCheck, runLeaseRenewalCheck, runLateFeeCheck };
