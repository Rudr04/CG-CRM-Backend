// ============================================================================
//  utils/helpers.js — CENTRALIZED Utility Functions
//
//  ALL utility functions live here. NO other file should define these.
//  Import what you need: const { normalizePhone, formatDate } = require('../utils/helpers');
// ============================================================================

const config = require('../config');


// ═══════════════════════════════════════════════════════════════════════════
//  PHONE UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract last 10 digits from phone number (for Indian mobile matching)
 */
function getLastTenDigits(phoneNumber) {
  return phoneNumber.toString().replace(/\D/g, '').slice(-10);
}

/**
 * Normalize phone to digits only (E.164 without +)
 */
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.toString().replace(/\D/g, '');
}

/**
 * Format phone with + prefix
 */
function formatPhoneE164(phone) {
  const normalized = normalizePhone(phone);
  return normalized ? `+${normalized}` : '';
}

/**
 * Sanitize phone for Firebase RTDB path
 */
function sanitizePhoneForFirebase(phone) {
  return phone.toString()
    .replace(/\s/g, '')
    .replace(/^(?!\+)/, '+');
}

/**
 * Check if two phone numbers match (comparing last 10 digits)
 */
function phoneNumbersMatch(num1, num2) {
  return getLastTenDigits(num1) === getLastTenDigits(num2);
}

/**
 * Validate phone number has minimum digits
 */
function isValidPhone(phone, minDigits = 10) {
  return normalizePhone(phone).length >= minDigits;
}


// ═══════════════════════════════════════════════════════════════════════════
//  STRING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sanitize name - remove emojis and special characters
 * Used for APIs that reject special chars (e.g., Smartflo)
 */
function sanitizeName(name) {
  if (!name) return '';
  return name
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/[!@#$%^&*()_+=:;\\,.></?|{}[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clean string - trim and handle null/undefined
 */
function cleanString(str) {
  return (str || '').toString().trim();
}

/**
 * Truncate string with ellipsis
 */
function truncate(str, maxLength = 100) {
  if (!str || str.length <= maxLength) return str || '';
  return str.substring(0, maxLength - 3) + '...';
}


// ═══════════════════════════════════════════════════════════════════════════
//  DATE/TIME UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format date as MM/DD/YYYY
 */
function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  return `${month}/${day}/${year}`;
}

/**
 * Format time in IST (HH:MM:SS)
 */
function formatTimeIST(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString('en-IN', {
    timeZone: config.TIMEZONE,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/**
 * Format time in IST (HH:MM only)
 */
function formatTimeShortIST(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString('en-IN', {
    timeZone: config.TIMEZONE,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Get current ISO timestamp
 */
function nowISO() {
  return new Date().toISOString();
}

/**
 * Build attendance string (used in sheetsService)
 */
function buildAttendanceString(current, time) {
  return current ? `${current} | ${time}` : `Present ${time}`;
}


// ═══════════════════════════════════════════════════════════════════════════
//  FUZZY MATCHING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Levenshtein distance
 */
function levenshtein(a, b) {
  const m = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        m[i][j] = m[i - 1][j - 1];
      } else {
        m[i][j] = Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
      }
    }
  }
  return m[b.length][a.length];
}

/**
 * Check if message contains fuzzy-matched keywords
 */
function containsFuzzyKeywords(messageText) {
  if (!messageText) return false;
  
  const fuzzyKeywords = [
    'online', 'offline', 'masterclass', 'register', 'address',
    'link', 'course', 'jyotish', 'vastu', 'hi', 'hello',
    'learn', 'vedic', 'astrology', 'hey', 'detail', 'info',
    'more', 'cvpt', 'price', 'syllabus', 'fees'
  ];
  
  const exactKeywords = [
    'ફ્રી રેજિસ્ટર કરો', 'ફ્રી', 'રેજિસ્ટર', 'કરો',
    'માસ્ટરક્લાસ', 'ઓનલાઇન', 'ઓફલાઇન'
  ];
  
  const lowerText = messageText.toLowerCase();
  const words = lowerText.split(/\s+/);
  
  if (exactKeywords.some(k => lowerText.includes(k.toLowerCase()))) {
    return true;
  }
  
  return fuzzyKeywords.some(keyword => {
    const threshold = keyword.length <= 3 ? 1 : keyword.length <= 6 ? 2 : keyword.length <= 10 ? 3 : 4;
    return words.some(word => levenshtein(word, keyword) <= threshold);
  });
}

/**
 * Check if message is asking for registration number
 */
function fuzzyMatchesRegistrationCheck(messageText) {
  if (!messageText) return false;
  const normalized = messageText.toLowerCase().trim();
  
  if (normalized === 'my registered number?' || normalized === 'my registered number') {
    return true;
  }

  const words = normalized.split(/\s+/);
  const hasRegistered = words.some(word => levenshtein(word, 'registered') <= 3);
  const hasNumber = words.some(word => levenshtein(word, 'number') <= 2);
  
  return hasRegistered && hasNumber;
}


// ═══════════════════════════════════════════════════════════════════════════
//  SOURCE DETECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if from advertisement
 */
function isFromAdvertisement(sourceUrl) {
  return sourceUrl && (
    sourceUrl.includes('https://www.instagram.com/') ||
    sourceUrl.includes('https://fb.me/')
  );
}

/**
 * Detect source from URL
 */
function detectSource(sourceUrl) {
  if (!sourceUrl) return 'WhatsApp';
  if (sourceUrl.includes('instagram.com')) return 'Insta';
  if (sourceUrl.includes('fb.me')) return 'FB';
  return 'WhatsApp';
}


// ═══════════════════════════════════════════════════════════════════════════
//  ROBO ASSIGNMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if should assign to ROBO team
 */
function shouldAssignRobo(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return t.includes('free masterclass') || t.includes('free mc');
}


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Phone
  getLastTenDigits,
  normalizePhone,
  formatPhoneE164,
  sanitizePhoneForFirebase,
  phoneNumbersMatch,
  isValidPhone,
  
  // String
  sanitizeName,
  cleanString,
  truncate,
  
  // Date/Time
  formatDate,
  formatTimeIST,
  formatTimeShortIST,
  nowISO,
  buildAttendanceString,
  
  // Fuzzy
  levenshtein,
  containsFuzzyKeywords,
  fuzzyMatchesRegistrationCheck,
  
  // Source
  isFromAdvertisement,
  detectSource,
  
  // Team
  shouldAssignRobo,
};