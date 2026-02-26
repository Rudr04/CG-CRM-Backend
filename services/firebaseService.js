// ============================================================================
//  services/firebaseService.js — Firebase Realtime Database (Whitelist)
//
//  Handles whitelist operations only. Separate from Firestore (CRM).
// ============================================================================

const axios = require('axios');
const config = require('../config');
const { sanitizePhoneForFirebase, cleanString, nowISO } = require('../utils/helpers');

const LOG_PREFIX = '[Firebase]';


// ═══════════════════════════════════════════════════════════════════════════
//  WHITELIST OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

async function addToWhitelist(phoneNumber, name, source = 'unknown') {
  if (!config.FIREBASE.DATABASE_URL || !config.FIREBASE.SECRET) {
    console.log(`${LOG_PREFIX} Credentials not configured, skipping`);
    return null;
  }

  const sanitizedPhone = sanitizePhoneForFirebase(phoneNumber);
  const url = `${config.FIREBASE.DATABASE_URL}whitelist/${sanitizedPhone}.json?auth=${config.FIREBASE.SECRET}`;

  try {
    const response = await axios.put(url, {
      name: cleanString(name),
      source,
      timestamp: nowISO()
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: config.TIMEOUTS.FIREBASE
    });

    console.log(`${LOG_PREFIX} Added to whitelist: ${sanitizedPhone}`);
    return response.data;

  } catch (error) {
    console.error(`${LOG_PREFIX} Whitelist error: ${error.message}`);
    return null;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  addToWhitelist
};