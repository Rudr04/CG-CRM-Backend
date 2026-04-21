// ============================================================================
//  services/stageRouter.js — Cross-Sheet Stage Routing (delete + insert)
//
//  On every stage transition:
//    1. Compute source and target sheets from oldStage / targetStage via config.
//    2. If source === target, no row movement is needed.
//    3. If target has a sheet: fetch lead from Firestore, insert into target.
//    4. If source has a sheet and sourceRow is known: delete the source row.
//
//  Order matters: insert BEFORE delete. If insert fails, we abort before
//  deleting the source — better a failed transition than a lost lead. If
//  delete fails after a successful insert, we log loudly but do not throw;
//  a duplicate is recoverable, a disappearance is not.
// ============================================================================

const FirestoreService = require('./firestoreService');
const SheetService     = require('./sheetsService');
const config           = require('../config');

const LOG_PREFIX = '[StageRouter]';


/**
 * Move a lead across sheets on stage transition.
 *
 * @param {Object} routeInfo
 *   @param {string} routeInfo.phone
 *   @param {string} routeInfo.cgId
 *   @param {string} routeInfo.oldStage
 *   @param {string} routeInfo.targetStage
 *   @param {number} [routeInfo.sourceRow]
 *   @param {string} [routeInfo.sourceSpreadsheetId]
 *   @param {string} [routeInfo.sourceTabName]
 * @returns {Promise<Object>} { success, cgId, targetStage, action, insertedRow? }
 */
async function routeLead(routeInfo) {
  const {
    phone,
    cgId,
    oldStage,
    targetStage,
    sourceRow,
    sourceSpreadsheetId,
    sourceTabName,
  } = routeInfo;

  console.log(`${LOG_PREFIX} ${cgId}: ${oldStage} → ${targetStage}`);

  const sourceSheet = config.getSheetForStage(oldStage);
  const targetSheet = config.getSheetForStage(targetStage);

  // ── Case A: same physical sheet on both sides. No row movement. ──
  if (sourceSheet && targetSheet &&
      sourceSheet.spreadsheetId === targetSheet.spreadsheetId &&
      sourceSheet.tabName === targetSheet.tabName) {
    console.log(`${LOG_PREFIX} Same sheet (${sourceSheet.tabName}) — no movement`);
    return { success: true, cgId, targetStage, action: 'same_sheet' };
  }

  // ── Case B: target has a sheet — insert first. ──
  let insertedRow = null;
  if (targetSheet) {
    const lead = await FirestoreService.findLeadByPhone(phone);
    if (!lead) {
      console.error(`${LOG_PREFIX} Lead not found in Firestore: ${phone}`);
      return { success: false, reason: 'lead_not_found' };
    }

    try {
      const result = await SheetService.insertRowToSheet(
        targetSheet.spreadsheetId,
        targetSheet.tabName,
        lead.data
      );
      insertedRow = result.row;
      console.log(`${LOG_PREFIX} Inserted into ${targetSheet.tabName} at row ${insertedRow}`);
    } catch (insertErr) {
      console.error(`${LOG_PREFIX} Insert failed: ${insertErr.message}`);
      // Abort before deleting source — do not risk losing the lead.
      throw insertErr;
    }
  } else {
    console.log(`${LOG_PREFIX} Target stage '${targetStage}' has no sheet — skipping insert`);
  }

  // ── Case C: delete from source. Runs only after successful insert (if any). ──
  const delSpreadsheetId =
    sourceSpreadsheetId || (sourceSheet && sourceSheet.spreadsheetId);
  const delTabName =
    sourceTabName || (sourceSheet && sourceSheet.tabName);

  if (sourceRow && delSpreadsheetId && delTabName) {
    try {
      await SheetService.deleteRowFromSheet(delSpreadsheetId, delTabName, sourceRow);
      console.log(`${LOG_PREFIX} Deleted source row ${sourceRow} from ${delTabName}`);
    } catch (delErr) {
      console.error(
        `${LOG_PREFIX} DELETE FAILED — lead may be duplicated in ${delTabName} row ${sourceRow}: ${delErr.message}`
      );
      // Do not throw. Manual cleanup is possible; a thrown error here would
      // mask a successful insert and trigger retries that duplicate further.
    }
  } else {
    console.log(
      `${LOG_PREFIX} No source delete performed (sourceRow=${sourceRow}, sheet=${delTabName || 'unknown'})`
    );
  }

  return {
    success: true,
    cgId,
    targetStage,
    action: targetSheet ? 'moved' : 'deleted_only',
    insertedRow,
  };
}


module.exports = {
  routeLead,
};
