const SheetService = require('../services/sheetsService');

async function handlePayment(params) {
  try {
    const paymentNumber = params.phone || params.contact_number;
    const matchedUser = await SheetService.findUserByPhoneNumber(paymentNumber);

    if (matchedUser) {
      console.log('Payment matched');
      return { status: 'payment_processed' };
    } else {
      console.log('Manual review required');
      return { status: 'manual_review_required' };
    }
  } catch (error) {
    console.error('Payment error:', error.message);
    throw error;
  }
}

module.exports = { handlePayment };