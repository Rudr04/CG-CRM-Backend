function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  return `${month}/${day}/${year}`;
}

function getLastTenDigits(phoneNumber) {
  return phoneNumber.toString().replace(/\D/g, '').slice(-10);
}

function phoneNumbersMatch(num1, num2) {
  return getLastTenDigits(num1) === getLastTenDigits(num2);
}

function levenshtein(a, b) {
  const m = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        m[i][j] = m[i - 1][j - 1];
      } else {
        m[i][j] = Math.min(
          m[i - 1][j - 1] + 1,
          m[i][j - 1] + 1,
          m[i - 1][j] + 1
        );
      }
    }
  }
  return m[b.length][a.length];
}

function containsFuzzyKeywords(messageText) {
  // English keywords for fuzzy matching
  const fuzzyKeywords = [
    'online','offline','masterclass','register','address',
    'link','course','jyotish','vastu','hi','hello',
    'learn','vedic','astrology','hey','detail','info',
    'more','cvpt','price','syllabus','fees'
  ];
  
  // Non-English keywords for exact matching (Gujarati, Hindi, etc.)
  const exactKeywords = [
    'àª«à«àª°à«€ àª°à«‡àªœàª¿àª¸à«àªŸàª° àª•àª°à«‹',  // Free register karo
    'àª«à«àª°à«€',                // Free
    'àª°à«‡àªœàª¿àª¸à«àªŸàª°',          // Register
    'àª•àª°à«‹',                // Karo (do it)
    'àª®àª¾àª¸à«àªŸàª°àª•à«àª²àª¾àª¸',      // Masterclass
    'àª“àª¨àª²àª¾àª‡àª¨',            // Online
    'àª“àª«àª²àª¾àª‡àª¨'             // Offline
  ];
  
  const lowerText = messageText.toLowerCase();
  const words = lowerText.split(/\s+/);
  
  // Check exact matches first (for Gujarati and other non-Latin scripts)
  const hasExactMatch = exactKeywords.some(keyword => 
    lowerText.includes(keyword.toLowerCase())
  );
  
  if (hasExactMatch) return true;
  
  // Then check fuzzy matches (for English with typos)
  return fuzzyKeywords.some(keyword => {
    let threshold;
    if (keyword.length <= 3) threshold = 1;
    else if (keyword.length <= 6) threshold = 2;
    else if (keyword.length <= 10) threshold = 3;
    else threshold = 4;

    return words.some(word => levenshtein(word, keyword) <= threshold);
  });
}

// Add this function to helpers.js
function fuzzyMatchesRegistrationCheck(messageText) {
  if (!messageText) return false;

  const normalized = messageText.toLowerCase().trim();
  
  // Exact match
  if (normalized === 'my registered number?' || 
      normalized === 'my registered number') {
    return true;
  }

  // Split into words and check if key words are present with fuzzy tolerance
  const words = normalized.split(/\s+/);
  
  // Must contain "registered" or close variant
  const hasRegistered = words.some(word => levenshtein(word, 'registered') <= 3);
  
  // Must contain "number" or close variant  
  const hasNumber = words.some(word => levenshtein(word, 'number') <= 2);
  
  // Optional: check for "my" with tolerance
  const hasMy = words.some(word => levenshtein(word, 'my') <= 1);
  
  // Match if has key terms (registered + number), with or without "my"
  return hasRegistered && hasNumber;
}

function isFromAdvertisement(sourceUrl) {
  return sourceUrl && (
    sourceUrl.includes("https://www.instagram.com/") ||
    sourceUrl.includes("https://fb.me/")
  );
}

module.exports = {
  formatDate,
  getLastTenDigits,
  phoneNumbersMatch,
  levenshtein,
  containsFuzzyKeywords,
  isFromAdvertisement,
  fuzzyMatchesRegistrationCheck
};