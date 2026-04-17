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
  const { phone, cgId, targetStage, routeConfig, sourceRow, sourceSpreadsheetId, sourceTabName } = routeInfo;

  console.log(`${LOG_PREFIX} Routing ${cgId} → ${targetStage}`);

  // 1. Read full lead from Firestore (single source of truth)
  const lead = await FirestoreService.findLeadByPhone(phone);
  if (!lead) {
    console.error(`${LOG_PREFIX} Lead not found in Firestore: ${phone}`);
    return { success: false, reason: 'lead_not_found' };
  }

  const leadData = lead.data;

  // 2. Determine if this is a forward or backward transition
  const isForward = !!routeConfig;  // routeConfig exists = forward to new sheet
  const isBackward = !routeConfig && targetStage === config.STAGES.AGENT_WORKING;

  if (isForward) {
    // ── Forward: insert into target sheet ──
    console.log(`${LOG_PREFIX} Forward route → ${routeConfig.tabName} (${routeConfig.spreadsheetId})`);

    try {
      const insertResult = await SheetService.insertRowToSheet(
        routeConfig.spreadsheetId,
        routeConfig.tabName,
        leadData
      );
      console.log(`${LOG_PREFIX} Inserted into ${targetStage} sheet, row ${insertResult.row}`);
    } catch (insertErr) {
      console.error(`${LOG_PREFIX} Insert failed: ${insertErr.message}`);
      throw insertErr;
    }

    // Archive source row
    if (sourceRow && sourceSpreadsheetId && sourceTabName) {
      try {
        await SheetService.formatRowAsArchived(sourceSpreadsheetId, sourceTabName, sourceRow);
        console.log(`${LOG_PREFIX} Archived row ${sourceRow} in ${sourceTabName}`);
      } catch (fmtErr) {
        console.error(`${LOG_PREFIX} Archive failed (non-fatal): ${fmtErr.message}`);
      }
    } else if (sourceRow) {
      // Fallback: assume DSR if no source info provided
      try {
        await SheetService.formatRowAsArchived(config.SPREADSHEET_ID, config.SHEETS.DSR, sourceRow);
        console.log(`${LOG_PREFIX} Archived row ${sourceRow} in DSR (fallback)`);
      } catch (fmtErr) {
        console.error(`${LOG_PREFIX} Archive failed (non-fatal): ${fmtErr.message}`);
      }
    }

  } else if (isBackward) {
    // ── Backward: un-archive original DSR row ──
    const dsrRow = leadData.sheetRow;
    if (!dsrRow) {
      console.warn(`${LOG_PREFIX} No sheetRow in Firestore — cannot un-archive DSR row`);
    } else {
      try {
        await SheetService.unarchiveRow(config.SPREADSHEET_ID, config.SHEETS.DSR, dsrRow);
        console.log(`${LOG_PREFIX} Un-archived DSR row ${dsrRow}`);
      } catch (unarchiveErr) {
        console.error(`${LOG_PREFIX} Un-archive failed (non-fatal): ${unarchiveErr.message}`);
      }
    }

    // Also update the Stage cell in DSR to reflect the new stage
    if (dsrRow) {
      try {
        const colMap = await SheetService.getColumnMap(config.SHEETS.DSR);
        const stageColIdx = colMap.map.pipelineStage;
        if (stageColIdx !== undefined) {
          await SheetService.updateContactCells(dsrRow, {
            [stageColIdx]: targetStage
          });
          console.log(`${LOG_PREFIX} Updated DSR Stage cell to '${targetStage}' on row ${dsrRow}`);
        }
      } catch (cellErr) {
        console.error(`${LOG_PREFIX} Stage cell update failed (non-fatal): ${cellErr.message}`);
      }
    }

    // Archive source row in Sales Review (or wherever it came from)
    if (sourceRow && sourceSpreadsheetId && sourceTabName) {
      try {
        await SheetService.formatRowAsArchived(sourceSpreadsheetId, sourceTabName, sourceRow);
        console.log(`${LOG_PREFIX} Archived row ${sourceRow} in ${sourceTabName}`);
      } catch (fmtErr) {
        console.error(`${LOG_PREFIX} Archive source failed (non-fatal): ${fmtErr.message}`);
      }
    }

  } else {
    // No routing needed (e.g., transition to 'dead')
    console.log(`${LOG_PREFIX} No sheet routing for '${targetStage}' — Firestore only`);

    // Archive source row if available
    if (sourceRow && sourceSpreadsheetId && sourceTabName) {
      try {
        await SheetService.formatRowAsArchived(sourceSpreadsheetId, sourceTabName, sourceRow);
        console.log(`${LOG_PREFIX} Archived row ${sourceRow} in ${sourceTabName}`);
      } catch (fmtErr) {
        console.error(`${LOG_PREFIX} Archive failed (non-fatal): ${fmtErr.message}`);
      }
    }
  }

  return { success: true, cgId: leadData.cgId, targetStage, direction: isForward ? 'forward' : isBackward ? 'backward' : 'terminal' };
}


module.exports = {
  routeLead,
};
