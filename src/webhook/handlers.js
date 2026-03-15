'use strict';

/**
 * ERPNext webhook event dispatcher.
 *
 * Receives a normalised event object from the webhook server and routes it
 * to the appropriate notification channels (Telegram, SMS).
 *
 * Event types:
 *   rent.overdue       – Sales Invoice becomes overdue
 *   payment.received   – Payment Entry recorded (card or ACH confirmed)
 *   payment.pending    – ACH checkout completed; awaiting bank confirmation
 *   payment.failed     – ACH payment bounced
 *   workorder.created  – HD Ticket opened
 *   lease.created      – Lease / Property Agreement submitted
 *   lease.expired      – Lease / Property Agreement cancelled
 *   application.submitted – New rental application via /apply Web Form
 *   lease.signed       – All parties have completed e-signature (Dropbox Sign)
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
        (data.paymentMethod ? ` via ${data.paymentMethod}` : '')
      );
      break;

    case 'payment.pending':
      await notifyLandlord(
        `🕐 ACH payment pending: ${data.tenantName} initiated ${data.amount} bank transfer for ${data.invoiceName} — funds arrive in 1-5 business days`
      );
      break;

    case 'payment.failed':
      await notifyLandlord(
        `❌ ACH payment FAILED: ${data.tenantName} — ${data.amount} bank transfer for ${data.invoiceName} was rejected. Contact tenant to arrange alternative payment.`
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

    case 'application.submitted':
      await notifyLandlord(
        `📋 New rental application:\n` +
        `  Name: ${data.firstName} ${data.lastName}\n` +
        `  Email: ${data.email}   Phone: ${data.phone}\n` +
        `  Income: $${data.monthlyIncome}/mo   Occupants: ${data.occupants}\n` +
        `  Eviction history: ${data.hasEviction}\n` +
        `Reply "screen ${data.leadName}" to send a SmartMove screening request.`
      );
      break;

    case 'lease.signed': {
      const sms = require('../sms/dispatcher');
      // SMS to tenant confirming fully-executed lease
      if (data.tenantPhone) {
        try {
          const msg = sms.templates.leaseSignedConfirmation({
            unit:      data.unitName  || '',
            startDate: data.startDate || '',
          });
          await sms.send(data.tenantPhone, msg);
        } catch (err) {
          logger.error('Failed to send lease-signed SMS', { error: err.message });
        }
      }
      await notifyLandlord(
        `✅ Lease signed: ${data.tenantName} — ${data.unitName}\n` +
        '  All parties have signed. PDF saved to ERPNext Lease record.'
      );
      break;
    }

    default:
      logger.warn('Unknown webhook event type', { type });
  }
}

module.exports = { handle };
