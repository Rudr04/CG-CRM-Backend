// ============================================================================
//  services/stageRouter.js — Cross-Sheet Stage Routing
//
//  When a lead's stage changes, this service:
//  1. Reads full lead data from Firestore (source of truth)
//  2. Inserts a new row into the target sheet
//  3. Strikes out + greys the source row in DSR
//
//  Called by syncHandler when result.needsRouting === true
// ============================================================================

const FirestoreService = require('./firestoreService');
const SheetService     = require('./sheetsService');
const config           = require('../config');

const LOG_PREFIX = '[StageRouter]';


/**
 * Route a lead to a target sheet after a stage transition.
 *
 * @param {Object} routeInfo — from syncHandler result
 *   { phone, cgId, targetStage, routeConfig: { spreadsheetId, tabName }, sourceRow }
 */
async function routeLead(routeInfo) {
  const { phone, cgId, targetStage, routeConfig, sourceRow } = routeInfo;

  console.log(`${LOG_PREFIX} Routing ${cgId} → ${targetStage} (spreadsheet: ${routeConfig.spreadsheetId})`);

  // 1. Read full lead from Firestore (single source of truth)
  const lead = await FirestoreService.findLeadByPhone(phone);
  if (!lead) {
    console.error(`${LOG_PREFIX} Lead not found in Firestore: ${phone}`);
    return { success: false, reason: 'lead_not_found' };
  }

  const leadData = lead.data;
  console.log(`${LOG_PREFIX} Lead data loaded: ${leadData.cgId}`);

  // 2. Insert row into target sheet
  try {
    const insertResult = await SheetService.insertRowToSheet(
      routeConfig.spreadsheetId,
      routeConfig.tabName,
      leadData
    );
    console.log(`${LOG_PREFIX} Inserted into ${targetStage} sheet, row ${insertResult.row}`);
  } catch (insertErr) {
    console.error(`${LOG_PREFIX} Failed to insert into ${targetStage}: ${insertErr.message}`);
    throw insertErr;  // Let syncHandler handle the error
  }

  // 3. Strikeout + grey the source row in DSR
  if (sourceRow) {
    try {
      await SheetService.formatRowAsArchived(
        config.SPREADSHEET_ID,
        config.SHEETS.DSR,
        sourceRow
      );
      console.log(`${LOG_PREFIX} Archived row ${sourceRow} in DSR`);
    } catch (fmtErr) {
      console.error(`${LOG_PREFIX} Failed to archive source row: ${fmtErr.message}`);
      // Non-fatal — lead is already in the target sheet
    }
  }

  return { success: true, cgId: leadData.cgId, targetStage, targetRow: 'inserted' };
}


module.exports = {
  routeLead,
};
