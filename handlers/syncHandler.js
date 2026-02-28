// ============================================================================
//  handlers/syncHandler.js — Sheet → Firestore Sync Handler
// ============================================================================

const FirestoreService = require('../services/firestoreService');
const config = require('../config');
const { normalizePhone } = require('../utils/helpers');

const LOG_PREFIX = '[Sync]';


// ═══════════════════════════════════════════════════════════════════════════
//  FIELD MAPPING
// ═══════════════════════════════════════════════════════════════════════════

const FIELD_MAP = {
  'name': 'name',
  'location': 'location',
  'team': 'agent',
  'status': 'status',
  'rating': 'rating',
  'remark': 'remark',
  'team_2': 'team2',
  'status_2': 'status2',
  'remark_2': 'remark2',
};


// ═══════════════════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════

async function handleSheetEdit(params) {
  const edits = params.edits || [];
  const editor = params.editor || 'unknown';
  const isRetry = params.isRetry || false;

  if (edits.length === 0) {
    return { synced: 0, errors: 0, failed: [], message: 'No edits' };
  }

  console.log(`${LOG_PREFIX} Processing ${edits.length} edit(s)${isRetry ? ' (RETRY)' : ''}`);

  const results = { synced: 0, errors: 0, failed: [] };

  for (const edit of edits) {
    try {
      const result = await processEdit(edit, editor);
      
      if (result.success) {
        results.synced++;
      } else {
        results.errors++;
        edit.failReason = result.reason || 'unknown';
        results.failed.push(edit);
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} Error: ${error.message}`);
      results.errors++;
      edit.retryCount = (edit.retryCount || 0) + 1;
      edit.failReason = error.message;
      results.failed.push(edit);
      
      FirestoreService.storeSyncFailure(edit, error).catch(() => {});
    }
  }

  console.log(`${LOG_PREFIX} Done: ${results.synced} synced, ${results.errors} errors`);
  return { synced: results.synced, errors: results.errors, failed: results.failed, message: `Processed ${edits.length}` };
}


// ═══════════════════════════════════════════════════════════════════════════
//  PROCESS SINGLE EDIT
// ═══════════════════════════════════════════════════════════════════════════

async function processEdit(edit, editor) {
  const { phone, field, oldValue, newValue, row } = edit;

  if (!phone) return { success: false, reason: 'no_phone' };

  const phoneNorm = normalizePhone(phone);
  if (!phoneNorm || phoneNorm.length < 10) {
    return { success: false, reason: 'invalid_phone' };
  }

  const firestoreField = FIELD_MAP[field];
  if (!firestoreField) {
    return { success: false, reason: 'unknown_field' };
  }

  let existing = await FirestoreService.findLeadByPhone(phone);
  
  if (!existing) {
    console.log(`${LOG_PREFIX} Creating lead: ${phoneNorm}`);
    
    const rowData = edit.rowData || {};
    
    const createResult = await FirestoreService.createLead({
      phone,
      name: rowData.name || '',
      status: rowData.status || config.DEFAULTS.STATUS,
      team: rowData.team || config.STAGES.NOT_ASSIGNED,
      location: rowData.location || '',
      product: rowData.product || '',
      source: 'sheet_backfill',
      channel: 'sheet_sync',
      sheetRow: row
    });
    
    if (!createResult) return { success: false, reason: 'create_failed' };
    
    existing = await FirestoreService.findLeadByPhone(phone);
    if (!existing) return { success: false, reason: 'create_verification_failed' };
  }

  const updates = { [firestoreField]: newValue || '' };

  if (field === 'team') {
    const isNotAssigned = !newValue || newValue === config.STAGES.NOT_ASSIGNED;
    updates.agent = newValue || config.STAGES.NOT_ASSIGNED;
    updates.stage = isNotAssigned ? config.STAGES.NOT_ASSIGNED : config.STAGES.AGENT_WORKING;
  }

  const historyEntry = {
    action: edit.action || 'field_updated',
    by: field === 'team' && newValue && newValue !== config.STAGES.NOT_ASSIGNED ? newValue : editor,
    details: buildHistoryDetails(field, oldValue, newValue)
  };

  const result = await FirestoreService.updateLead(phone, updates, historyEntry);
  if (!result) return { success: false, reason: 'update_failed' };

  console.log(`${LOG_PREFIX} ${existing.data.cgId}: ${field} → "${(newValue || '').substring(0, 30)}"`);
  return { success: true, cgId: existing.data.cgId };
}


function buildHistoryDetails(field, oldValue, newValue) {
  const details = {};
  
  if (['team', 'status', 'status_2'].includes(field)) {
    details.from = oldValue || '';
    details.to = newValue || '';
  } else if (field === 'rating') {
    details.rating = newValue || '';
  } else if (['remark', 'remark_2'].includes(field)) {
    details.text = (newValue || '').substring(0, 200);
  } else if (field === 'name') {
    details.oldName = oldValue || '';
    details.newName = newValue || '';
  } else {
    details.value = newValue || '';
  }
  
  return details;
}


module.exports = {
  handleSheetEdit
};