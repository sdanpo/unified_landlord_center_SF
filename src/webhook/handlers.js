'use strict';

/**
 * Webhook event dispatcher.
 *
 * Receives a normalized event object and routes it to the appropriate
 * handler.  Each handler triggers the correct downstream action:
 *   – SMS alert to the tenant (via sms/dispatcher)
 *   – Telegram push notification to the landlord (via telegram/bot)
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
  async 'rent.overdue'(event) {
    const { tenantName, tenantId, tenantPhone, unit, propertyAddress, amountDue, leaseId } =
      event.data;

    logger.info('Handling rent.overdue event', { tenantId, unit, amountDue });

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

    await Promise.allSettled([
      getSMS().send({ tenantId, phone: tenantPhone, message: tenantMsg }),
      getTelegram().notifyLandlord(landlordMsg),
    ]);
  },

  /**
   * Payment Received
   * Informs the landlord a payment has been posted to a lease.
   */
  async 'payment.received'(event) {
    const { tenantName, unit, amountPaid, paymentMethod, leaseId } = event.data;

    logger.info('Handling payment.received event', { unit, amountPaid });

    const landlordMsg =
      `✅ Payment Received\n\n` +
      `Tenant: ${tenantName} (Unit ${unit})\n` +
      `Amount: $${amountPaid}\n` +
      `Method: ${paymentMethod || 'Portal'}\n` +
      `Lease ID: ${leaseId}`;

    await getTelegram().notifyLandlord(landlordMsg);
  },

  /**
   * Work Order Created
   * Immediately alerts the landlord when a new maintenance ticket is opened.
   */
  async 'workorder.created'(event) {
    const { id, unit, propertyAddress, description, priority, tenantName } = event.data;

    logger.info('Handling workorder.created event', { id, unit });

    const landlordMsg =
      `🔧 New Maintenance Request\n\n` +
      `Unit: ${unit} – ${propertyAddress}\n` +
      `Tenant: ${tenantName}\n` +
      `Priority: ${priority || 'Normal'}\n` +
      `Issue: ${description}\n` +
      `Ticket #: ${id}`;

    await getTelegram().notifyLandlord(landlordMsg);
  },

  /**
   * Work Order Updated
   * Notifies the landlord when a vendor posts an update.
   */
  async 'workorder.updated'(event) {
    const { id, unit, status, vendorNotes } = event.data;

    logger.info('Handling workorder.updated event', { id, unit, status });

    const landlordMsg =
      `📋 Maintenance Update – Ticket #${id}\n\n` +
      `Unit: ${unit}\n` +
      `New Status: ${status}\n` +
      `Vendor Notes: ${vendorNotes || 'No notes posted.'}`;

    await getTelegram().notifyLandlord(landlordMsg);
  },

  /**
   * Lease Created – informational alert.
   */
  async 'lease.created'(event) {
    const { tenantName, unit, startDate, endDate, monthlyRent } = event.data;

    const landlordMsg =
      `📝 New Lease Created\n\n` +
      `Tenant: ${tenantName}\n` +
      `Unit: ${unit}\n` +
      `Term: ${startDate} → ${endDate}\n` +
      `Monthly Rent: $${monthlyRent}`;

    await getTelegram().notifyLandlord(landlordMsg);
  },

  /**
   * Lease Expired – prompt to re-list or renew.
   */
  async 'lease.expired'(event) {
    const { tenantName, unit } = event.data;

    const landlordMsg =
      `⚠️ Lease Expired\n\n` +
      `Tenant: ${tenantName} (Unit ${unit})\n` +
      `The lease has expired. Please renew or re-list the unit.`;

    await getTelegram().notifyLandlord(landlordMsg);
  },
};

// ─── Main dispatcher ─────────────────────────────────────────────────────────

/**
 * Routes a normalized PMS event to the correct handler.
 * Unknown event types are logged and silently ignored.
 */
async function handle(event, source) {
  const handler = handlers[event.type];

  if (!handler) {
    logger.debug('No handler registered for event type', { type: event.type, source });
    return;
  }

  try {
    await handler(event);
  } catch (err) {
    logger.error('Webhook handler threw an error', {
      eventType: event.type,
      error: err.message,
    });
    // Re-throw so the HTTP layer can return 500 and the PMS will retry
    throw err;
  }
}

module.exports = { handle };
