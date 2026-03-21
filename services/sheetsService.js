// ============================================================================
//  sheetsService.js — Pure Google Sheets I/O
//
//  This service ONLY talks to the Google Sheets API.
//  It has ZERO imports from firestoreService or any other data store.
//  All orchestration (deciding what to write where) lives in handlers.
// ============================================================================

const { google } = require('googleapis');
const config = require('../config');
const { formatDate, getLastTenDigits, phoneNumbersMatch } = require('../utils/helpers');

let sheets;

async function getSheets() {
  if (!sheets) {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheets = google.sheets({ version: 'v4', auth });
    console.log('Google Sheets API initialized');
  }
  return sheets;
}


// ═════════════════════════════════════════════════════════════
//  UPSERT CONTACT — unified create-or-update in Sheet5
//
//  If phone already exists in Sheet → updates specific cells
//  If phone is new → appends a new row
//
//  IDEMPOTENT: safe to call multiple times for the same phone.
//  This is critical for the retry queue — retries won't create
//  duplicate rows.
//
//  @param {Object} leadData - { phone, name, location, product,
//         source, team, message, remark, status, ... }
//  @returns {{ row: number, action: 'created'|'updated' }}
// ═════════════════════════════════════════════════════════════
async function upsertContact(leadData) {
  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;
  const phone = leadData.phone || leadData.waId || '';

  if (!phone) throw new Error('upsertContact: phone is required');

  // Check if row already exists
  const existing = await findByPhone(phone);

  if (existing) {
    // ── Update existing row ──
    const C = config.SHEET_COLUMNS;
    const cellUpdates = {};

    // Append fields (merge with existing)
    if (leadData.message) {
      const current = existing.data[C.MESSAGE] || '';
      cellUpdates[C.MESSAGE] = current ? `${current} | ${leadData.message}` : leadData.message;
    }
    if (leadData.remark) {
      const current = existing.data[C.REMARK] || '';
      cellUpdates[C.REMARK] = current ? `${current} | ${leadData.remark}` : leadData.remark;
    }

    // Fill blanks (don't overwrite existing)
    if (leadData.name && !existing.data[C.NAME])         cellUpdates[C.NAME] = leadData.name;
    if (leadData.location && !existing.data[C.LOCATION]) cellUpdates[C.LOCATION] = leadData.location;
    if (leadData.source && !existing.data[C.SOURCE])     cellUpdates[C.SOURCE] = leadData.source;

    // Append inquiry and product (never overwrite — use | separator)
    if (leadData.inquiry) {
      const currentInquiry = existing.data[C.INQUIRY] || '';
      if (!currentInquiry.split(', ').includes(leadData.inquiry)) {
        cellUpdates[C.INQUIRY] = currentInquiry ? `${currentInquiry}, ${leadData.inquiry}` : leadData.inquiry;
      }
    }
    if (leadData.product) {
      const currentProduct = existing.data[C.PRODUCT] || '';
      if (!currentProduct.split(', ').includes(leadData.product)) {
        cellUpdates[C.PRODUCT] = currentProduct ? `${currentProduct}, ${leadData.product}` : leadData.product;
      }
    }

    if (Object.keys(cellUpdates).length > 0) {
      await updateContactCells(existing.row, cellUpdates);
    }

    return { row: existing.row, action: 'updated' };

  } else {
    // ── Append new row ──
    const response = await api.spreadsheets.values.get({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!A2:A`
    });
    const rows = response.data.values || [];
    const nextRow = rows.length + 2;

    const now = new Date();
    const date = formatDate(now);
    const opts = { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' };
    const time = new Intl.DateTimeFormat('en-IN', opts).format(now);

    const name     = leadData.name || leadData.senderName || '';
    const location = leadData.location || '';
    const inquiry  = leadData.inquiry || 'CGI';
    const product  = leadData.product || '';
    const source   = leadData.source || '';
    const team     = leadData.team || leadData.agent || 'Not Assigned';
    const message  = leadData.message || '';
    const remark   = leadData.remark || '';
    const status   = leadData.status || 'Lead';

    const C  = config.SHEET_COLUMNS;
    const CL = config.COLUMN_LETTERS;
    const totalCols = C.PIPELINE_STAGE + 1;  // 19 columns (0-18)
    const rowData = new Array(totalCols).fill('');

    rowData[C.CGID]      = '=ROW()-1+230000';
    rowData[C.DATE]      = date;
    rowData[C.TIME]      = time;
    rowData[C.NAME]      = name;
    rowData[C.NUMBER]    = phone;
    rowData[C.LOCATION]  = location;
    rowData[C.INQUIRY]   = inquiry;
    rowData[C.PRODUCT]   = product;
    rowData[C.MESSAGE]   = message;
    rowData[C.SOURCE]    = source;
    rowData[C.TEAM]      = team;
    rowData[C.STATUS]    = status;
    rowData[C.REMARK]    = remark;
    rowData[C.DAY]       = `=IFERROR(WEEKDAY($${CL.DATE}${nextRow},2)&TEXT($${CL.DATE}${nextRow},"dddd"), "")`;
    rowData[C.HOURS]     = `=IFERROR(HOUR($${CL.TIME}${nextRow}), "")`;
    rowData[C.CONVERTED] = `=SWITCH(${CL.STATUS}${nextRow},"Admission Done",1,"Seat Booked",1,0)`;

    await api.spreadsheets.values.append({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!A:S`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });

    console.log(`[Sheet] Appended row ${nextRow} for ${getLastTenDigits(phone)}`);
    return { row: nextRow, action: 'created' };
  }
}


// ═════════════════════════════════════════════════════════════
//  UPDATE CONTACT CELLS — targeted update on a known row
//
//  Use when you already know the row number and want to update
//  specific fields. Keys are SHEET_COLUMNS indices (0-based).
//
//  @param {number} row    - Sheet row number
//  @param {Object} fields - { [config.SHEET_COLUMNS.STATUS]: 'X', ... }
// ═════════════════════════════════════════════════════════════
async function updateContactCells(row, fields) {
  if (!row) throw new Error('updateContactCells: row is required');

  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;

  const updates = [];
  for (const [colIdx, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const letter = config.colLetter(parseInt(colIdx));
    updates.push({
      range: `${sheetName}!${letter}${row}`,
      values: [[value]]
    });
  }

  if (updates.length > 0) {
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: config.SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: updates }
    });
    console.log(`[Sheet] Updated ${updates.length} cell(s) on row ${row}`);
  }
}


// ═════════════════════════════════════════════════════════════
//  FIND BY PHONE — Sheet-only phone scan
//  Scans Sheet5 for a matching phone number.
//  NO Firestore lookup — handler does that separately.
//
//  @returns {{ row: number, data: string[] }} or null
// ═════════════════════════════════════════════════════════════
async function findByPhone(phoneNumber) {
  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;

  const response = await api.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A2:S`
  });

  const rows = response.data.values || [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const registeredNum = row[config.SHEET_COLUMNS.NUMBER] || '';
    if (phoneNumbersMatch(phoneNumber, registeredNum)) {
      return { row: i + 2, data: row };
    }
  }

  return null;
}


// ═════════════════════════════════════════════════════════════
//  CHECK FIREBASE WHITELIST (unchanged — different sheet)
// ═════════════════════════════════════════════════════════════
async function checkFirebaseWhitelist(phoneNumber) {
  const api = await getSheets();
  const sheetName = config.SHEETS.FIREBASE_WHITELIST;

  try {
    const response = await api.spreadsheets.values.get({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!E:F`
    });

    const rows = response.data.values || [];
    const last10 = getLastTenDigits(phoneNumber);

    for (const row of rows) {
      const mainNumber = String(row[0] || '').trim();
      const regiNumber = String(row[1] || '').trim();

      if (mainNumber && getLastTenDigits(mainNumber) === last10) {
        const registeredNumber = regiNumber || mainNumber;
        console.log(`Whitelist match found for ${phoneNumber}, registered number: ${registeredNumber}`);
        return registeredNumber;
      }
    }

    console.log(`No whitelist match for ${phoneNumber}`);
    return null;
  } catch (error) {
    console.error(`checkFirebaseWhitelist error: ${error.message}`);
    return null;
  }
}


// ═════════════════════════════════════════════════════════════
//  UPDATE ATTENDANCE (unchanged — different sheet)
// ═════════════════════════════════════════════════════════════
async function updateAttendance(phoneNumber, name, loginTimestamp) {
  const api = await getSheets();
  const sheetName = config.SHEETS.FIREBASE_WHITELIST;

  try {
    const searchResponse = await api.spreadsheets.values.get({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!E2:F`
    });

    const searchRows = searchResponse.data.values || [];
    let foundRow = null;
    let fullRowData = null;

    for (let i = 0; i < searchRows.length; i++) {
      const numberCol = searchRows[i][0] || '';
      const regiCol   = searchRows[i][1] || '';

      if (phoneNumbersMatch(phoneNumber, numberCol) || phoneNumbersMatch(phoneNumber, regiCol)) {
        foundRow = i + 2;
        const fullRowResponse = await api.spreadsheets.values.get({
          spreadsheetId: config.SPREADSHEET_ID,
          range: `${sheetName}!A${foundRow}:L${foundRow}`
        });
        fullRowData = fullRowResponse.data.values?.[0] || [];
        break;
      }
    }

    const loginDate = new Date(loginTimestamp);
    const formattedTime = loginDate.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit'
    });

    const buildAttendance = (current) =>
      current ? `${current} | ${formattedTime}` : `Present ${formattedTime}`;

    if (foundRow) {
      // NOTE: These indices are for the OnlineAttendence sheet layout,
      // NOT the DSR sheet. Do not use config.SHEET_COLUMNS here.
      const currentAttendance = fullRowData[11] || '';  // OnlineAttendence column L
      const updatedAttendance = buildAttendance(currentAttendance);

      await api.spreadsheets.values.update({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${sheetName}!L${foundRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[updatedAttendance]] }
      });

      return {
        found: true, action: 'updated', row: foundRow,
        name: fullRowData[3] || name, attendance: updatedAttendance,
        message: 'Attendance marked as Present'
      };

    } else {
      const allRowsResponse = await api.spreadsheets.values.get({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${sheetName}!A2:A`
      });
      const existingRows = allRowsResponse.data.values || [];
      const nextRow = existingRows.length + 2;

      const now = new Date();
      const currentDate = formatDate(now);
      const currentTime = now.toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      const attendanceValue = buildAttendance('');

      const newRowData = [
        '=ROW()-1', currentDate, currentTime, name,
        phoneNumber, phoneNumber, '', 'CGI', '', '', '', attendanceValue
      ];

      await api.spreadsheets.values.append({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${sheetName}!A:L`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [newRowData] }
      });

      return {
        found: false, action: 'created', row: nextRow,
        name, attendance: attendanceValue,
        message: 'New entry created with attendance marked'
      };
    }

  } catch (error) {
    console.error(`updateAttendance error: ${error.message}`);
    throw error;
  }
}


module.exports = {
  upsertContact,
  updateContactCells,
  findByPhone,
  checkFirebaseWhitelist,
  updateAttendance,
};
