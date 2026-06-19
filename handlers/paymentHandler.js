// ============================================================================
//  handlers/paymentHandler.js — Payment Event Handlers
//
//  Lookup: Try Firestore first (fast), Sheet fallback (scan)
// ============================================================================

const FirestoreService = require('../services/firestoreService');
const SheetService     = require('../services/sheetsService');
const { ExternalServiceError } = require('../lib/errorHandler');

const LOG_PREFIX = '[Payment]';

const { Firestore } = require('@google-cloud/firestore');
const firestore = new Firestore();


async function handlePayment(params) {
  try {
    console.log(`${LOG_PREFIX} Processing payment`);

    const paymentNumber = params.phone || params.contact_number;

    // Try Firestore first (fast single doc lookup)
    const firestoreLead = await FirestoreService.findLeadByPhone(paymentNumber);
    if (firestoreLead) {
      console.log(`${LOG_PREFIX} Matched via Firestore: ${firestoreLead.data.cgId}`);
      return { status: 'payment_processed', cgId: firestoreLead.data.cgId };
    }

    // Fallback: Sheet scan
    const sheetLead = await SheetService.findByPhone(paymentNumber);
    if (sheetLead) {
      console.log(`${LOG_PREFIX} Matched via Sheet row ${sheetLead.row}`);
      return { status: 'payment_processed', row: sheetLead.row };
    }

    console.log(`${LOG_PREFIX} No match - manual review required`);
    return { status: 'manual_review_required', phone: paymentNumber };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error: ${error.message}`);
    throw new ExternalServiceError(error.message, 'Payment', { handler: 'handlePayment' });
  }
}

async function captureRazorpayPayload(params) {
  await firestore.collection('_debug_razorpay_webhooks').add({
    receivedAt: new Date().toISOString(),
    payload: params,
  });
  console.log('[Debug] Razorpay payload captured to _debug_razorpay_webhooks');
  return { status: 'debug_captured' };
}

module.exports = {
  handlePayment,
  captureRazorpayPayload
};