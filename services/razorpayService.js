// ============================================================================
//  services/razorpayService.js — Razorpay Payment Links API
// ============================================================================

const axios = require('axios');
const config = require('../config');
const { ExternalServiceError } = require('../lib/errorHandler');

const LOG_PREFIX = '[Razorpay]';


async function createPaymentLink({ phone, referenceId }) {
  const url = `${config.RAZORPAY.BASE_URL}/payment_links/`;

  const body = {
    amount: config.SLP.AMOUNT,
    currency: config.SLP.CURRENCY,
    accept_partial: false,
    expire_by: config.SLP.EXPIRE_BY,
    reference_id: '',
    description: config.SLP.DESCRIPTION,
    customer: { contact: `+${phone}` },
    notify: { sms: false, email: false },
    reminder_enable: false,
  };

  try {
    const response = await axios.post(url, body, {
      auth: {
        username: config.RAZORPAY.KEY_ID,
        password: config.RAZORPAY.KEY_SECRET,
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: config.TIMEOUTS.DEFAULT,
    });

    const { short_url, id, reference_id } = response.data;
    console.log(`${LOG_PREFIX} Payment link created: ${id} (${reference_id})`);
    return { short_url, id, reference_id, status: response.data.status };
  } catch (error) {
    const description = error.response?.data?.error?.description || '';
    if (description.includes('already exists')) {
      console.log(`${LOG_PREFIX} Duplicate reference_id ${referenceId} — fetching existing link`);
      return await fetchPaymentLinkByReferenceId(referenceId);
    }
    const message = description || error.message;
    console.error(`${LOG_PREFIX} createPaymentLink failed: ${message}`);
    throw new ExternalServiceError(message, 'Razorpay');
  }
}


async function fetchPaymentLinkByReferenceId(referenceId) {
  const response = await axios.get(
    `${config.RAZORPAY.BASE_URL}/payment_links/?reference_id=${referenceId}`,
    { auth: { username: config.RAZORPAY.KEY_ID, password: config.RAZORPAY.KEY_SECRET } }
  );
  const link = response.data.payment_links?.[0];
  if (!link) return null;
  return {
    short_url: link.short_url,
    id: link.id,
    reference_id: link.reference_id,
    status: link.status,
  };
}


module.exports = {
  createPaymentLink,
};
