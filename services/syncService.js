// ============================================================================
//  services/syncService.js — Outbound Sync: Firestore → Sheets
//
//  Called by Cloud Scheduler every 3-5 minutes
//  Reads leads updated since last sync, routes to correct spreadsheet
// ============================================================================

const { google } = require('googleapis');
const FirestoreService = require('./firestoreService');
const config = require('../config');
const { formatDate } = require('../utils/helpers');

const LOG_PREFIX = '[OutboundSync]';

let sheets;

async function getSheets() {
  if (!sheets) {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheets = google.sheets({ version: 'v4', auth });
  }
  return sheets;
}


// ═══════════════════════════════════════════════════════════════════════════
//  SYNC STATE
// ═══════════════════════════════════════════════════════════════════════════

const SYNC_STATE_DOC = 'sync_state/outbound';

async function getLastSyncTimestamp() {
  const db = FirestoreService.getDb();
  const doc = await db.doc(SYNC_STATE_DOC).get();
  if (!doc.exists) return '1970-01-01T00:00:00.000Z';
  return doc.data().lastSyncTimestamp || '1970-01-01T00:00:00.000Z';
}

async function setLastSyncTimestamp(timestamp) {
  const db = FirestoreService.getDb();
  await db.doc(SYNC_STATE_DOC).set({
    lastSyncTimestamp: timestamp,
    updatedAt: new Date().toISOString()
  }, { merge: true });
}


// ═══════════════════════════════════════════════════════════════════════════
//  LEAD → SHEET ROW CONVERSION
// ═══════════════════════════════════════════════════════════════════════════

function leadToRow(lead) {
  const now = lead.createdAt ? new Date(lead.createdAt) : new Date();
  return [
    '',                                  // CGILN (0) — formula, set separately
    lead.createdDate || formatDate(now), // DATE (1)
    lead.createdTime || '',              // TIME (2)
    lead.name || '',                     // NAME (3)
    lead.phone || '',                    // NUMBER (4)
    lead.regiNo || '',                   // REGI_NO (5)
    lead.location || '',                 // LOCATION (6)
    lead.product || 'CGI',               // PRODUCT (7)
    lead.message || '',                  // MESSAGE (8)
    lead.source || '',                   // SOURCE (9)
    lead.agent || 'Not Assigned',        // TEAM (10)
    lead.status || 'Lead',               // STATUS (11)
    lead.rating || '',                   // RATING (12)
    '',                                  // ACTION (13)
    lead.remark || '',                   // REMARK (14)
    lead.team2 || '',                    // TEAM_2 (15)
    lead.status2 || '',                  // STATUS_2 (16)
    lead.remark2 || '',                  // REMARK_2 (17)
  ];
}


// ═══════════════════════════════════════════════════════════════════════════
//  MAIN SYNC FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

async function syncToSheets() {
  const startTime = Date.now();
  const lastSync = await getLastSyncTimestamp();

  console.log(`${LOG_PREFIX} Starting. Last sync: ${lastSync}`);

  // Fetch updated leads
  const leads = await FirestoreService.getLeadsByUpdatedAt(lastSync);

  if (leads.length === 0) {
    console.log(`${LOG_PREFIX} No updates since last sync`);
    return { synced: 0, targets: 0 };
  }

  console.log(`${LOG_PREFIX} ${leads.length} lead(s) to sync`);

  const api = await getSheets();
  let targetsWritten = 0;

  // For each sync target, filter leads and write
  for (const target of config.SYNC_TARGETS) {
    if (!target.id) {
      console.log(`${LOG_PREFIX} Skipping "${target.name}" — no spreadsheet ID configured`);
      continue;
    }

    const matchingLeads = leads.filter(lead => target.filter(lead.stage || 'unclaimed'));

    if (matchingLeads.length === 0) continue;

    try {
      await writeLeadsToSheet(api, target, matchingLeads);
      targetsWritten++;
      console.log(`${LOG_PREFIX} Wrote ${matchingLeads.length} leads to "${target.name}"`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed writing to "${target.name}": ${err.message}`);
    }
  }

  // Update sync timestamp to the latest updatedAt from the leads we processed
  const latestUpdate = leads.reduce((max, l) => l.updatedAt > max ? l.updatedAt : max, lastSync);
  await setLastSyncTimestamp(latestUpdate);

  const elapsed = Date.now() - startTime;
  console.log(`${LOG_PREFIX} Done in ${elapsed}ms. ${leads.length} leads → ${targetsWritten} targets`);

  return { synced: leads.length, targets: targetsWritten, elapsed };
}


// ═══════════════════════════════════════════════════════════════════════════
//  WRITE LEADS TO SHEET
// ═══════════════════════════════════════════════════════════════════════════

async function writeLeadsToSheet(api, target, leads) {
  const sheetName = target.sheet;

  // Read existing phone numbers to find which rows to update vs append
  let existingPhones = {};
  try {
    const existing = await api.spreadsheets.values.get({
      spreadsheetId: target.id,
      range: `${sheetName}!E2:E`  // Phone column
    });
    const rows = existing.data.values || [];
    rows.forEach((row, i) => {
      const phone = (row[0] || '').toString().replace(/\D/g, '').slice(-10);
      if (phone) existingPhones[phone] = i + 2; // row number (1-based, +1 for header)
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} Could not read existing data from "${target.name}": ${err.message}`);
    // If sheet doesn't exist or is empty, we'll append everything
  }

  const updates = [];
  const appends = [];

  for (const lead of leads) {
    const phone10 = (lead.phone || '').toString().replace(/\D/g, '').slice(-10);
    const row = leadToRow(lead);

    if (existingPhones[phone10]) {
      // Update existing row (skip CGILN formula column, start from B)
      const rowNum = existingPhones[phone10];
      updates.push({
        range: `${sheetName}!B${rowNum}:R${rowNum}`,
        values: [row.slice(1)]  // skip column A (CGILN formula)
      });
    } else {
      // New lead for this sheet — append
      row[0] = `=ROW()-1+230000`; // CGILN formula
      appends.push(row);
    }
  }

  // Batch update existing rows
  if (updates.length > 0) {
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: target.id,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates }
    });
  }

  // Append new rows
  if (appends.length > 0) {
    await api.spreadsheets.values.append({
      spreadsheetId: target.id,
      range: `${sheetName}!A:R`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: appends }
    });
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  syncToSheets,
  getLastSyncTimestamp,
  setLastSyncTimestamp,
};
