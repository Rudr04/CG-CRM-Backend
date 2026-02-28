// ============================================================================
//  handlers/paymentHandler.js — Payment Event Handlers
//
//  Lookup: Try Firestore first (fast), Sheet fallback (scan)
// ============================================================================

const FirestoreService = require('../services/firestoreService');
const SheetService     = require('../services/sheetsService');
const { ExternalServiceError } = require('../lib/errorHandler');

const LOG_PREFIX = '[Payment]';


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


module.exports = {
  handlePayment
};