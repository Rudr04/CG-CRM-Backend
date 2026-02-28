// ============================================================================
//  pendingQueue.js — In-Memory Retry Queue for Failed Writes
//
//  When a transactional write (Firestore + Sheet) fails, the handler
//  enqueues the complete write function here. The queue retries with
//  exponential backoff. After MAX_RETRIES → structured Cloud Logging
//  entry (queryable for manual recovery).
//
//  Why in-memory: Firestore might be the thing that's down, so we
//  can't store pending writes IN Firestore. Cloud Run keeps the
//  instance warm between requests (especially with min-instances=1).
// ============================================================================

const MAX_RETRIES = 5;
const BACKOFF_MS = [0, 15000, 60000, 300000, 900000]; // 0s, 15s, 1m, 5m, 15m
const POLL_INTERVAL_MS = 10000; // check queue every 10s

const queue = [];
let intervalId = null;


/**
 * Enqueue a failed write for background retry.
 *
 * @param {string}   operationId  Unique key, e.g. `create_9876543210_1709123456`
 * @param {Function} writeFn      Async fn that performs BOTH writes. Must be idempotent. Throws on failure.
 * @param {Object}   metadata     For logging: { phone, handler, trigger }
 */
function enqueue(operationId, writeFn, metadata = {}) {
  // Deduplicate: skip if same operationId already queued
  if (queue.find(item => item.operationId === operationId)) {
    console.log(`[PendingQueue] Already queued: ${operationId}`);
    return;
  }

  queue.push({
    operationId,
    writeFn,
    metadata,
    attempts: 0,
    nextRetryAt: Date.now(),           // retry immediately on first pass
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
  if (queue.length === 0) return;

  const now = Date.now();

  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i];
    if (item.nextRetryAt > now) continue;

    item.attempts++;
    console.log(`[PendingQueue] Retry #${item.attempts}: ${item.operationId}`);

    try {
      await item.writeFn();

      // ✅ Success — remove from queue
      queue.splice(i, 1);
      console.log(`[PendingQueue] ✅ Resolved: ${item.operationId} after ${item.attempts} attempt(s)`);

    } catch (err) {
      if (item.attempts >= MAX_RETRIES) {
        // ☠️ Dead letter — structured log for manual recovery
        console.error(JSON.stringify({
          type:        'DEAD_LETTER',
          severity:    'CRITICAL',
          operationId: item.operationId,
          attempts:    item.attempts,
          lastError:   err.message,
          metadata:    item.metadata,
          enqueuedAt:  new Date(item.enqueuedAt).toISOString(),
          diedAt:      new Date().toISOString(),
        }));
        queue.splice(i, 1);
      } else {
        // Schedule next retry with exponential backoff
        const backoff = BACKOFF_MS[item.attempts] || BACKOFF_MS[BACKOFF_MS.length - 1];
        item.nextRetryAt = now + backoff;
        console.warn(
          `[PendingQueue] ❌ #${item.attempts} failed: ${item.operationId} — ${err.message}. Next in ${backoff / 1000}s`
        );
      }
    }
  }
}


module.exports = { enqueue, getStats };
