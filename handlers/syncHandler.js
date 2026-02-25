// ============================================================
//  syncHandler.js — Sheet → Firestore real-time sync
//  Receives edit events from Apps Script onEdit trigger
//  Updates Firestore document + adds history entry
//
//  ERROR HANDLING:
//  - Returns detailed results including failed edits
//  - Apps Script can retry failed edits
//  - Optionally stores failures in Firestore for tracking
// ============================================================

const FirestoreService = require('../services/firestoreService');
const config = require('../config');

// ─────────────────────────────────────────────────────────────
//  Map sheet field names to Firestore document fields
// ─────────────────────────────────────────────────────────────
const FIELD_MAP = {
  'name':      'name',
  'location':  'location',
  'team':      'agent',       // Team column = agent field in Firestore
  'status':    'status',
  'rating':    'rating',
  'remark':    'remark',
  'team_2':    'team2',
  'status_2':  'status2',
  'remark_2':  'remark2',
};

// Fields where we append instead of overwrite
const APPEND_FIELDS = ['remark', 'remark_2'];


// ─────────────────────────────────────────────────────────────
//  HANDLE SHEET EDIT — main entry point
//  Payload: { eventType: 'sheet_edit', edits: [...], editor, timestamp, isRetry }
//  
//  Returns: { synced, errors, failed: [...] }
//  - failed array contains edits that couldn't be processed
//  - Apps Script will store these in dead letter queue
// ─────────────────────────────────────────────────────────────
async function handleSheetEdit(params) {
  const edits  = params.edits || [];
  const editor = params.editor || 'unknown';
  const isRetry = params.isRetry || false;

  if (edits.length === 0) {
    return { synced: 0, errors: 0, failed: [], message: 'No edits to process' };
  }

  console.log(`[Sync] Processing ${edits.length} edit(s) from ${editor}${isRetry ? ' (RETRY)' : ''}`);

  const results = { 
    synced: 0, 
    errors: 0, 
    failed: [],
    details: []
  };

  for (const edit of edits) {
    try {
      const result = await processEdit(edit, editor);
      
      if (result.success) {
        results.synced++;
        results.details.push({
          phone: edit.phone,
          field: edit.field,
          status: 'synced',
          cgId: result.cgId
        });
      } else {
        // Soft failure (e.g., validation issue)
        results.errors++;
        edit.failReason = result.reason || 'unknown';
        results.failed.push(edit);
        results.details.push({
          phone: edit.phone,
          field: edit.field,
          status: 'failed',
          reason: result.reason
        });
      }
      
    } catch (error) {
      // Hard failure (exception)
      console.error(`[Sync] Error processing edit for ${edit.phone}: ${error.message}`);
      results.errors++;
      
      // Increment retry count and add to failed list
      edit.retryCount = (edit.retryCount || 0) + 1;
      edit.failReason = error.message;
      edit.lastError = error.message;
      results.failed.push(edit);
      
      results.details.push({
        phone: edit.phone,
        field: edit.field,
        status: 'error',
        reason: error.message
      });
      
      // Store in Firestore for tracking (non-blocking)
      FirestoreService.storeSyncFailure(edit, error).catch(() => {});
    }
  }

  console.log(`[Sync] Done: ${results.synced} synced, ${results.errors} errors, ${results.failed.length} failed`);
  
  return {
    synced: results.synced,
    errors: results.errors,
    failed: results.failed,
    message: `Processed ${edits.length} edit(s)`
  };
}


// ─────────────────────────────────────────────────────────────
//  PROCESS SINGLE EDIT
//  Returns: { success: true, cgId } or { success: false, reason }
// ─────────────────────────────────────────────────────────────
async function processEdit(edit, editor) {
  const { phone, field, oldValue, newValue, action, row } = edit;

  // ── Validation ──
  if (!phone) {
    console.warn('[Sync] Edit skipped — no phone number');
    return { success: false, reason: 'no_phone' };
  }

  const phoneNorm = FirestoreService.normalizePhone(phone);
  if (!phoneNorm || phoneNorm.length < 10) {
    console.warn(`[Sync] Edit skipped — invalid phone: ${phone}`);
    return { success: false, reason: 'invalid_phone' };
  }

  const firestoreField = FIELD_MAP[field];
  if (!firestoreField) {
    console.warn(`[Sync] Unknown field mapping: ${field}`);
    return { success: false, reason: 'unknown_field' };
  }

  // ── Check if lead exists ──
  let existing = await FirestoreService.findLeadByPhone(phone);
  
  // If lead doesn't exist, create it first
  if (!existing) {
    console.log(`[Sync] Lead ${phoneNorm} not in Firestore — creating new entry`);
    
    const createResult = await FirestoreService.createLead({
      phone:   phone,
      name:    '',
      status:  field === 'status' ? newValue : 'Lead',
      team:    field === 'team' ? newValue : config.STAGES.NOT_ASSIGNED,
      source:  'sheet_backfill',
      channel: 'sheet_sync',
      sheetRow: row
    });
    
    if (!createResult) {
      return { success: false, reason: 'create_failed' };
    }
    
    existing = await FirestoreService.findLeadByPhone(phone);
    if (!existing) {
      return { success: false, reason: 'create_verification_failed' };
    }
  }

  // ── Build Firestore update ──
  const updates = {};
  updates[firestoreField] = newValue || '';

  // ── Special handling for Team (claiming) ──
  if (field === 'team') {
    const isNotAssigned = !newValue || newValue === config.STAGES.NOT_ASSIGNED;
    updates.agent = newValue || config.STAGES.NOT_ASSIGNED;
    updates.stage = isNotAssigned ? config.STAGES.NOT_ASSIGNED : config.STAGES.AGENT_WORKING;
  }

  // ── Build history entry ──
  const historyEntry = {
    action:  action || 'field_updated',
    by:      resolveAttributor(editor, field, newValue),
    details: buildHistoryDetails(field, oldValue, newValue)
  };

  // ── Update Firestore ──
  const result = await FirestoreService.updateLead(phone, updates, historyEntry);

  if (!result) {
    return { success: false, reason: 'update_failed' };
  }

  console.log(`[Sync] ${existing.data.cgId}: ${field} → "${(newValue || '').substring(0, 50)}" by ${historyEntry.by}`);
  
  return { success: true, cgId: existing.data.cgId };
}


// ─────────────────────────────────────────────────────────────
//  BUILD HISTORY DETAILS — field-specific context
// ─────────────────────────────────────────────────────────────
function buildHistoryDetails(field, oldValue, newValue) {
  const details = {};
  
  switch (field) {
    case 'team':
      details.from = oldValue || config.STAGES.NOT_ASSIGNED;
      details.to   = newValue || config.STAGES.NOT_ASSIGNED;
      break;
      
    case 'status':
    case 'status_2':
      details.from = oldValue || '';
      details.to   = newValue || '';
      break;
      
    case 'rating':
      details.rating = newValue || '';
      break;
      
    case 'remark':
    case 'remark_2':
      // Truncate long remarks in history
      details.text = (newValue || '').substring(0, 200);
      break;
      
    case 'name':
      details.oldName = oldValue || '';
      details.newName = newValue || '';
      break;
      
    case 'location':
      details.location = newValue || '';
      break;
      
    default:
      details.value = newValue || '';
  }
  
  return details;
}


// ─────────────────────────────────────────────────────────────
//  ATTRIBUTION: Decide who gets credit for this edit
// ─────────────────────────────────────────────────────────────
function resolveAttributor(editor, field, newValue) {
  // Claiming: the agent IS the new value
  if (field === 'team' && newValue && newValue !== config.STAGES.NOT_ASSIGNED) {
    return newValue;
  }

  // For other edits: use editor email
  return editor || 'unknown';
}


module.exports = {
  handleSheetEdit
};