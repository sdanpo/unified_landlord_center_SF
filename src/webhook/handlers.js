'use strict';

/**
 * Webhook event dispatcher.
 *
 * Receives a normalized event object and routes it to the appropriate
 * handler.  Each handler triggers the correct downstream action:
 *   – SMS alert to the tenant (via sms/dispatcher)
 *   – Telegram push notification to the landlord (via telegram/bot)
 *
 * Every handler logs extensively so you can trace exactly what happened
 * when any integration fails.  Look for the reqId field to correlate all
 * log lines belonging to a single incoming webhook request.
 */

const logger = require('../logger');

// Lazily required to avoid circular dependency during startup
let smsDispatcher;
let telegramBot;

function getSMS() {
  if (!smsDispatcher) smsDispatcher = require('../sms/dispatcher');
  return smsDispatcher;
}

function getTelegram() {
  if (!telegramBot) telegramBot = require('../telegram/bot');
  return telegramBot;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Mask a phone number for safe log output. */
function maskPhone(phone) {
  if (!phone || phone.length < 5) return '***';
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 5)}${phone.slice(-2)}`;
}

/**
 * Log the outcome of a Promise.allSettled result set.
 * `actions` is an array of { label, promise } descriptors whose order matches
 * the `results` array returned by Promise.allSettled.
 */
function logSettledResults(results, actions, { reqId, eventType }) {
  results.forEach((result, i) => {
    const label = actions[i]?.label || `action[${i}]`;
    if (result.status === 'fulfilled') {
      logger.info(`Handler action succeeded`, {
        reqId,
        eventType,
        action: label,
        result: result.value
          ? JSON.stringify(result.value).slice(0, 200)
          : 'no return value',
      });
    } else {
      logger.error(`Handler action failed`, {
        reqId,
        eventType,
        action: label,
        error: result.reason?.message || String(result.reason),
        stack: result.reason?.stack,
      });
    }
  });
}

// ─── Event handler map ───────────────────────────────────────────────────────

const handlers = {
  /**
   * Rent Overdue
   * Triggered when a tenant's grace period expires without payment.
   *
   * Actions:
   *   1. Send SMS reminder to the tenant
   *   2. Alert the landlord on Telegram
   */
  async 'rent.overdue'(event, { reqId } = {}) {
    const { tenantName, tenantId, tenantPhone, unit, propertyAddress, amountDue, leaseId } =
      event.data;

    logger.info('Handler: rent.overdue – starting', {
      reqId,
      tenantId,
      tenantName,
      unit,
      amountDue,
      leaseId,
      hasTenantPhone: !!tenantPhone,
      maskedPhone: maskPhone(tenantPhone),
    });

    const tenantMsg =
      `This is an automated alert from Management. ` +
      `Your rent balance of $${amountDue} for ${unit} at ${propertyAddress} is currently past due. ` +
      `Please remit payment via your tenant portal at your earliest convenience.`;

    const landlordMsg =
      `🚨 Rent Overdue Alert\n\n` +
      `Tenant: ${tenantName} (Unit ${unit})\n` +
      `Amount Due: $${amountDue}\n` +
      `Lease ID: ${leaseId}\n\n` +
      `An automated SMS reminder has been dispatched to the tenant.`;

    logger.debug('Handler: rent.overdue – composed messages', {
      reqId,
      tenantMsgLength: tenantMsg.length,
      landlordMsgLength: landlordMsg.length,
      smsWillBeSent: !!tenantPhone,
    });

    // tenantPhone is looked up from ERPNext before the event is raised;
    // skip SMS (but still alert landlord) if the number wasn't found.
    const smsPromise = tenantPhone
      ? getSMS().send({ tenantId, phone: tenantPhone, message: tenantMsg })
      : Promise.resolve({ skipped: true, reason: 'no phone number on record' });

    if (!tenantPhone) {
      logger.warn('Handler: rent.overdue – SMS skipped (no phone number)', { reqId, tenantId });
    }

    const actions = [
      { label: `SMS to tenant (${maskPhone(tenantPhone)})` },
      { label: 'Telegram landlord notification' },
    ];

    const results = await Promise.allSettled([smsPromise, getTelegram().notifyLandlord(landlordMsg)]);
    logSettledResults(results, actions, { reqId, eventType: 'rent.overdue' });

    logger.info('Handler: rent.overdue – complete', { reqId });
  },

  /**
   * Payment Received
   * Informs the landlord a payment has been posted to a lease.
   */
  async 'payment.received'(event, { reqId } = {}) {
    const { tenantName, unit, amountPaid, paymentMethod, leaseId } = event.data;

    logger.info('Handler: payment.received – starting', {
      reqId,
      tenantName,
      unit,
      amountPaid,
      paymentMethod,
      leaseId,
    });

    const landlordMsg =
      `✅ Payment Received\n\n` +
      `Tenant: ${tenantName} (Unit ${unit})\n` +
      `Amount: $${amountPaid}\n` +
      `Method: ${paymentMethod || 'Portal'}\n` +
      `Lease ID: ${leaseId}`;

    logger.debug('Handler: payment.received – composed Telegram message', {
      reqId,
      landlordMsgLength: landlordMsg.length,
    });

    const results = await Promise.allSettled([getTelegram().notifyLandlord(landlordMsg)]);
    logSettledResults(results, [{ label: 'Telegram landlord notification' }], {
      reqId,
      eventType: 'payment.received',
    });

    logger.info('Handler: payment.received – complete', { reqId });
  },

  /**
   * Work Order Created
   * Immediately alerts the landlord when a new maintenance ticket is opened.
   */
  async 'workorder.created'(event, { reqId } = {}) {
    const { id, unit, propertyAddress, description, priority, tenantName } = event.data;

    logger.info('Handler: workorder.created – starting', {
      reqId,
      ticketId: id,
      unit,
      priority,
      tenantName,
      descriptionSnippet: description?.slice(0, 80),
    });

    const landlordMsg =
      `🔧 New Maintenance Request\n\n` +
      `Unit: ${unit} – ${propertyAddress}\n` +
      `Tenant: ${tenantName}\n` +
      `Priority: ${priority || 'Normal'}\n` +
      `Issue: ${description}\n` +
      `Ticket #: ${id}`;

    logger.debug('Handler: workorder.created – composed Telegram message', {
      reqId,
      landlordMsgLength: landlordMsg.length,
    });

    const results = await Promise.allSettled([getTelegram().notifyLandlord(landlordMsg)]);
    logSettledResults(results, [{ label: 'Telegram landlord notification' }], {
      reqId,
      eventType: 'workorder.created',
    });

    logger.info('Handler: workorder.created – complete', { reqId });
  },

  /**
   * Work Order Updated
   * Notifies the landlord when a vendor posts an update.
   */
  async 'workorder.updated'(event, { reqId } = {}) {
    const { id, unit, status, vendorNotes } = event.data;

    logger.info('Handler: workorder.updated – starting', {
      reqId,
      ticketId: id,
      unit,
      newStatus: status,
      hasVendorNotes: !!(vendorNotes && vendorNotes.trim()),
      vendorNotesSnippet: vendorNotes?.slice(0, 80),
    });

    const landlordMsg =
      `📋 Maintenance Update – Ticket #${id}\n\n` +
      `Unit: ${unit}\n` +
      `New Status: ${status}\n` +
      `Vendor Notes: ${vendorNotes || 'No notes posted.'}`;

    logger.debug('Handler: workorder.updated – composed Telegram message', {
      reqId,
      landlordMsgLength: landlordMsg.length,
    });

    const results = await Promise.allSettled([getTelegram().notifyLandlord(landlordMsg)]);
    logSettledResults(results, [{ label: 'Telegram landlord notification' }], {
      reqId,
      eventType: 'workorder.updated',
    });

    logger.info('Handler: workorder.updated – complete', { reqId });
  },

  /**
   * Visit Scheduled
   * Notifies the landlord when a Maintenance Visit is created for a tenant's issue.
   */
  async 'visit.scheduled'(event, { reqId } = {}) {
    const { id, tenantName, unit, propertyAddress, purpose, maintenanceDate, completionStatus } =
      event.data;

    logger.info('Handler: visit.scheduled – starting', {
      reqId,
      visitId: id,
      tenantName,
      unit,
      purpose,
      maintenanceDate,
      completionStatus,
    });

    const landlordMsg =
      `🔨 Maintenance Visit Scheduled\n\n` +
      `Visit #: ${id}\n` +
      `Tenant: ${tenantName} (Unit ${unit})\n` +
      `Property: ${propertyAddress || unit}\n` +
      `Purpose: ${purpose || 'Maintenance'}\n` +
      `Date: ${maintenanceDate}\n` +
      (completionStatus ? `Status: ${completionStatus}` : '');

    logger.debug('Handler: visit.scheduled – composed Telegram message', {
      reqId,
      landlordMsgLength: landlordMsg.length,
    });

    const results = await Promise.allSettled([getTelegram().notifyLandlord(landlordMsg)]);
    logSettledResults(results, [{ label: 'Telegram landlord notification' }], {
      reqId,
      eventType: 'visit.scheduled',
    });

    logger.info('Handler: visit.scheduled – complete', { reqId });
  },

  /**
   * Lease Created – informational alert.
   */
  async 'lease.created'(event, { reqId } = {}) {
    const { tenantName, unit, startDate, endDate, monthlyRent } = event.data;

    logger.info('Handler: lease.created – starting', {
      reqId,
      tenantName,
      unit,
      startDate,
      endDate,
      monthlyRent,
    });

    const landlordMsg =
      `📝 New Lease Created\n\n` +
      `Tenant: ${tenantName}\n` +
      `Unit: ${unit}\n` +
      `Term: ${startDate} → ${endDate}\n` +
      `Monthly Rent: $${monthlyRent}`;

    logger.debug('Handler: lease.created – composed Telegram message', {
      reqId,
      landlordMsgLength: landlordMsg.length,
    });

    const results = await Promise.allSettled([getTelegram().notifyLandlord(landlordMsg)]);
    logSettledResults(results, [{ label: 'Telegram landlord notification' }], {
      reqId,
      eventType: 'lease.created',
    });

    logger.info('Handler: lease.created – complete', { reqId });
  },

  /**
   * Lease Expired – prompt to re-list or renew.
   */
  async 'lease.expired'(event, { reqId } = {}) {
    const { tenantName, unit } = event.data;

    logger.info('Handler: lease.expired – starting', { reqId, tenantName, unit });

    const landlordMsg =
      `⚠️ Lease Expired\n\n` +
      `Tenant: ${tenantName} (Unit ${unit})\n` +
      `The lease has expired. Please renew or re-list the unit.`;

    logger.debug('Handler: lease.expired – composed Telegram message', {
      reqId,
      landlordMsgLength: landlordMsg.length,
    });

    const results = await Promise.allSettled([getTelegram().notifyLandlord(landlordMsg)]);
    logSettledResults(results, [{ label: 'Telegram landlord notification' }], {
      reqId,
      eventType: 'lease.expired',
    });

    logger.info('Handler: lease.expired – complete', { reqId });
  },
};

// ─── Main dispatcher ─────────────────────────────────────────────────────────

/**
 * Routes a normalized PMS event to the correct handler.
 * Unknown event types are logged and silently ignored.
 *
 * @param {Object} event        – Normalized event object { type, data }
 * @param {Object} [ctx]        – Optional context (reqId for log correlation)
 */
async function handle(event, ctx = {}) {
  const { reqId } = ctx;
  const handler = handlers[event.type];

  if (!handler) {
    logger.warn('No handler registered for event type – ignoring', {
      reqId,
      eventType: event.type,
      registeredTypes: Object.keys(handlers),
    });
    return;
  }

  logger.debug('Dispatcher: routing event to handler', { reqId, eventType: event.type });

  try {
    await handler(event, ctx);
  } catch (err) {
    logger.error('Webhook handler threw an unhandled error', {
      reqId,
      eventType: event.type,
      error: err.message,
      stack: err.stack,
    });
    // Re-throw so the HTTP layer can return 500 and ERPNext will retry
    throw err;
  }
}

module.exports = { handle };
