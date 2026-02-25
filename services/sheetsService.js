// ============================================================================
//  sheetsService.js — Google Sheets CRUD + Firestore parallel writes
//
//  PATTERN:
//  - Sheet write is primary (must succeed)
//  - Firestore write is fire-and-forget (non-blocking)
//  - Firestore uses auto-ID with cgId business reference
// ============================================================================

const { google } = require('googleapis');
const config = require('../config');
const { formatDate, getLastTenDigits, phoneNumbersMatch } = require('../utils/helpers');
const FirestoreService = require('./firestoreService');

let sheets;

async function getSheets() {
  if (!sheets) {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheets = google.sheets({ version: 'v4', auth });
    console.log('Google Sheets API initialized successfully');
  }
  return sheets;
}


// ─────────────────────────────────────────────────────────────
//  Helper: Fire-and-forget Firestore write (non-blocking)
//  Logs errors but never throws — Sheet operations are unaffected
// ─────────────────────────────────────────────────────────────
function fireAndForgetFirestore(fn) {
  if (!config.FIRESTORE.ENABLED) return;
  
  fn()
    .then(result => {
      if (result && result.cgId) {
        console.log(`[Firestore parallel] Success: ${result.cgId}`);
      }
    })
    .catch(err => {
      console.error(`[Firestore parallel] ${err.message}`);
    });
}


// ═════════════════════════════════════════════════════════════
//  INSERT NEW CONTACT (auto — from webhook)
// ═════════════════════════════════════════════════════════════
async function insertNewContact(params) {
  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;
  
  const senderName = params.senderName || '';
  const waId = params.waId || '';
  const sourceUrl = params.sourceUrl || '';
  const remark = params.remark || '';
  const messageText = params.text || params.msg || '';
  const team = params.team || 'Not Assigned';
  const source = params.source || 
               (sourceUrl && sourceUrl.includes("instagram.com") ? "Insta" :
                sourceUrl && sourceUrl.includes("fb.me") ? "FB" :
                "WhatsApp");
  const location = params.location || '';

  const existingContact = await findUserByPhoneNumber(waId);
  
  if (existingContact) {
    console.log(`Contact ${waId} exists at row ${existingContact.row}`);

    const updates = [];

    if (messageText) {
      const currentMsg = existingContact.data[config.SHEET_COLUMNS.MESSAGE] || '';
      const newMsg = currentMsg ? `${currentMsg} | ${messageText}` : messageText;
      updates.push({
        range: `${sheetName}!I${existingContact.row}`,
        values: [[newMsg]]
      });
    }

    if (remark) {
      const currentRemark = existingContact.data[config.SHEET_COLUMNS.REMARK] || '';
      const newRemark = currentRemark ? `${currentRemark} | ${remark}` : remark;
      updates.push({
        range: `${sheetName}!O${existingContact.row}`,
        values: [[newRemark]]
      });
    }

    if (updates.length > 0) {
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: config.SPREADSHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: updates }
      });
    }

    // ── Firestore parallel: update existing lead ──
    fireAndForgetFirestore(() => FirestoreService.createOrUpdateLead({
      phone: waId,
      name: senderName,
      message: messageText,
      remark: remark,
      source: source,
      location: location
    }, {
      action: 'contact_updated',
      by: 'system',
      details: { source, trigger: 'duplicate_webhook' }
    }));

    return { message: 'Existing contact updated', row: existingContact.row };
  }

  // ── New contact: write to Sheet ──
  const response = await api.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A2:Z`
  });
  
  const rows = response.data.values || [];
  const nextRow = rows.length + 2;

  const now = new Date();
  const date = formatDate(now);
  const options = { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' };
  const timeOnly = new Intl.DateTimeFormat('en-IN', options).format(now);

  const rowData = Array(27).fill('');
  rowData[config.SHEET_COLUMNS.CGILN]     = '=ROW()-1+230000';
  rowData[config.SHEET_COLUMNS.DATE]      = date;
  rowData[config.SHEET_COLUMNS.TIME]      = timeOnly;
  rowData[config.SHEET_COLUMNS.NAME]      = senderName;
  rowData[config.SHEET_COLUMNS.NUMBER]    = waId;
  rowData[config.SHEET_COLUMNS.LOCATION]  = location;
  rowData[config.SHEET_COLUMNS.PRODUCT]   = 'CGI';
  rowData[config.SHEET_COLUMNS.MESSAGE]   = messageText;
  rowData[config.SHEET_COLUMNS.SOURCE]    = source;
  rowData[config.SHEET_COLUMNS.TEAM]      = team;
  rowData[config.SHEET_COLUMNS.STATUS]    = 'Lead';
  rowData[config.SHEET_COLUMNS.DAY]       = `=IFERROR(WEEKDAY($B${nextRow},2)&TEXT($B${nextRow},"dddd"), "")`;
  rowData[config.SHEET_COLUMNS.HOURS]     = `=IFERROR(HOUR($C${nextRow}), "")`;
  rowData[config.SHEET_COLUMNS.CONVERTED] = `=SWITCH(L${nextRow},"Admission Done",1,"Seat Booked",1,0)`;
  if (remark) rowData[config.SHEET_COLUMNS.REMARK] = remark;

  try {
    await api.spreadsheets.values.append({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!A:AA`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });
    console.log(`New contact appended at row ${nextRow}`);
  } catch (error) {
    console.error('Append error:', error.message);
    throw error;
  }

  // ── Firestore parallel: create new lead (with auto cgId) ──
  fireAndForgetFirestore(() => FirestoreService.createLead({
    phone:    waId,
    name:     senderName,
    location: location,
    product:  'CGI',
    source:   source,
    message:  messageText,
    remark:   remark,
    team:     team,
    status:   'Lead',
    sheetRow: nextRow,
    channel:  'webhook'
  }));

  return { message: 'New contact created', row: nextRow };
}


// ═════════════════════════════════════════════════════════════
//  INSERT NEW CONTACT MANUAL (from Apps Script form)
// ═════════════════════════════════════════════════════════════
async function insertNewContactManual(params) {
  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;
  
  const senderName = params.senderName || '';
  const waId = params.waId || '';
  const location = params.location || '';
  const product = params.product || 'CGI';
  const source = params.source || 'Manual Entry';
  const team = params.team || 'Not Assigned';
  const remark = params.remark || '';

  const existingContact = await findUserByPhoneNumber(waId);
  
  if (existingContact) {
    console.log(`Contact ${waId} exists at row ${existingContact.row}`);

    const updates = [];

    if (remark) {
      const currentRemark = existingContact.data[config.SHEET_COLUMNS.REMARK] || '';
      const newRemark = currentRemark ? `${currentRemark} | ${remark}` : remark;
      updates.push({
        range: `${sheetName}!O${existingContact.row}`,
        values: [[newRemark]]
      });
    }

    if (updates.length > 0) {
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: config.SPREADSHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: updates }
      });
    }

    // ── Firestore parallel ──
    fireAndForgetFirestore(() => FirestoreService.createOrUpdateLead({
      phone: waId,
      name: senderName,
      remark: remark,
      source: source,
      location: location
    }, {
      action: 'contact_updated',
      by: 'system',
      details: { source, trigger: 'manual_duplicate' }
    }));

    return { message: 'Existing contact updated', row: existingContact.row };
  }

  // ── New contact ──
  const response = await api.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A2:Z`
  });
  
  const rows = response.data.values || [];
  const nextRow = rows.length + 2;

  const now = new Date();
  const date = formatDate(now);
  const options = { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' };
  const timeOnly = new Intl.DateTimeFormat('en-IN', options).format(now);

  const rowData = [
    '=ROW()-1+230000',  // CGILN (0)
    date,               // DATE (1)
    timeOnly,           // TIME (2)
    senderName,         // NAME (3)
    waId,               // NUMBER (4)
    '',                 // REGI_NO (5)
    location,           // LOCATION (6)
    product,            // PRODUCT (7)
    '',                 // MESSAGE (8)
    source,             // SOURCE (9)
    team,               // TEAM (10)
    'Lead',             // STATUS (11)
    '',                 // RATING (12)
    '',                 // CB Date (13)
    remark,             // REMARK (14)
    '',                 // TEAM_2 (15)
    '',                 // STATUS_2 (16)
    '',                 // REMARK_2 (17)
    '',                 // CONF_CB_PRIORITY (18)
    '',                 // CONFIRMATION (19)
    '',                 // JOIN_POLL (20)
    '',                 // NO_WITHOUT_91 (21)
    `=IFERROR(WEEKDAY($B${nextRow},2)&TEXT($B${nextRow},"dddd"), "")`,  // DAY (22)
    `=IFERROR(HOUR($C${nextRow}), "")`,                                  // HOURS (23)
    `=SWITCH(L${nextRow},"Admission Done",1,"Seat Booked",1,0)`,        // CONVERTED (24)
    '',                 // ATTENDANCE (25)
    ''                  // INTERACTION (26)
  ];

  await api.spreadsheets.values.append({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A:AA`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowData] }
  });
  
  console.log(`Manual inquiry appended at row ${nextRow}`);

  // ── Firestore parallel (with auto cgId) ──
  fireAndForgetFirestore(() => FirestoreService.createLead({
    phone:    waId,
    name:     senderName,
    location: location,
    product:  product,
    source:   source,
    remark:   remark,
    team:     team,
    status:   'Lead',
    sheetRow: nextRow,
    channel:  'manual_entry'
  }));

  return { message: 'Manual entry created', row: nextRow };
}


// ═════════════════════════════════════════════════════════════
//  FIND USER BY PHONE NUMBER
// ═════════════════════════════════════════════════════════════
async function findUserByPhoneNumber(phoneNumber) {
  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;

  const response = await api.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A2:AA`
  });

  const rows = response.data.values || [];
  const searchPhone = getLastTenDigits(phoneNumber);

  for (let i = 0; i < rows.length; i++) {
    const rowPhone = rows[i][config.SHEET_COLUMNS.NUMBER] || '';
    if (phoneNumbersMatch(rowPhone, searchPhone)) {
      return { row: i + 2, data: rows[i] };
    }
  }

  return null;
}


// ═════════════════════════════════════════════════════════════
//  UPDATE FORM DATA
// ═════════════════════════════════════════════════════════════
async function updateFormData(params) {
  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;

  const phoneNumber = params.form_num || params.wa_num;
  const userMatch = await findUserByPhoneNumber(phoneNumber);

  if (!userMatch) {
    throw new Error('No match found');
  }

  const updates = [];
  const rowNum = userMatch.row;

  // Name
  if (params.name) {
    updates.push({
      range: `${sheetName}!D${rowNum}`,
      values: [[params.name]]
    });
  }

  // Registration number
  if (params.form_num) {
    updates.push({
      range: `${sheetName}!F${rowNum}`,
      values: [[params.form_num]]
    });
  }

  // Product/Option
  if (params.option) {
    const currentProduct = userMatch.data[config.SHEET_COLUMNS.PRODUCT] || '';
    const newProduct = currentProduct 
      ? `${currentProduct}, ${params.option}` 
      : params.option;
    updates.push({
      range: `${sheetName}!H${rowNum}`,
      values: [[newProduct]]
    });
  }

  if (updates.length > 0) {
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: config.SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: updates }
    });
  }

  // ── Firestore parallel ──
  fireAndForgetFirestore(() => FirestoreService.updateLead(phoneNumber, {
    name: params.name || '',
    regiNo: params.form_num || '',
    product: params.option || ''
  }, {
    action: 'form_submitted',
    by: 'customer',
    details: { form: 'whatsapp_flow' }
  }));

  return { message: 'Form data updated', row: rowNum };
}


// ═════════════════════════════════════════════════════════════
//  CHECK FIREBASE WHITELIST (from OnlineAttendence sheet)
// ═════════════════════════════════════════════════════════════
async function checkFirebaseWhitelist(phoneNumber) {
  const api = await getSheets();
  const sheetName = config.SHEETS.FIREBASE_WHITELIST;

  try {
    const response = await api.spreadsheets.values.get({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!A:F`
    });

    const rows = response.data.values || [];
    const searchPhone = getLastTenDigits(phoneNumber);

    for (const row of rows) {
      // Check columns that might contain phone numbers
      for (let col = 0; col < row.length; col++) {
        const cellValue = row[col] || '';
        if (phoneNumbersMatch(cellValue, searchPhone)) {
          // Return the registered number (usually in column E or F)
          return row[4] || row[5] || cellValue;
        }
      }
    }

    return null;
  } catch (error) {
    console.error(`checkFirebaseWhitelist error: ${error.message}`);
    return null;
  }
}


// ═════════════════════════════════════════════════════════════
//  HANDLE COMMUNITY JOIN
// ═════════════════════════════════════════════════════════════
async function handleCommunityJoin(params) {
  const phoneNumber = params.waId || params.phone;
  const userMatch = await findUserByPhoneNumber(phoneNumber);

  if (!userMatch) {
    console.log(`Community join: ${phoneNumber} not found in sheet`);
    return { message: 'User not found' };
  }

  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;

  await api.spreadsheets.values.update({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!U${userMatch.row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Joined']] }
  });

  // ── Firestore parallel ──
  fireAndForgetFirestore(() => FirestoreService.addHistory(
    phoneNumber, 
    'community_joined', 
    'system',
    { group: params.groupName || 'unknown' }
  ));

  return { message: 'Community join recorded', row: userMatch.row };
}


// ═════════════════════════════════════════════════════════════
//  UPDATE ATTENDANCE
// ═════════════════════════════════════════════════════════════
async function updateAttendance(phoneNumber, name, loginTimestamp) {
  const api = await getSheets();
  const sheetName = config.SHEETS.FIREBASE_WHITELIST;

  try {
    const response = await api.spreadsheets.values.get({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!A2:L`
    });

    const rows = response.data.values || [];
    const searchPhone = getLastTenDigits(phoneNumber);

    let foundRow = null;
    let fullRowData = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      for (let col = 0; col < Math.min(row.length, 6); col++) {
        if (phoneNumbersMatch(row[col] || '', searchPhone)) {
          foundRow = i + 2;
          fullRowData = row;
          break;
        }
      }
      if (foundRow) break;
    }

    const loginDate = new Date(loginTimestamp);
    const formattedTime = loginDate.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });

    const buildAttendance = (currentAttendance) => {
      return currentAttendance 
        ? `${currentAttendance} | ${formattedTime}`
        : `Present ${formattedTime}`;
    };

    if (foundRow) {
      const currentAttendance = fullRowData[11] || '';
      const updatedAttendance = buildAttendance(currentAttendance);

      await api.spreadsheets.values.update({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${sheetName}!L${foundRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[updatedAttendance]] }
      });

      // ── Firestore parallel ──
      fireAndForgetFirestore(() => FirestoreService.addHistory(
        phoneNumber,
        'attendance_marked',
        'system',
        { time: formattedTime, timestamp: loginTimestamp }
      ));

      return {
        found: true,
        action: 'updated',
        row: foundRow,
        attendance: updatedAttendance
      };

    } else {
      // Create new entry
      const allRowsResponse = await api.spreadsheets.values.get({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${sheetName}!A2:A`
      });
      const existingRows = allRowsResponse.data.values || [];
      const nextRow = existingRows.length + 2;

      const now = new Date();
      const currentDate = formatDate(now);
      const currentTime = now.toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      const attendanceValue = buildAttendance('');

      const newRowData = [
        `=ROW()-1`,
        currentDate,
        currentTime,
        name,
        phoneNumber,
        phoneNumber,
        '',
        'CGI',
        '',
        '',
        '',
        attendanceValue
      ];

      await api.spreadsheets.values.append({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${sheetName}!A:L`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [newRowData] }
      });

      return {
        found: false,
        action: 'created',
        row: nextRow,
        attendance: attendanceValue
      };
    }

  } catch (error) {
    console.error(`updateAttendance error: ${error.message}`);
    throw error;
  }
}


module.exports = {
  insertNewContact,
  insertNewContactManual,
  updateFormData,
  handleCommunityJoin,
  findUserByPhoneNumber,
  checkFirebaseWhitelist,
  updateAttendance
};