// ============================================================================
//  handlers/stageHandler.js — Stage Transition Handler
//
//  Handles stage_transition events sent by GAS when an agent
//  edits the Stage column. Validates the transition, updates
//  Firestore, routes to target sheet, archives source row.
//
//  Separate from syncHandler because a stage transition is NOT
//  a simple field sync — it involves validation, cross-sheet
//  routing, and cell revert on failure.
// ============================================================================

const FirestoreService = require('../services/firestoreService');
const SheetService     = require('../services/sheetsService');
const stageRouter      = require('../services/stageRouter');
const config           = require('../config');

const LOG_PREFIX = '[StageTransition]';


async function handleStageTransition(params) {
  const { phone, oldStage, newStage, sourceRow, editor } = params;

  if (!phone) {
    return { success: false, reason: 'no_phone' };
  }

  if (!newStage) {
    return { success: false, reason: 'no_target_stage' };
  }

  console.log(`${LOG_PREFIX} ${phone}: ${oldStage} → ${newStage} (by ${editor})`);

  // 1. Look up lead in Firestore
  const existing = await FirestoreService.findLeadByPhone(phone);
  if (!existing) {
    console.error(`${LOG_PREFIX} Lead not found: ${phone}`);
    return { success: false, reason: 'lead_not_found' };
  }

  // 2. Determine current stage from Firestore (source of truth, not the old cell value)
  const currentStage = existing.data.stage || existing.data.pipelineStage || config.STAGES.NOT_ASSIGNED;

  // 3. Validate transition
  const allowedTargets = config.STAGE_TRANSITIONS[currentStage] || [];
  if (!allowedTargets.includes(newStage)) {
    console.warn(`${LOG_PREFIX} BLOCKED: ${currentStage} → ${newStage} (allowed: [${allowedTargets.join(', ')}])`);

    // Revert the cell to current stage
    if (sourceRow) {
      try {
        const colMap = await SheetService.getColumnMap(config.SHEETS.DSR);
        const stageColIdx = colMap.map.pipelineStage;
        if (stageColIdx !== undefined) {
          await SheetService.updateContactCells(sourceRow, {
            [stageColIdx]: currentStage
          });
          console.log(`${LOG_PREFIX} Reverted Stage cell to '${currentStage}' on row ${sourceRow}`);
        }
      } catch (revertErr) {
        console.error(`${LOG_PREFIX} Failed to revert: ${revertErr.message}`);
      }
    }

    return {
      success: false,
      reason: 'invalid_stage_transition',
      from: currentStage,
      to: newStage,
      allowed: allowedTargets,
    };
  }

  // 4. Valid transition — update Firestore
  console.log(`${LOG_PREFIX} Valid: ${currentStage} → ${newStage}`);

  const historyEntry = {
    action: 'stage_transition',
    by: editor || 'system',
    details: { from: currentStage, to: newStage },
  };

  await FirestoreService.updateLead(phone, {
    stage: newStage,
    pipelineStage: newStage,
    sheetRow: sourceRow || existing.data.sheetRow,
  }, historyEntry);

  console.log(`${LOG_PREFIX} Firestore updated: ${existing.data.cgId} → ${newStage}`);

  // 5. Route to target sheet (if routing config exists for this stage)
  const routeConfig = config.SHEET_ROUTING[newStage];
  if (routeConfig) {
    try {
      const routeResult = await stageRouter.routeLead({
        phone,
        cgId: existing.data.cgId,
        targetStage: newStage,
        routeConfig,
        sourceRow,
      });
      console.log(`${LOG_PREFIX} Routed ${existing.data.cgId} to ${newStage}: ${JSON.stringify(routeResult)}`);
    } catch (routeErr) {
      console.error(`${LOG_PREFIX} Routing failed: ${routeErr.message}`);
      // Firestore is updated. Routing failure is non-fatal.
      // Lead can be manually moved or re-triggered.
    }
  } else {
    console.log(`${LOG_PREFIX} No routing config for '${newStage}' — Firestore only`);
  }

  return {
    success: true,
    cgId: existing.data.cgId,
    transition: `${currentStage} → ${newStage}`,
    routed: !!routeConfig,
  };
}


module.exports = {
  handleStageTransition,
};
