'use strict';

/**
 * ERPNext webhook event dispatcher.
 *
 * Receives a normalised event object from the webhook server and routes it
 * to the appropriate notification channels (Telegram, SMS).
 *
 * Event types:
 *   rent.overdue       – Sales Invoice becomes overdue
 *   payment.received   – Payment Entry recorded
 *   workorder.created  – HD Ticket opened
 *   lease.created      – Lease / Property Agreement submitted
 *   lease.expired      – Lease / Property Agreement cancelled
 */

const logger = require('../logger');

// Lazily required to avoid startup cost / circular deps
function getNotifyLandlord() {
  return require('../telegram/bot').notifyLandlord;
}

/**
 * Handle a single normalised event from ERPNext.
 * @param {{ type: string, data: object }} event
 */
async function handle(event) {
  const { type, data } = event;
  const notifyLandlord = getNotifyLandlord();

  logger.info('Webhook event received', { type });

  switch (type) {
    case 'rent.overdue':
      await notifyLandlord(
        `⚠️ Rent overdue: ${data.tenantName} (${data.unitName}) — $${data.amountDue} past due`
      );
      break;

    case 'payment.received':
      await notifyLandlord(
        `✅ Payment received: ${data.tenantName} paid $${data.amountPaid}` +
        (data.mode ? ` via ${data.mode}` : '')
      );
      break;

    case 'workorder.created':
      await notifyLandlord(
        `🔧 New maintenance ticket: [${data.ticketId}] ${data.subject} — ${data.tenantName}`
      );
      break;

    case 'lease.created':
      await notifyLandlord(
        `📄 New lease submitted: ${data.tenantName} — ${data.unitName}`
      );
      break;

    case 'lease.expired':
      await notifyLandlord(
        `📋 Lease cancelled: ${data.tenantName} — ${data.unitName}`
      );
      break;

    default:
      logger.warn('Unknown webhook event type', { type });
  }
}

module.exports = { handle };
