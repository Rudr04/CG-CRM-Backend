const axios = require('axios');
const config = require('../config');

/**
 * Add phone number to Firebase whitelist
 */
async function addToWhitelist(phoneNumber, name, source = 'whatsapp_form') {
  try {
    if (!config.FIREBASE.DATABASE_URL || !config.FIREBASE.SECRET) {
      console.log('Firebase credentials not configured, skipping whitelist sync');
      return;
    }

    const sanitizedPhone = phoneNumber.toString()
      .replace(/\s/g, '')
      .replace(/^(?!\+)/, '+');

    const url = `${config.FIREBASE.DATABASE_URL}whitelist/${sanitizedPhone}.json?auth=${config.FIREBASE.SECRET}`;

    const payload = {
      name: name.trim(),
      source: source,
      timestamp: new Date().toISOString()
    };

    const response = await axios.put(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    });

    console.log(`âœ… Added to Firebase whitelist: ${sanitizedPhone}`);
    return response.data;

  } catch (error) {
    console.error(`Firebase whitelist error: ${error.message}`);
    // Don't throw - let form submission continue even if Firebase fails
    return null;
  }
}

module.exports = { addToWhitelist };