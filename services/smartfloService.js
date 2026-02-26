// ============================================================================
//  services/smartfloService.js — Smartflo Calling API
//
//  Creates contacts in Smartflo for click-to-call.
//  Uses centralized helpers and config.
// ============================================================================

const axios = require('axios');
const config = require('../config');
const { sanitizeName } = require('../utils/helpers');
const { ConfigError, ExternalServiceError } = require('../lib/errorHandler');

const LOG_PREFIX = '[Smartflo]';


// ═══════════════════════════════════════════════════════════════════════════
//  CREATE CONTACT
// ═══════════════════════════════════════════════════════════════════════════

async function createContact(phoneNumber, name, source = 'unknown') {
  if (!config.SMARTFLO.API_KEY) {
    throw new ConfigError('SMARTFLO_API_KEY not set');
  }
  if (!config.SMARTFLO.CONTACT_GROUP_ID) {
    throw new ConfigError('SMARTFLO_CONTACT_GROUP_ID not set');
  }

  // Use centralized sanitizeName from helpers
  const contactName = sanitizeName(name) || phoneNumber;
  const url = `${config.SMARTFLO.BASE_URL}/v1/contact/${config.SMARTFLO.CONTACT_GROUP_ID}`;

  console.log(`${LOG_PREFIX} Creating contact: ${phoneNumber} (${contactName}) source=${source}`);

  try {
    const response = await axios.post(
      url,
      { field_0: phoneNumber, field_1: contactName },
      {
        headers: {
          'accept': 'application/json',
          'Authorization': config.SMARTFLO.API_KEY,
          'content-type': 'application/json'
        },
        timeout: config.TIMEOUTS.SMARTFLO
      }
    );

    console.log(`${LOG_PREFIX} Contact created: ${phoneNumber}`);
    return response.data;

  } catch (err) {
    const status = err.response?.status;

    if (status === 409) {
      console.log(`${LOG_PREFIX} Contact already exists: ${phoneNumber}`);
      return { alreadyExists: true };
    }

    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`${LOG_PREFIX} createContact failed (${status || 'network'}): ${detail}`);
    throw new ExternalServiceError(detail, 'Smartflo', { phoneNumber, status });
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  createContact
};