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
    const updates = [];
    const C = config.SHEET_COLUMNS;

    if (leadData.message) {
      const current = existing.data[C.MESSAGE] || '';
      const merged = current ? `${current} | ${leadData.message}` : leadData.message;
      updates.push({ range: `${sheetName}!I${existing.row}`, values: [[merged]] });
    }
    if (leadData.remark) {
      const current = existing.data[C.REMARK] || '';
      const merged = current ? `${current} | ${leadData.remark}` : leadData.remark;
      updates.push({ range: `${sheetName}!O${existing.row}`, values: [[merged]] });
    }
    // Fill in blanks (don't overwrite existing values)
    if (leadData.name && !existing.data[C.NAME]) {
      updates.push({ range: `${sheetName}!D${existing.row}`, values: [[leadData.name]] });
    }
    if (leadData.location && !existing.data[C.LOCATION]) {
      updates.push({ range: `${sheetName}!G${existing.row}`, values: [[leadData.location]] });
    }
    if (leadData.source && !existing.data[C.SOURCE]) {
      updates.push({ range: `${sheetName}!J${existing.row}`, values: [[leadData.source]] });
    }

    if (updates.length > 0) {
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: config.SPREADSHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: updates }
      });
      console.log(`[Sheet] Updated row ${existing.row} for ${getLastTenDigits(phone)}`);
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
    const product  = leadData.product || 'CGI';
    const source   = leadData.source || '';
    const team     = leadData.team || leadData.agent || 'Not Assigned';
    const message  = leadData.message || '';
    const remark   = leadData.remark || '';
    const status   = leadData.status || 'Lead';

    const rowData = [
      '=ROW()-1+230000',                                                     // A: CGILN
      date,                                                                  // B: DATE
      time,                                                                  // C: TIME
      name,                                                                  // D: NAME
      phone,                                                                 // E: NUMBER
      '',                                                                    // F: REGI_NO
      location,                                                              // G: LOCATION
      product,                                                               // H: PRODUCT
      message,                                                               // I: MESSAGE
      source,                                                                // J: SOURCE
      team,                                                                  // K: TEAM
      status,                                                                // L: STATUS
      '',                                                                    // M: RATING
      '',                                                                    // N: ACTION/CB_DATE
      remark,                                                                // O: REMARK
      '',                                                                    // P: TEAM_2
      '',                                                                    // Q: STATUS_2
      '',                                                                    // R: REMARK_2
      '',                                                                    // S: CONF_CB_PRIORITY
      '',                                                                    // T: CONFIRMATION
      '',                                                                    // U: JOIN_POLL
      '',                                                                    // V: NO_WITHOUT_91
      `=IFERROR(WEEKDAY($B${nextRow},2)&TEXT($B${nextRow},"dddd"), "")`,     // W: DAY
      `=IFERROR(HOUR($C${nextRow}), "")`,                                    // X: HOURS
      `=SWITCH(L${nextRow},"Admission Done",1,"Seat Booked",1,0)`,           // Y: CONVERTED
      '',                                                                    // Z: ATTENDANCE
      ''                                                                     // AA: INTERACTION
    ];

    await api.spreadsheets.values.append({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!A:Z`,
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
//  specific fields. For example: community join sets status on
//  a known row, form submission updates name + regiNo + status.
//
//  @param {number} row   - Sheet row number
//  @param {Object} fields - { status: 'X', team: 'Y', ... }
// ═════════════════════════════════════════════════════════════
async function updateContactCells(row, fields) {
  if (!row) throw new Error('updateContactCells: row is required');

  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;

  // Map field names to Sheet column letters
  const FIELD_TO_COL = {
    name:      'D',
    regiNo:    'F',
    location:  'G',
    product:   'H',
    message:   'I',
    source:    'J',
    team:      'K',
    status:    'L',
    rating:    'M',
    remark:    'O',
    team_2:    'P',
    status_2:  'Q',
    remark_2:  'R',
  };

  const updates = [];
  for (const [field, value] of Object.entries(fields)) {
    const col = FIELD_TO_COL[field];
    if (col && value !== undefined) {
      updates.push({ range: `${sheetName}!${col}${row}`, values: [[value]] });
    }
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
//  UPDATE FORM DATA — WhatsApp flow form submission
//  Sets name, regiNo (form_num), and status on the matching row.
//  NO Firestore calls — handler does that separately.
// ═════════════════════════════════════════════════════════════
async function updateFormData(params) {
  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;

  const waId    = params.wa_num || '';
  const option  = params.option || '';
  const formNum = params.form_num || '';
  const name    = params.name || '';

  if (!waId) throw new Error('wa_num is missing');

  const response = await api.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A2:Z`
  });

  const rows = response.data.values || [];
  const matchingRowIndex = rows.findIndex(row =>
    row[config.SHEET_COLUMNS.NUMBER]?.toString() === waId.toString()
  );

  if (matchingRowIndex === -1) throw new Error('No match found');

  const targetRow = matchingRowIndex + 2;
  const statusValue = option === "Offline (અમદાવાદ ક્લાસ માં)"
    ? "Ahm MC Link Sent"
    : "Online MC Link Sent";

  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: config.SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${sheetName}!D${targetRow}`, values: [[name]] },
        { range: `${sheetName}!F${targetRow}`, values: [[formNum]] },
        { range: `${sheetName}!L${targetRow}`, values: [[statusValue]] }
      ]
    }
  });

  console.log(`[Sheet] Form data updated row ${targetRow}: name=${name}, regiNo=${formNum}, status=${statusValue}`);
  return { row: targetRow, statusValue };
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
    range: `${sheetName}!A2:Z`
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
      const currentAttendance = fullRowData[11] || '';
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
  updateFormData,
  findByPhone,
  checkFirebaseWhitelist,
  updateAttendance,
};
