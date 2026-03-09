// ============================================================
//  sheetRoutingService.js — Real-time Sheet Routing
//
//  When a lead's stage changes, this service:
//    1. Finds which sheets the lead should NOW appear in
//    2. Finds which sheets the lead should NO LONGER appear in
//    3. Writes/updates rows in target sheets
//    4. Deletes rows from sheets the lead left
//
//  Called synchronously by stageHandler after Firestore update.
//  NOT a scheduled batch — happens immediately on every transition.
// ============================================================

const { google } = require('googleapis');
const config = require('../config');
const { formatDate, getLastTenDigits } = require('../utils/helpers');

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

// ─────────────────────────────────────────────────────────────
//  ROUTE LEAD — Main entry point
//  Called after every stage change (claim, transition, payment, etc.)
//
//  @param {Object} lead       — Full lead data from Firestore
//  @param {string} oldStage   — Previous stage (before transition)
//  @param {string} newStage   — New stage (after transition)
// ─────────────────────────────────────────────────────────────
async function routeLeadToSheets(lead, oldStage, newStage) {
  const phone = lead.phone || lead.phone10 || '';
  const phone10 = getLastTenDigits(phone);
  if (!phone10 || phone10.length < 10) {
    console.warn('[Routing] Skipped — invalid phone');
    return { routed: false, reason: 'invalid_phone' };
  }

  const api = await getSheets();

  // Determine which sheets this lead should be IN and NOT IN
  const addToSheets = [];     // sheets where newStage matches filter
  const removeFromSheets = []; // sheets where oldStage matched but newStage doesn't

  for (const target of config.SYNC_TARGETS) {
    if (!target.id) continue; // skip unconfigured sheets

    const matchesNew = target.filter(newStage);
    const matchedOld = target.filter(oldStage);

    if (matchesNew) {
      addToSheets.push(target);
    } else if (matchedOld && !matchesNew) {
      // Lead WAS in this sheet but no longer belongs
      removeFromSheets.push(target);
    }
  }

  console.log(`[Routing] ${phone10}: ${oldStage} → ${newStage} | ` +
    `Add to: [${addToSheets.map(t => t.name).join(', ')}] | ` +
    `Remove from: [${removeFromSheets.map(t => t.name).join(', ')}]`);

  const results = { added: [], removed: [], errors: [] };

  // ── WRITE to target sheets (upsert: update if exists, append if new) ──
  for (const target of addToSheets) {
    try {
      await upsertLeadInSheet(api, target, lead);
      results.added.push(target.name);
    } catch (err) {
      console.error(`[Routing] Failed to write to "${target.name}": ${err.message}`);
      results.errors.push({ sheet: target.name, op: 'write', error: err.message });
    }
  }

  // ── DELETE from sheets lead no longer belongs to ──
  for (const target of removeFromSheets) {
    try {
      await deleteLeadFromSheet(api, target, phone10);
      results.removed.push(target.name);
    } catch (err) {
      console.error(`[Routing] Failed to delete from "${target.name}": ${err.message}`);
      results.errors.push({ sheet: target.name, op: 'delete', error: err.message });
    }
  }

  return { routed: true, ...results };
}


// ─────────────────────────────────────────────────────────────
//  UPSERT: Find lead by phone in sheet. Update if found, append if not.
// ─────────────────────────────────────────────────────────────
async function upsertLeadInSheet(api, target, lead) {
  const sheetName = target.sheet;
  const phone10 = getLastTenDigits(lead.phone || lead.phone10 || '');

  // Read phone column to find existing row
  const existingRow = await findRowByPhone(api, target.id, sheetName, phone10);
  const rowData = leadToRow(lead);

  if (existingRow) {
    // Update existing row (columns B through R — skip A which has CGILN formula)
    await api.spreadsheets.values.update({
      spreadsheetId: target.id,
      range: `${sheetName}!B${existingRow}:R${existingRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData.slice(1)] }
    });
    console.log(`[Routing] Updated row ${existingRow} in "${target.name}"`);
  } else {
    // Append new row
    rowData[0] = '=ROW()-1+230000'; // CGILN formula
    await api.spreadsheets.values.append({
      spreadsheetId: target.id,
      range: `${sheetName}!A:R`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });
    console.log(`[Routing] Appended new row in "${target.name}"`);
  }
}


// ─────────────────────────────────────────────────────────────
//  DELETE: Find lead by phone in sheet and delete the entire row.
// ─────────────────────────────────────────────────────────────
async function deleteLeadFromSheet(api, target, phone10) {
  const sheetName = target.sheet;
  const rowNumber = await findRowByPhone(api, target.id, sheetName, phone10);

  if (!rowNumber) {
    console.log(`[Routing] Lead ${phone10} not found in "${target.name}" — nothing to delete`);
    return;
  }

  // Get the sheetId (numeric ID needed for deleteRows request)
  const spreadsheet = await api.spreadsheets.get({
    spreadsheetId: target.id,
    fields: 'sheets.properties'
  });

  const sheetObj = spreadsheet.data.sheets.find(
    s => s.properties.title === sheetName
  );

  if (!sheetObj) {
    console.warn(`[Routing] Sheet tab "${sheetName}" not found in spreadsheet "${target.name}"`);
    return;
  }

  const sheetId = sheetObj.properties.sheetId;

  // Delete the row using batchUpdate (this is the only way to truly delete a row)
  await api.spreadsheets.batchUpdate({
    spreadsheetId: target.id,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheetId,
            dimension: 'ROWS',
            startIndex: rowNumber - 1,  // 0-indexed
            endIndex: rowNumber         // exclusive
          }
        }
      }]
    }
  });

  console.log(`[Routing] Deleted row ${rowNumber} from "${target.name}"`);
}


// ─────────────────────────────────────────────────────────────
//  FIND ROW: Search phone column (E) for matching phone10
//  Returns 1-based row number, or null if not found.
// ─────────────────────────────────────────────────────────────
async function findRowByPhone(api, spreadsheetId, sheetName, phone10) {
  try {
    const response = await api.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: `${sheetName}!E2:E`  // Phone column, skip header
    });

    const rows = response.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      const cellPhone = (rows[i][0] || '').toString().replace(/\D/g, '').slice(-10);
      if (cellPhone === phone10) {
        return i + 2; // 1-based, +1 for header
      }
    }
    return null;
  } catch (err) {
    // Sheet might not exist yet or be empty — that's fine
    console.warn(`[Routing] findRowByPhone in "${sheetName}": ${err.message}`);
    return null;
  }
}


// ─────────────────────────────────────────────────────────────
//  LEAD TO ROW: Convert Firestore lead doc to sheet row array
// ─────────────────────────────────────────────────────────────
function leadToRow(lead) {
  return [
    '',                                  // A: CGILN (formula, set on append only)
    lead.createdDate || '',              // B: DATE
    lead.createdTime || '',              // C: TIME
    lead.name || '',                     // D: NAME
    lead.phone || '',                    // E: NUMBER
    lead.regiNo || '',                   // F: REGI_NO
    lead.location || '',                 // G: LOCATION
    lead.product || 'CGI',               // H: PRODUCT
    lead.message || '',                  // I: MESSAGE
    lead.source || '',                   // J: SOURCE
    lead.agent || 'Not Assigned',        // K: TEAM
    lead.status || 'Lead',               // L: STATUS
    lead.rating || '',                   // M: RATING
    '',                                  // N: ACTION (leave as-is)
    lead.remark || '',                   // O: REMARK
    lead.team2 || '',                    // P: TEAM_2
    lead.status2 || '',                  // Q: STATUS_2
    lead.remark2 || '',                  // R: REMARK_2
  ];
}


// ─────────────────────────────────────────────────────────────
//  ROUTE ON NEW LEAD CREATION
//  Called when a brand-new lead is created (from webhook).
//  Simpler than transition routing — just write to matching sheets.
// ─────────────────────────────────────────────────────────────
async function routeNewLead(lead) {
  const phone10 = getLastTenDigits(lead.phone || lead.phone10 || '');
  if (!phone10) return;

  const stage = lead.stage || 'unclaimed';
  const api = await getSheets();

  for (const target of config.SYNC_TARGETS) {
    if (!target.id) continue;
    if (!target.filter(stage)) continue;

    try {
      await upsertLeadInSheet(api, target, lead);
      console.log(`[Routing] New lead ${phone10} written to "${target.name}"`);
    } catch (err) {
      console.error(`[Routing] Failed writing new lead to "${target.name}": ${err.message}`);
    }
  }
}


module.exports = { routeLeadToSheets, routeNewLead, upsertLeadInSheet, deleteLeadFromSheet };
