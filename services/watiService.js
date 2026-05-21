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
    customParams: [
      { name: 'waid', value: waId },
      { name: 'mc_form_filled', value: 'FALSE' }
    ]
  });
  
  console.log(`${LOG_PREFIX} Set waid attribute for ${waId}`);
  return response.status === 200;
}

// ═══════════════════════════════════════════════════════════════════════════
//  GENERIC CONTACT ATTRIBUTE
// ═══════════════════════════════════════════════════════════════════════════

async function setContactAttribute(waId, attrNameOrArray, attrValue) {
  if (!waId) throw new ValidationError('Phone number (waId) is required');

  const endpoint = `/api/v1/updateContactAttributes/${waId}`;

  const customParams = Array.isArray(attrNameOrArray)
    ? attrNameOrArray
    : [{ name: attrNameOrArray, value: attrValue }];

  try {
    await watiRequest('post', endpoint, { customParams });
    console.log(`${LOG_PREFIX} Set attributes for ${waId}: ${customParams.map(p => p.name).join(', ')}`);
    return true;
  } catch (error) {
    console.error(`${LOG_PREFIX} setContactAttribute error:`, error.message);
    return false;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  START CHATBOT
// ═══════════════════════════════════════════════════════════════════════════

async function startChatbot(waId, chatbotId) {
  if (!waId) throw new ValidationError('Phone number (waId) is required');
  if (!chatbotId) throw new ValidationError('Chatbot ID is required');

  const endpoint = `/api/v1/chatbots/start?whatsappNumber=${waId}&chatbotId=${chatbotId}`;

  try {
    const response = await watiRequest('post', endpoint);
    console.log(`${LOG_PREFIX} Started chatbot ${chatbotId} for ${waId}`);
    return response.status === 200;
  } catch (error) {
    console.error(`${LOG_PREFIX} startChatbot(${chatbotId}) error:`, error.message);
    return false;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  TEMPLATE MESSAGES
// ═══════════════════════════════════════════════════════════════════════════

async function sendTemplateMessage(phoneOrPhones, templateName, customParams = [], broadcastName = 'crm_auto') {
  const phones = Array.isArray(phoneOrPhones) ? phoneOrPhones : [phoneOrPhones];

  const receivers = phones.map(p => ({
    whatsappNumber: normalizePhone(p),
    localMessageId: '',
    customParams,
  }));

  const endpoint = '/api/v1/sendTemplateMessages';

  const response = await watiRequest('post', endpoint, {
    template_name: templateName,
    broadcast_name: broadcastName,
    receivers,
    channel_number: '',
  });

  console.log(`${LOG_PREFIX} Template '${templateName}' sent to ${receivers.length} receiver(s)`);
  return response.status === 200;
}

async function sendRegistrationConfirmation(params) {
  const waId = params.wa_num || '';
  const name = params.name || '';

  if (!waId) throw new ValidationError('Phone number (wa_num) is required');

  const isEvening = params.option === config.FORM_OPTIONS.EVENING_OPTION;
  const choice = isEvening ? 'evening' : 'morning';

  const link = isEvening
    ? `https://join-wa.cosmoguru.com/e/${waId}`
    : `https://join-wa.cosmoguru.com/m/${waId}`;

  const message = isEvening
    ? `🙏 शुभम! ${name}Ji\n\n*Free Demo Class માટે નીચે આપેલ લિંક પર ક્લિક કરીને WhatsApp ગ્રુપ જોડાઓ.👇*\n${link}\n\n🆔 आपका रजिस्टर्ड नंबर: ${waId}`
    : `🙏 શુભમ! ${name}Ji\n\n*આપનું CVPT માસ્ટરક્લાસ માટે રજીસ્ટ્રેશન સફળ થયું છે.👇*\n${link}\n\n🆔 આપનો રજિસ્ટર્ડ નંબર: ${waId}`;
  
  await setContactAttribute(waId, [
      { name: 'mc_approve', value: choice },
      { name: 'mc_form_filled', value: 'TRUE' },
    ]);

  await sendSessionMessage(waId, message);
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
  setContactAttribute,
  startChatbot,
  sendRegistrationConfirmation,
  getContactDetails,
  sendTemplateMessage
};