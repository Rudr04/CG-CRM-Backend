// ============================================================
//  sheetRoutingService.js — Real-time Sheet Routing (Phase 3)
//
//  Dynamic column mapping: reads each sheet's header row and
//  writes fields by name, not position. Supports different
//  column layouts per sheet (AGENTS=15, PAYMENTS=14, etc.)
//
//  Called synchronously by stageHandler after Firestore update.
//  NOT a scheduled batch — happens immediately on every transition.
// ============================================================

const { google } = require('googleapis');
const config = require('../config');
const { getLastTenDigits } = require('../utils/helpers');

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

// Cache header maps per spreadsheet+tab (cleared on each function invocation)
const headerCache = {};

async function getHeaderMap(api, spreadsheetId, sheetName) {
  const cacheKey = `${spreadsheetId}:${sheetName}`;
  if (headerCache[cacheKey]) return headerCache[cacheKey];

  const response = await api.spreadsheets.values.get({
    spreadsheetId, range: `${sheetName}!1:1`
  });
  const headers = (response.data.values || [[]])[0];
  const map = {};
  headers.forEach((h, i) => {
    const text = (h || '').toString().trim();
    if (text) map[text] = i;
  });
  headerCache[cacheKey] = map;
  return map;
}


// ─── ROUTE LEAD — called after every stage transition ───
async function routeLeadToSheets(lead, oldStage, newStage) {
  const phone10 = getLastTenDigits(lead.phone || lead.phone10 || '');
  if (!phone10 || phone10.length < 10) {
    console.warn('[Routing] Skipped — invalid phone');
    return { routed: false, reason: 'invalid_phone' };
  }

  const api = await getSheets();
  const addTo = [];
  const removeFrom = [];

  for (const target of config.SYNC_TARGETS) {
    if (!target.id) continue;
    const matchesNew = target.filter(newStage);
    const matchedOld = target.filter(oldStage);
    if (matchesNew) addTo.push(target);
    else if (matchedOld) removeFrom.push(target);
  }

  console.log(`[Routing] ${lead.cgid || phone10}: ${oldStage} → ${newStage} | ` +
    `Add: [${addTo.map(t => t.role).join(',')}] | Remove: [${removeFrom.map(t => t.role).join(',')}]`);

  const results = { added: [], removed: [], errors: [] };

  // INSERT FIRST (safe failure mode: lead in both sheets temporarily)
  for (const target of addTo) {
    try {
      await upsertLeadInSheet(api, target, lead);
      results.added.push(target.role);
    } catch (err) {
      console.error(`[Routing] Write to ${target.role} failed: ${err.message}`);
      results.errors.push({ sheet: target.role, op: 'write', error: err.message });
    }
  }

  // DELETE AFTER (only if insert succeeded for at least one target)
  if (results.added.length > 0 || addTo.length === 0) {
    for (const target of removeFrom) {
      try {
        await deleteLeadFromSheet(api, target, phone10);
        results.removed.push(target.role);
      } catch (err) {
        console.error(`[Routing] Delete from ${target.role} failed: ${err.message}`);
        results.errors.push({ sheet: target.role, op: 'delete', error: err.message });
      }
    }
  }

  return { routed: true, ...results };
}


// ─── UPSERT: write lead to sheet using dynamic headers ───
async function upsertLeadInSheet(api, target, lead) {
  const sheetName = target.sheet;
  const schema = config.SHEET_SCHEMAS[target.role];
  if (!schema) throw new Error(`No schema for role ${target.role}`);

  const headerMap = await getHeaderMap(api, target.id, sheetName);
  const phone10 = getLastTenDigits(lead.phone || lead.phone10 || '');

  // Build row array matching the sheet's column order
  const totalCols = Math.max(...Object.values(headerMap)) + 1;
  const rowData = new Array(totalCols).fill('');

  for (const fieldKey of schema) {
    const headerText = config.FIELD_DEFS[fieldKey];
    if (!headerText) continue;
    const colIndex = headerMap[headerText];
    if (colIndex === undefined) continue;

    // Skip pendingAmount — will be set as formula after finding row
    if (fieldKey === 'pendingAmount') continue;

    rowData[colIndex] = lead[fieldKey] || '';
  }

  // Find existing row
  const existingRow = await findRowByPhone(api, target.id, sheetName, headerMap, phone10);

  if (existingRow) {
    await api.spreadsheets.values.update({
      spreadsheetId: target.id,
      range: `${sheetName}!A${existingRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });
    console.log(`[Routing] Updated row ${existingRow} in ${target.role}`);
  } else {
    const lastCol = String.fromCharCode(65 + Math.min(totalCols - 1, 25));
    await api.spreadsheets.values.append({
      spreadsheetId: target.id,
      range: `${sheetName}!A:${lastCol}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });
    console.log(`[Routing] Appended to ${target.role}`);
  }

  // Set Pending Amount formula if the sheet has that column
  if (schema.includes('pendingAmount') && headerMap['Pending Amount'] !== undefined) {
    const priceCol = headerMap['Product Price'];
    const qtyCol = headerMap['Quantity'];
    const paidCol = headerMap['Amount Paid'];
    if (priceCol !== undefined && qtyCol !== undefined && paidCol !== undefined) {
      const targetRow = existingRow || await getLastDataRow(api, target.id, sheetName);
      const priceLetter = String.fromCharCode(65 + priceCol);
      const qtyLetter = String.fromCharCode(65 + qtyCol);
      const paidLetter = String.fromCharCode(65 + paidCol);
      const pendingLetter = String.fromCharCode(65 + headerMap['Pending Amount']);
      const formula = `=${priceLetter}${targetRow}*${qtyLetter}${targetRow}-${paidLetter}${targetRow}`;

      await api.spreadsheets.values.update({
        spreadsheetId: target.id,
        range: `${sheetName}!${pendingLetter}${targetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[formula]] }
      });
    }
  }
}


// ─── DELETE: remove lead row from sheet ───
async function deleteLeadFromSheet(api, target, phone10) {
  const sheetName = target.sheet;
  const headerMap = await getHeaderMap(api, target.id, sheetName);
  const rowNumber = await findRowByPhone(api, target.id, sheetName, headerMap, phone10);

  if (!rowNumber) {
    console.log(`[Routing] ${phone10} not in ${target.role} — skip delete`);
    return;
  }

  // Get numeric sheet ID for delete request
  const spreadsheet = await api.spreadsheets.get({
    spreadsheetId: target.id, fields: 'sheets.properties'
  });
  const sheetObj = spreadsheet.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheetObj) return;

  await api.spreadsheets.batchUpdate({
    spreadsheetId: target.id,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheetObj.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowNumber - 1,
            endIndex: rowNumber
          }
        }
      }]
    }
  });
  console.log(`[Routing] Deleted row ${rowNumber} from ${target.role}`);
}


// ─── FIND ROW by phone number (dynamic column) ───
async function findRowByPhone(api, spreadsheetId, sheetName, headerMap, phone10) {
  const mobileHeader = config.FIELD_DEFS['mobile']; // "Mobile Number"
  const mobileCol = headerMap[mobileHeader];
  if (mobileCol === undefined) return null;

  const colLetter = String.fromCharCode(65 + mobileCol);
  const response = await api.spreadsheets.values.get({
    spreadsheetId, range: `${sheetName}!${colLetter}2:${colLetter}`
  });

  const rows = response.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').toString().replace(/\D/g, '').slice(-10);
    if (cell === phone10) return i + 2;
  }
  return null;
}

async function getLastDataRow(api, spreadsheetId, sheetName) {
  const response = await api.spreadsheets.values.get({
    spreadsheetId, range: `${sheetName}!A:A`
  });
  return (response.data.values || []).length;
}


// ─── ROUTE NEW LEAD (on creation) ───
async function routeNewLead(lead) {
  const stage = lead.stage || 'unclaimed';
  const api = await getSheets();

  for (const target of config.SYNC_TARGETS) {
    if (!target.id || !target.filter(stage)) continue;
    try {
      await upsertLeadInSheet(api, target, lead);
      console.log(`[Routing] New lead ${lead.cgid || ''} → ${target.role}`);
    } catch (err) {
      console.error(`[Routing] New lead to ${target.role} failed: ${err.message}`);
    }
  }
}

module.exports = { routeLeadToSheets, routeNewLead, upsertLeadInSheet, deleteLeadFromSheet };
