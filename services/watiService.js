// ============================================================================
//  services/watiService.js — WATI WhatsApp API
//
//  All WhatsApp messaging via WATI platform.
//  Uses centralized config for URLs, templates, timeouts.
// ============================================================================

const axios = require('axios');
const config = require('../config');
const { normalizePhone } = require('../utils/helpers');
const { ValidationError, ExternalServiceError } = require('../lib/errorHandler');

const LOG_PREFIX = '[WATI]';


// ═══════════════════════════════════════════════════════════════════════════
//  INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function getBaseUrl() {
  return `${config.WATI.BASE_URL}${config.WATI.TENANT_ID}`;
}

function getAuthHeaders() {
  return {
    'Authorization': `Bearer ${config.WATI.BEARER_TOKEN}`,
    'Content-Type': 'application/json',
    'accept': '*/*'
  };
}

async function watiRequest(method, endpoint, data = null) {
  const url = `${getBaseUrl()}${endpoint}`;
  try {
    const response = await axios({
      method,
      url,
      data,
      headers: getAuthHeaders(),
      timeout: config.TIMEOUTS.WATI
    });
    return response;
  } catch (error) {
    console.error(`${LOG_PREFIX} Request failed: ${endpoint}`, error.message);
    throw new ExternalServiceError(error.message, 'WATI');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  SESSION MESSAGES
// ═══════════════════════════════════════════════════════════════════════════

async function sendSessionMessage(waId, messageText) {
  if (!waId) throw new ValidationError('Phone number (waId) is required');

  const cleanPhone = normalizePhone(waId);
  const endpoint = `/api/v1/sendSessionMessage/${cleanPhone}?messageText=${encodeURIComponent(messageText)}`;

  const response = await watiRequest('post', endpoint);
  console.log(`${LOG_PREFIX} Session message sent to ${cleanPhone}`);
  return response.status === 200;
}


// ═══════════════════════════════════════════════════════════════════════════
//  CONTACT ATTRIBUTES
// ═══════════════════════════════════════════════════════════════════════════

async function setWaidAttribute(params) {
  const waId = params.waId || '';
  if (!waId) throw new ValidationError('Phone number (waId) is required');

  const endpoint = `/api/v1/updateContactAttributes/${waId}`;
  const response = await watiRequest('post', endpoint, {
    customParams: [{ name: 'waid', value: waId }]
  });
  
  console.log(`${LOG_PREFIX} Set waid attribute for ${waId}`);
  return response.status === 200;
}

async function setRegistrationApprovalAttribute(waId, approvalType) {
  const endpoint = `/api/v1/updateContactAttributes/${waId}`;
  try {
    await watiRequest('post', endpoint, {
      customParams: [{ name: 'mc_approve', value: approvalType }]
    });
    return true;
  } catch (error) {
    console.error(`${LOG_PREFIX} setRegistrationApprovalAttribute error:`, error.message);
    return false;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  TEMPLATE MESSAGES
// ═══════════════════════════════════════════════════════════════════════════

async function sendRegistrationConfirmation(params) {
  const waId = params.wa_num || '';
  const name = params.name || '';
  const isEvening = params.option === config.FORM_OPTIONS.EVENING_OPTION;

  if (!waId) throw new ValidationError('Phone number (wa_num) is required');

  const grpLink = isEvening
    ? config.WATI.GROUP_LINKS.EVENING
    : config.WATI.GROUP_LINKS.MORNING;

  const dynamicLink = `${config.WATI.REDIRECT_BASE}/?num=${waId}&dest=${encodeURIComponent(grpLink)}`;

  const message = isEvening
    ? `🙏 शुभम! ${name}Ji\n*✅ आपका CVPT मास्टरक्लास के लिए रजिस्ट्रेशन सफल हो गया है.*\n\n📅 ${config.FORM_OPTIONS.MC_DATE_HINDI} - ${config.FORM_OPTIONS.MC_TIME_EVENING}\n*🆔 Registration No: ${waId}*\n\nआप इस नंबर से मास्टरक्लास जॉइन कर सकेंगे।\n🔗 लिंक और अधिक जानकारी के लिए WhatsApp ग्रुप जॉइन करें:\n${dynamicLink}`
    : `🙏 Shubham! ${name}Ji\n*✅ આપનું CVPT માસ્ટરક્લાસ માટે રજીસ્ટ્રેશન સફળ થયું છે.*\n\n📅 ${config.FORM_OPTIONS.MC_DATE_GUJ} - ${config.FORM_OPTIONS.MC_TIME_MORNING}\n*🆔 Registration No: ${waId}*\n\nઆપ આ નંબર દ્વારા માસ્ટરક્લાસ જોઈન કરી શકશો.\n🔗 લિંક અને વધુ માહિતી માટે WhatsApp ગ્રુપ જોઈન કરો:\n${dynamicLink}`;

  await sendSessionMessage(waId, message);

  const choice = isEvening ? 'evening' : 'morning';
  await setRegistrationApprovalAttribute(waId, choice);
  console.log(`${LOG_PREFIX} Registration confirmation sent to ${waId} (${choice})`);
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════
//  CONTACT DETAILS
// ═══════════════════════════════════════════════════════════════════════════

async function getContactDetails(phoneNumber) {
  const sanitizedPhone = normalizePhone(phoneNumber);
  const endpoint = `/api/v1/getContacts?name=${sanitizedPhone}`;

  const response = await watiRequest('get', endpoint);

  if (response.data?.result === "success" && response.data.contact_list?.length > 0) {
    return { result: true, contact: response.data.contact_list[0] };
  }
  
  throw new ExternalServiceError('No contact found', 'WATI');
}


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  sendSessionMessage,
  setWaidAttribute,
  setRegistrationApprovalAttribute,
  sendRegistrationConfirmation,
  getContactDetails
};