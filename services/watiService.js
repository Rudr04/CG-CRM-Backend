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
  const num = params.form_num || '';
  const isOffline = params.option === "Offline (અમદાવાદ ક્લાસ માં)";
  const choice = isOffline ? "offline" : "online";

  if (!waId) throw new ValidationError('Phone number (wa_num) is required');

  // Use config for group links and template names
  const grpLink = isOffline 
    ? config.WATI.GROUP_LINKS.OFFLINE 
    : config.WATI.GROUP_LINKS.ONLINE;
  
  const templateName = isOffline 
    ? config.WATI.TEMPLATES.OFFLINE_CONFIRMATION 
    : config.WATI.TEMPLATES.ONLINE_CONFIRMATION;

  const endpoint = `/api/v1/sendTemplateMessage?whatsappNumber=${waId}`;
  
  const response = await watiRequest('post', endpoint, {
    template_name: templateName,
    broadcast_name: config.WATI.BROADCAST_NAME,
    parameters: [
      { name: "mcregiform_screen_0_textinput_0", value: name },
      { name: "mcregiform_screen_0_textinput_1", value: num },
      { name: "dynamic_track", value: `?num=${waId}&dest=${grpLink}` }
    ]
  });

  if (response.status === 200) {
    await setRegistrationApprovalAttribute(waId, choice);
    console.log(`${LOG_PREFIX} Registration confirmation sent to ${waId} (${choice})`);
    return true;
  }
  return false;
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