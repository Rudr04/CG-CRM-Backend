// ============================================================================
//  handlers/paymentHandler.js — Payment Event Handlers
// ============================================================================

const SheetService = require('../services/sheetsService');
const { ExternalServiceError } = require('../lib/errorHandler');

const LOG_PREFIX = '[Payment]';


async function handlePayment(params) {
  try {
    console.log(`${LOG_PREFIX} Processing payment`);
    
    const paymentNumber = params.phone || params.contact_number;
    const matchedUser = await SheetService.findUserByPhoneNumber(paymentNumber);

    if (matchedUser) {
      console.log(`${LOG_PREFIX} Matched row ${matchedUser.row}`);
      return { status: 'payment_processed', row: matchedUser.row };
    } else {
      console.log(`${LOG_PREFIX} No match - manual review required`);
      return { status: 'manual_review_required', phone: paymentNumber };
    }

  } catch (error) {
    console.error(`${LOG_PREFIX} Error: ${error.message}`);
    throw new ExternalServiceError(error.message, 'Payment', { handler: 'handlePayment' });
  }
}


module.exports = {
  handlePayment
};