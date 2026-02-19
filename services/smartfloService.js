const axios = require('axios');
const config = require('../config');

const SMARTFLO_BASE_URL = 'https://api-smartflo.tatateleservices.com';

/**
 * Strips emojis and special characters that Smartflo rejects in the name field.
 * Keeps letters (including unicode/accented), numbers, spaces, and hyphens.
 * Falls back to phone number if name is empty after sanitization.
 *
 * Rejected chars per Smartflo error: !@#$%^&()_-+=:;\\,.></?|{}[]*
 */
function sanitizeName(name) {
  if (!name) return '';
  return name
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '') // strip emojis
    .replace(/[!@#$%^&*()_+=:;\\,.></?|{}[\]]/g, '')                   // strip special chars
    .replace(/\s+/g, ' ')                                                // collapse extra spaces
    .trim();
}

/**
 * Creates a contact in a Smartflo contact group.
 *
 * Auth:     Static API key in Authorization header â€” no login needed.
 * Endpoint: POST /v1/contact/{contactGroupId}
 * Body:     { field_0: phoneNumber, field_1: name }
 *
 * Phone number is passed as-is from WATI (e.g. "918780524283") â€” already correct format.
 */
async function createContact(phoneNumber, name) {
  if (!config.SMARTFLO.API_KEY) {
    throw new Error('[Smartflo] SMARTFLO_API_KEY env var is not set');
  }
  if (!config.SMARTFLO.CONTACT_GROUP_ID) {
    throw new Error('[Smartflo] SMARTFLO_CONTACT_GROUP_ID env var is not set');
  }

  const contactName = sanitizeName(name) || phoneNumber;
  const url = `${SMARTFLO_BASE_URL}/v1/contact/${config.SMARTFLO.CONTACT_GROUP_ID}`;

  console.log(`[Smartflo] Creating contact: ${phoneNumber} (${contactName})`);

  try {
    const response = await axios.post(
      url,
      {
        field_0: phoneNumber,
        field_1: contactName
      },
      {
        headers: {
          accept:         'application/json',
          Authorization:  config.SMARTFLO.API_KEY,
          'content-type': 'application/json'
        },
        timeout: 10000
      }
    );

    console.log(`[Smartflo] Contact created: ${phoneNumber}`, response.data);
    return response.data;

  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;

    if (status === 409) {
      console.log(`[Smartflo] Contact ${phoneNumber} already exists (409)`);
      return { alreadyExists: true };
    }

    throw new Error(`[Smartflo] createContact failed (${status ?? 'network'}): ${detail}`);
  }
}

module.exports = { createContact };