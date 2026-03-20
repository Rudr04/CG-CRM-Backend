// ============================================================================
//  lib/phoneLock.js — Per-Phone Async Serialization
//
//  Prevents two concurrent webhooks for the same phone from creating
//  duplicate Sheet rows. Different phones run in parallel.
//
//  Scope: per-instance (in-memory). Cross-instance races are handled
//  by Firestore's existence check in createLead.
// ============================================================================

const { normalizePhone } = require('../utils/helpers');

const locks = new Map();
const LOCK_TIMEOUT_MS = 30000;
const CLEANUP_INTERVAL = 60000;


/**
 * Execute an async function with exclusive access per phone number.
 *
 * @param {string} phone - Raw phone number (auto-normalized)
 * @param {Function} fn - Async function to execute under lock
 * @returns {Promise<*>} Result of fn()
 */
async function withLock(phone, fn) {
  const key = normalizePhone(phone);
  if (!key) return fn();

  const prevLock = locks.get(key) || Promise.resolve();

  let releaseLock;
  const currentLock = new Promise(resolve => { releaseLock = resolve; });

  locks.set(key, prevLock.then(() => currentLock));

  await prevLock;

  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Phone lock timeout: ${key}`)), LOCK_TIMEOUT_MS)
      )
    ]);
    return result;
  } finally {
    releaseLock();

    const currentChain = locks.get(key);
    if (currentChain) {
      currentChain.then(() => {
        if (locks.get(key) === prevLock.then(() => currentLock)) {
          locks.delete(key);
        }
      });
    }
  }
}


/**
 * Get lock stats for diagnostic endpoint.
 */
function getStats() {
  return {
    activeLocks: locks.size,
    phones: Array.from(locks.keys()).map(k => `...${k.slice(-4)}`),
  };
}


setInterval(() => {
  if (locks.size > 1000) {
    console.warn(`[PhoneLock] ${locks.size} entries — clearing stale locks`);
    locks.clear();
  }
}, CLEANUP_INTERVAL);


module.exports = { withLock, getStats };