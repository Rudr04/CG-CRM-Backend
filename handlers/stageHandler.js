// ============================================================================
//  handlers/stageHandler.js — Stage Transition Handler
//
//  Handles stage_transition events sent by GAS when an agent
//  edits the Stage column or submits a transition form.
//
//  Validates the transition, writes stage + form data atomically
//  to Firestore, routes to target sheet, reverts on failure.
//
//  Separate from syncHandler because a stage transition is NOT
//  a simple field sync — it involves validation, cross-sheet
//  routing, and cell revert on failure.
//
//  FORM DATA FLOW:
//    GAS form → params.formData → validated against config.TRANSITION_REQUIREMENTS
//    → whitelisted fields written to Firestore in same call as pipelineStage
//    → stageRouter reads updated doc for target sheet insert
// ============================================================================

const FirestoreService = require('../services/firestoreService');
const FirebaseService  = require('../services/firebaseService');
const SheetService     = require('../services/sheetsService');
const stageRouter      = require('../services/stageRouter');
const config           = require('../config');

const LOG_PREFIX = '[StageTransition]';


// ─────────────────────────────────────────────────────────────
//  HELPER: Revert Stage cell on the source sheet
//  Used by both transition validation and readiness check.
// ─────────────────────────────────────────────────────────────
async function _revertStageCell(sourceRow, currentStage, params) {
  if (!sourceRow) return;

  try {
    const spreadsheetId = params.sourceSpreadsheetId || config.SPREADSHEET_ID;
    const tabName       = params.sourceTabName       || config.SHEETS.DSR;
    const colMap = await SheetService.getColumnMap(tabName, spreadsheetId);
    const stageColIdx = colMap.map.pipelineStage;

    if (stageColIdx !== undefined) {
      await SheetService.updateContactCells(
        sourceRow,
        { [stageColIdx]: currentStage },
        spreadsheetId,
        tabName
      );
      console.log(`${LOG_PREFIX} Reverted Stage cell to '${currentStage}' on ${tabName} row ${sourceRow}`);
    }
  } catch (revertErr) {
    console.error(`${LOG_PREFIX} Revert failed: ${revertErr.message}`);
  }
}


// ─────────────────────────────────────────────────────────────
//  MAIN HANDLER
// ─────────────────────────────────────────────────────────────
async function handleStageTransition(params) {
  const { phone, oldStage, newStage, sourceRow, editor } = params;

  // ── Basic param checks ──────────────────────────────────────
  if (!phone) {
    return { success: false, reason: 'no_phone' };
  }
  if (!newStage) {
    return { success: false, reason: 'no_target_stage' };
  }

  console.log(`${LOG_PREFIX} ${phone}: ${oldStage} → ${newStage} (by ${editor})`);

  // ── 1. Look up lead in Firestore ────────────────────────────
  const existing = await FirestoreService.findLeadByPhone(phone);
  if (!existing) {
    console.error(`${LOG_PREFIX} Lead not found: ${phone}`);
    return { success: false, reason: 'lead_not_found' };
  }

  // ── 2. Current stage from Firestore (source of truth) ───────
  // TEMP: fallback to .stage for pre-migration docs.
  // Remove after migrate-stage-collapse.js has run.
  const currentStage = existing.data.pipelineStage
                    || existing.data.stage
                    || config.STAGES.NOT_ASSIGNED;

  // ── 3. Validate transition is allowed ───────────────────────
  const allowedTargets = config.STAGE_TRANSITIONS[currentStage] || [];
  if (!allowedTargets.includes(newStage)) {
    console.warn(`${LOG_PREFIX} BLOCKED: ${currentStage} → ${newStage} (allowed: [${allowedTargets.join(', ')}])`);
    await _revertStageCell(sourceRow, currentStage, params);

    return {
      success: false,
      reason: 'invalid_stage_transition',
      from: currentStage,
      to: newStage,
      allowed: allowedTargets,
    };
  }

  // ── 3b. Readiness check + collect accepted form fields ──────
  const transitionKey = `${currentStage}→${newStage}`;
  const requirements = config.TRANSITION_REQUIREMENTS?.[transitionKey];
  const formUpdates = {};  // populated here, written in step 4

  if (requirements) {
    const formData = params.formData || {};
    const missingFields = [];

    // Bucket 1: Lead-level required fields
    if (requirements.required) {
      for (const fieldKey of requirements.required) {
        const value = existing.data[fieldKey];
        if (value === undefined || value === null || value === '') {
          missingFields.push(fieldKey);
        }
      }
    }

    // Bucket 2: Required specific values
    if (requirements.requiredValue) {
      for (const [fieldKey, expectedValue] of Object.entries(requirements.requiredValue)) {
        if (existing.data[fieldKey] !== expectedValue) {
          missingFields.push(`${fieldKey} (must be "${expectedValue}")`);
        }
      }
    }

    // Bucket 3: Form fields — validate required + collect accepted in ONE pass
    if (requirements.formAccepted || requirements.formRequired) {
      const requiredSet  = new Set(requirements.formRequired || []);
      const acceptedSet  = new Set(requirements.formAccepted || []);

      // Union: every accepted field + every required field (even if
      // someone forgot to add it to formAccepted)
      const allFields = new Set([...acceptedSet, ...requiredSet]);

      for (const fieldKey of allFields) {
        const value = formData[fieldKey];
        const isEmpty = value === undefined || value === null || value === '' ||
                        (typeof value === 'number' && value <= 0);

        if (isEmpty && requiredSet.has(fieldKey)) {
          missingFields.push(fieldKey);
        } else if (!isEmpty && acceptedSet.has(fieldKey)) {
          formUpdates[fieldKey] = value;
        }
      }
    }

    if (missingFields.length > 0) {
      console.warn(`${LOG_PREFIX} BLOCKED (missing data): [${missingFields.join(', ')}] for ${transitionKey}`);
      await _revertStageCell(sourceRow, currentStage, params);

      return {
        success: false,
        reason: 'missing_required_fields',
        transition: transitionKey,
        missingFields,
        description: requirements.description,
      };
    }
  }

  // ── 4. Valid transition — single atomic Firestore write ─────
  //    Stage change + form data (collected in 3b) land in ONE call.
  //    stageRouter reads from Firestore after this, so all fields
  //    are guaranteed present for the target sheet insert.
  console.log(`${LOG_PREFIX} Valid: ${currentStage} → ${newStage}`);

  const updates = { pipelineStage: newStage, ...formUpdates };

  const historyEntry = {
    action: 'stage_transition',
    by: editor || 'system',
    details: { from: currentStage, to: newStage },
  };

  await FirestoreService.updateLead(phone, updates, historyEntry);
  console.log(`${LOG_PREFIX} Firestore updated: ${existing.data.cgId} → ${newStage}`);

  // ── 4b. Form-specific history entry (config-driven) ─────────
  if (Object.keys(formUpdates).length > 0 && requirements?.historyAction) {
    const details = requirements.historyDetailsFn
      ? requirements.historyDetailsFn(params.formData)
      : { ...formUpdates };

    await FirestoreService.addHistory(
      phone,
      requirements.historyAction,
      editor || 'system',
      details
    );
    console.log(`${LOG_PREFIX} Form history recorded: ${requirements.historyAction}`);
  }

  // ── 4c. Side effects (non-Firestore-write) ─────────────────
  if (newStage === 'fulfillment') {
    try {
      const leadName  = existing.data.name  || '';
      const leadPhone = existing.data.phone || phone;
      await FirebaseService.addToWhitelist(leadPhone, leadName, 'fulfillment_auto');
      console.log(`${LOG_PREFIX} Auto-whitelisted ${leadPhone} on fulfillment transition`);
    } catch (whitelistErr) {
      console.error(`${LOG_PREFIX} Auto-whitelist FAILED for ${phone}: ${whitelistErr.message}`);
    }
  }

  // ── 5. Route to target sheet ────────────────────────────────
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