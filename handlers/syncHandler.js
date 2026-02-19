// ============================================================
//  syncHandler.js — Sheet → Firestore real-time sync
//  Receives edit events from Apps Script onEdit trigger
//  Updates Firestore document + adds history entry
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
//  Payload: { eventType: 'sheet_edit', edits: [...], editor, timestamp }
// ─────────────────────────────────────────────────────────────
async function handleSheetEdit(params) {
  const edits  = params.edits || [];
  const editor = params.editor || 'unknown';

  if (edits.length === 0) {
    return { message: 'No edits to process' };
  }

  console.log(`[Sync] Processing ${edits.length} edit(s) from ${editor}`);

  const results = { synced: 0, skipped: 0, errors: 0 };

  for (const edit of edits) {
    try {
      await processEdit(edit, editor);
      results.synced++;
    } catch (error) {
      console.error(`[Sync] Error processing edit for ${edit.phone}: ${error.message}`);
      results.errors++;
    }
  }

  console.log(`[Sync] Done: ${results.synced} synced, ${results.skipped} skipped, ${results.errors} errors`);
  return results;
}


// ─────────────────────────────────────────────────────────────
//  PROCESS SINGLE EDIT
// ─────────────────────────────────────────────────────────────
async function processEdit(edit, editor) {
  const { phone, field, oldValue, newValue, action } = edit;

  if (!phone) {
    console.warn('[Sync] Edit skipped — no phone number');
    return;
  }

  const firestoreField = FIELD_MAP[field];
  if (!firestoreField) {
    console.warn(`[Sync] Unknown field: ${field}`);
    return;
  }

  // ── Build Firestore update ──
  const updates = {};
  updates[firestoreField] = newValue || '';

  // ── Special handling for Team (claiming) ──
  if (field === 'team') {
    // Agent changed Team column
    // "Not Assigned" → agent name = claiming
    // Agent name → different name = reassignment
    const isNotAssigned = !newValue || newValue === config.STAGES.NOT_ASSIGNED;
    updates.agent = newValue || config.STAGES.NOT_ASSIGNED;
    updates.stage = isNotAssigned ? config.STAGES.NOT_ASSIGNED : config.STAGES.AGENT_WORKING;
  }

  // ── Build history entry ──
  const historyEntry = {
    action:  action || 'field_updated',
    by:      resolveAttributor(editor, field, newValue),
    details: {}
  };

  // Add old/new to history where meaningful
  if (field === 'team') {
    historyEntry.details.from = oldValue || config.STAGES.NOT_ASSIGNED;
    historyEntry.details.to   = newValue || config.STAGES.NOT_ASSIGNED;
  } else if (field === 'status') {
    historyEntry.details.from = oldValue || '';
    historyEntry.details.to   = newValue || '';
  } else if (field === 'rating') {
    historyEntry.details.rating = newValue || '';
  } else if (field === 'remark' || field === 'remark_2') {
    historyEntry.details.text = (newValue || '').substring(0, 200);
  }

  // ── Update Firestore ──
  const result = await FirestoreService.updateLead(phone, updates, historyEntry);

  if (!result) {
    // Document doesn't exist in Firestore yet — create it
    // This handles leads that were created before Phase 1 deployment
    console.log(`[Sync] Lead ${phone} not in Firestore — creating stub`);
    await FirestoreService.createLead({
      phone:   phone,
      name:    '',      // Will be filled by next full-row sync or form data
      status:  field === 'status' ? newValue : 'Lead',
      team:    field === 'team' ? newValue : config.STAGES.NOT_ASSIGNED,
      source:  'backfill_from_edit',
      channel: 'sheet_edit'
    });

    // Retry the update now that doc exists
    await FirestoreService.updateLead(phone, updates, historyEntry);
  }

  console.log(`[Sync] ${phone}: ${field} → "${(newValue || '').substring(0, 50)}" by ${historyEntry.by}`);
}


// ─────────────────────────────────────────────────────────────
//  ATTRIBUTION: Decide who gets credit for this edit
//  For team/claiming: use the new agent name (they're editing their own cell)
//  For everything else: use the assigned agent from Firestore (default)
//  Editor email is available as fallback
// ─────────────────────────────────────────────────────────────
function resolveAttributor(editor, field, newValue) {
  // Claiming: the agent IS the new value
  if (field === 'team' && newValue && newValue !== config.STAGES.NOT_ASSIGNED) {
    return newValue;
  }

  // For other edits: use editor email (installable trigger provides this)
  // This is the actual person who made the edit
  return editor || 'unknown';
}


module.exports = {
  handleSheetEdit
};
