// ============================================================================
//  pendingQueue.js — In-Memory Retry Queue for Failed Writes
//
//  When a transactional write (Firestore + Sheet) fails, the handler
//  enqueues the complete write function here. The queue retries with
//  exponential backoff. After MAX_RETRIES → structured Cloud Logging
//  entry (queryable for manual recovery).
//
//  FIXED: isProcessing guard prevents concurrent _processQueue runs.
//  Without this, setInterval fires every 10s regardless of whether
//  the previous run finished — causing runaway retries past MAX_RETRIES.
// ============================================================================

const MAX_RETRIES = 5;
const BACKOFF_MS = [0, 15000, 60000, 300000, 900000]; // 0s, 15s, 1m, 5m, 15m
const POLL_INTERVAL_MS = 10000; // check queue every 10s

const queue = [];
let intervalId = null;
let isProcessing = false;


/**
 * Enqueue a failed write for background retry.
 *
 * @param {string}   operationId  Unique key, e.g. `create_9876543210_1709123456`
 * @param {Function} writeFn      Async fn that performs BOTH writes. Must be idempotent. Throws on failure.
 * @param {Object}   metadata     For logging: { phone, handler, trigger }
 */
function enqueue(operationId, writeFn, metadata = {}) {
  if (queue.find(item => item.operationId === operationId)) {
    console.log(`[PendingQueue] Already queued: ${operationId}`);
    return;
  }

  queue.push({
    operationId,
    writeFn,
    metadata,
    attempts: 0,
    nextRetryAt: Date.now(),
    enqueuedAt: Date.now(),
  });

  console.warn(`[PendingQueue] ⏳ Enqueued: ${operationId} | ${JSON.stringify(metadata)}`);
  _ensureRunning();
}


/**
 * Get queue stats — exposed via /diagnostic endpoint.
 */
function getStats() {
  return {
    pending: queue.length,
    isProcessing,
    items: queue.map(item => ({
      operationId: item.operationId,
      attempts:    item.attempts,
      nextRetryAt: new Date(item.nextRetryAt).toISOString(),
      metadata:    item.metadata,
    })),
  };
}


// ── Internal ──────────────────────────────────────────────────

function _ensureRunning() {
  if (intervalId) return;
  intervalId = setInterval(_processQueue, POLL_INTERVAL_MS);
  console.log('[PendingQueue] Retry loop started');
}


async function _processQueue() {
  if (isProcessing) return;
  if (queue.length === 0) return;

  isProcessing = true;

  try {
    const now = Date.now();
    const toRemove = [];

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];

      if (item.nextRetryAt > now) continue;

      if (item.attempts >= MAX_RETRIES) {
        console.error(JSON.stringify({
          type:        'DEAD_LETTER',
          severity:    'CRITICAL',
          operationId: item.operationId,
          attempts:    item.attempts,
          lastError:   'max_retries_exceeded',
          metadata:    item.metadata,
          enqueuedAt:  new Date(item.enqueuedAt).toISOString(),
          diedAt:      new Date().toISOString(),
        }));
        toRemove.push(i);
        continue;
      }

      item.attempts++;
      console.log(`[PendingQueue] Retry #${item.attempts}: ${item.operationId}`);

      try {
        await item.writeFn();

        toRemove.push(i);
        console.log(`[PendingQueue] ✅ Resolved: ${item.operationId} after ${item.attempts} attempt(s)`);

      } catch (err) {
        const backoff = BACKOFF_MS[item.attempts] || BACKOFF_MS[BACKOFF_MS.length - 1];
        item.nextRetryAt = Date.now() + backoff;
        console.warn(
          `[PendingQueue] ❌ #${item.attempts} failed: ${item.operationId} — ${err.message}. Next in ${backoff / 1000}s`
        );
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      queue.splice(toRemove[i], 1);
    }

    if (queue.length === 0 && intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      console.log('[PendingQueue] Queue empty — retry loop stopped');
    }

  } finally {
    isProcessing = false;
  }
}


module.exports = { enqueue, getStats };