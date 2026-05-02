// ============================================================================
//  lib/writeBoth.js — Write to Firestore + Sheet with smart retry
//
//  Tracks which service succeeded. On retry, SKIPS the service that
//  already worked. Firestore is never written twice for the same operation.
// ============================================================================

const FirestoreService = require('../services/firestoreService');
const SheetService     = require('../services/sheetsService');
const PendingQueue     = require('../services/pendingQueue');
const { withLock }     = require('./phoneLock');


/**
 * Build a write function that writes to BOTH Firestore and Sheet.
 * Tracks success per-service so retries only run the failed part.
 *
 * @param {Object|null} leadData - Lead fields (null if using custom writes)
 * @param {Object|null} historyEntry - { action, by, details }
 * @param {Function|null} customFirestoreWrite - Override default Firestore write
 * @param {Function|null} customSheetWrite - Override default Sheet write
 * @returns {Function} Async write function, safe for retry
 */
function buildWriteBoth(leadData, historyEntry, customFirestoreWrite, customSheetWrite) {
  const phone = leadData?.phone || leadData?.waId || '';

  // Track what succeeded across retries (closure state)
  let firestoreDone = false;
  let sheetDone = false;

  return async () => {
    const doWrite = async () => {
      const errors = [];

      // ── Firestore: skip if already succeeded ──────────────────
      if (!firestoreDone) {
        try {
          if (customFirestoreWrite) {
            await customFirestoreWrite();
          } else {
            const result = await FirestoreService.createOrUpdateLead(leadData, historyEntry);
            if (result?.cgId) leadData.cgId = result.cgId;
          }
          firestoreDone = true;
        } catch (e) {
          errors.push(`firestore: ${e.message}`);
        }
      }

      // ── Sheet: skip if already succeeded ──────────────────────
      if (!sheetDone) {
        try {
          let sheetResult;
          if (customSheetWrite) {
            sheetResult = await customSheetWrite();
          } else {
            sheetResult = await SheetService.upsertContact(leadData);
          }
          sheetDone = true;
          
          // Patch Firestore with actual row number (fire-and-forget)
          if (sheetResult?.row && phone) {
            FirestoreService.updateLead(phone, { sheetRow: sheetResult.row })
              .catch(err => console.warn(`[writeBoth] sheetRow patch failed: ${err.message}`));
          }
        } catch (e) {
          errors.push(`sheet: ${e.message}`);
        }
      }

      if (errors.length > 0) {
        throw new Error(errors.join('; '));
      }
    };

    if (phone) {
      return withLock(phone, doWrite);
    }
    return doWrite();
  };
}


/**
 * Attempt write, queue for retry on failure.
 */
function tryWriteOrQueue(writeFn, operationId, metadata) {
  return writeFn().catch(err => {
    PendingQueue.enqueue(operationId, writeFn, metadata);
    console.error(`[Handler] Write failed, queued ${operationId}: ${err.message}`);
  });
}


module.exports = { buildWriteBoth, tryWriteOrQueue };