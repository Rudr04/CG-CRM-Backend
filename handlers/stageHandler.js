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
  // TEMP: fallback to .stage for pre-migration docs. Remove after migrate-stage-collapse.js has run.
  const currentStage = existing.data.pipelineStage || existing.data.stage || config.STAGES.NOT_ASSIGNED;

  // 3. Validate transition
  const allowedTargets = config.STAGE_TRANSITIONS[currentStage] || [];
  if (!allowedTargets.includes(newStage)) {
    console.warn(`${LOG_PREFIX} BLOCKED: ${currentStage} → ${newStage} (allowed: [${allowedTargets.join(', ')}])`);

    // Revert the cell to current stage
    if (sourceRow) {
      try {
        const revertSpreadsheetId = params.sourceSpreadsheetId || config.SPREADSHEET_ID;
        const revertTabName       = params.sourceTabName       || config.SHEETS.DSR;
        const colMap = await SheetService.getColumnMap(revertTabName, revertSpreadsheetId);
        const stageColIdx = colMap.map.pipelineStage;
        if (stageColIdx !== undefined) {
          await SheetService.updateContactCells(
            sourceRow,
            { [stageColIdx]: currentStage },
            revertSpreadsheetId,
            revertTabName
          );
          console.log(`${LOG_PREFIX} Reverted Stage cell to '${currentStage}' on ${revertTabName} row ${sourceRow}`);
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

  // 3b. Readiness check — safety net for transitions that require form data.
  //     Primary enforcement is the GAS form; this catches direct CF calls
  //     that bypass the form.
  const transitionKey = `${currentStage}→${newStage}`;
  const requirements = config.TRANSITION_REQUIREMENTS && config.TRANSITION_REQUIREMENTS[transitionKey];

  if (requirements) {
    const formData = params.formData || {};
    const missingFields = [];

    for (const fieldKey of requirements.required) {
      const value = formData[fieldKey];
      if (value === undefined || value === null || value === '' ||
          (typeof value === 'number' && value <= 0)) {
        missingFields.push(fieldKey);
      }
    }

    if (missingFields.length > 0) {
      console.warn(`${LOG_PREFIX} BLOCKED (missing form data): [${missingFields.join(', ')}] for ${transitionKey}`);

      if (sourceRow) {
        try {
          const revertSpreadsheetId = params.sourceSpreadsheetId || config.SPREADSHEET_ID;
          const revertTabName       = params.sourceTabName       || config.SHEETS.DSR;
          const colMap = await SheetService.getColumnMap(revertTabName, revertSpreadsheetId);
          const stageColIdx = colMap.map.pipelineStage;
          if (stageColIdx !== undefined) {
            await SheetService.updateContactCells(
              sourceRow,
              { [stageColIdx]: currentStage },
              revertSpreadsheetId,
              revertTabName
            );
          }
        } catch (revertErr) {
          console.error(`${LOG_PREFIX} Revert failed: ${revertErr.message}`);
        }
      }

      return {
        success: false,
        reason: 'missing_required_fields',
        transition: transitionKey,
        missingFields,
        description: requirements.description,
      };
    }
  }

  // 4. Valid transition — update Firestore.
  //    sheetRow is intentionally NOT written here. It remains useful for the
  //    DSR upsert path (writeBoth.js maintains it), but it is unreliable across
  //    cross-sheet transitions since row numbers shift on delete/insert.
  //    stageRouter no longer reads it.
  console.log(`${LOG_PREFIX} Valid: ${currentStage} → ${newStage}`);

  const historyEntry = {
    action: 'stage_transition',
    by: editor || 'system',
    details: { from: currentStage, to: newStage },
  };

  await FirestoreService.updateLead(phone, {
    pipelineStage: newStage,
  }, historyEntry);

  console.log(`${LOG_PREFIX} Firestore updated: ${existing.data.cgId} → ${newStage}`);

  // 4b. If form data is present (agent → sales_review form), write it to
  //     Firestore BEFORE routing so stageRouter.routeLead sees the new fields
  //     when it inserts the row into the target sheet.
  if (params.formData) {
    const fd = params.formData;
    const formUpdates = {};

    if (fd.amountPaid !== undefined)   formUpdates.amountPaid   = fd.amountPaid;
    if (fd.modeOfPay)                  formUpdates.modeOfPay    = fd.modeOfPay;
    if (fd.paymentRefId)               formUpdates.paymentRefId = fd.paymentRefId;
    if (fd.scholarship !== undefined)  formUpdates.scholarship  = fd.scholarship;
    if (fd.installment !== undefined)  formUpdates.installment  = fd.installment;

    if (Object.keys(formUpdates).length > 0) {
      const formHistoryEntry = {
        action: 'submitted_to_sales',
        by: editor || 'system',
        details: {
          scholarshipRequested: fd.scholarship || 0,
          installmentRequested: fd.installment || 1,
          amountClaimed:        fd.amountPaid  || 0,
          modeOfPay:            fd.modeOfPay   || '',
          paymentRefId:         fd.paymentRefId || '',
          requestDetails:       (fd.requestDetails || '').substring(0, 500),
        },
      };

      await FirestoreService.updateLead(phone, formUpdates, formHistoryEntry);
      console.log(`${LOG_PREFIX} Form data written for ${existing.data.cgId}`);
    }
  }

  // 5. Route — stageRouter handles same-sheet, cross-sheet, and terminal cases.
  try {
    const routeResult = await stageRouter.routeLead({
      phone,
      cgId:                existing.data.cgId,
      oldStage:            currentStage,
      targetStage:         newStage,
      sourceRow,
      sourceSpreadsheetId: params.sourceSpreadsheetId || config.SPREADSHEET_ID,
      sourceTabName:       params.sourceTabName       || config.SHEETS.DSR,
    });
    console.log(`${LOG_PREFIX} Routed ${existing.data.cgId}: ${JSON.stringify(routeResult)}`);
  } catch (routeErr) {
    console.error(`${LOG_PREFIX} Routing failed: ${routeErr.message}`);
  }

  return {
    success: true,
    cgId: existing.data.cgId,
    transition: `${currentStage} → ${newStage}`,
  };
}


module.exports = {
  handleStageTransition,
};
