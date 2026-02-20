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
  fn().catch(err => console.error(`[Firestore parallel] ${err.message}`));
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
        range: `${sheetName}!N${existingContact.row}`,
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

  const rowData = Array(24).fill('');
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
      range: `${sheetName}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] }
    });
    console.log(`New contact appended at row ${nextRow}`);
  } catch (error) {
    console.error('Append error:', error.message);
    throw error;
  }

  // ── Firestore parallel: create new lead ──
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
        range: `${sheetName}!N${existingContact.row}`,
        values: [[newRemark]]
      });
    }

    if (updates.length > 0) {
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: config.SPREADSHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: updates }
      });
    }

    // ── Firestore parallel: update existing ──
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
    range: `${sheetName}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowData] }
  });
  
  console.log(`Manual inquiry appended at row ${nextRow}`);

  // ── Firestore parallel: create new lead ──
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

  return { message: 'Manual inquiry created', row: nextRow };
}


// ═════════════════════════════════════════════════════════════
//  UPDATE FORM DATA (WhatsApp flow form submission)
// ═════════════════════════════════════════════════════════════
async function updateFormData(params) {
  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;
  
  const waId = params.wa_num || '';
  const option = params.option || '';
  const formNum = params.form_num || '';
  const name = params.name || '';

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
  const statusValue = option === "Offline (અમદાવાદ ક્લાસ માં)" ? "Ahm MC Link Sent" : "Online MC Link Sent";

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

  console.log(`Form data updated: name=${name}, formNum=${formNum}, status=${statusValue}`);

  // ── Firestore parallel: update form data ──
  fireAndForgetFirestore(() => FirestoreService.updateLead(waId, {
    name:   name,
    regiNo: formNum,
    status: statusValue
  }, {
    action:  'form_submitted',
    by:      'system',
    details: { formNum, option, statusValue }
  }));

  return true;
}


// ═════════════════════════════════════════════════════════════
//  HANDLE COMMUNITY JOIN
// ═════════════════════════════════════════════════════════════
async function handleCommunityJoin(params) {
  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;
  
  const phoneNumber = params.wa_num || '';
  if (!phoneNumber) throw new Error('Phone missing');

  const response = await api.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A2:Z`
  });

  const rows = response.data.values || [];
  const matchingRowIndex = rows.findIndex(row => 
    getLastTenDigits(row[config.SHEET_COLUMNS.NUMBER]?.toString() || '') === getLastTenDigits(phoneNumber)
  );

  if (matchingRowIndex === -1) return { message: 'Phone not found' };

  const targetRow = matchingRowIndex + 2;
  const currentStatus = rows[matchingRowIndex][config.SHEET_COLUMNS.STATUS] || '';
  const currentTeam   = rows[matchingRowIndex][config.SHEET_COLUMNS.TEAM]   || '';

  const isOnline = currentStatus.includes('Online');
  const statusValue = isOnline ? 'Online MC GrpJoined' : 'Ahm MC GrpJoined';

  const updates = [{ range: `${sheetName}!L${targetRow}`, values: [[statusValue]] }];

  if (currentTeam === 'Not Assigned') {
    updates.push({ range: `${sheetName}!K${targetRow}`, values: [['ROBO']] });
  }

  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: config.SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: updates }
  });

  console.log(`Community join tracked: ${phoneNumber}, status=${statusValue}`);

  // ── Firestore parallel: update status ──
  const firestoreUpdates = { status: statusValue };
  if (currentTeam === 'Not Assigned') {
    firestoreUpdates.agent = 'ROBO';
    firestoreUpdates.stage = 'ROBO';
  }
  fireAndForgetFirestore(() => FirestoreService.updateLead(phoneNumber, firestoreUpdates, {
    action:  'community_joined',
    by:      'system',
    details: { statusValue, groupType: isOnline ? 'online' : 'ahmedabad' }
  }));

  return { message: 'Click tracked', row: targetRow };
}


// ═════════════════════════════════════════════════════════════
//  FIND USER BY PHONE NUMBER (unchanged — still Sheet-based)
//  Phase 2 will swap this to Firestore lookup
// ═════════════════════════════════════════════════════════════
async function findUserByPhoneNumber(phoneNumber) {
  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;
  const response = await api.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A2:Z`
  });

  const rows = response.data.values || [];
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const registeredNum = row[config.SHEET_COLUMNS.NUMBER]  || '';
    const otherNum      = row[config.SHEET_COLUMNS.REGI_NO] || '';

    if (phoneNumbersMatch(phoneNumber, registeredNum) || phoneNumbersMatch(phoneNumber, otherNum)) {
      return { row: i + 2, data: row };
    }
  }

  return null;
}


// ═════════════════════════════════════════════════════════════
//  CHECK FIREBASE WHITELIST (unchanged)
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
//  UPDATE ATTENDANCE (unchanged)
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
    const formattedDate = formatDate(loginDate);
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
      console.log(`Found user at row ${foundRow}, updating attendance`);

      const currentAttendance = fullRowData[11] || '';
      const updatedAttendance = buildAttendance(currentAttendance);

      await api.spreadsheets.values.update({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${sheetName}!L${foundRow}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[updatedAttendance]]
        }
      });

      console.log(`Attendance updated for ${phoneNumber} at row ${foundRow}`);

      return {
        found: true,
        action: 'updated',
        row: foundRow,
        name: fullRowData[3] || name,
        attendance: updatedAttendance,
        message: 'Attendance marked as Present'
      };

    } else {
      console.log(`User not found, creating new entry for ${phoneNumber}`);

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
        requestBody: {
          values: [newRowData]
        }
      });

      console.log(`New entry created for ${phoneNumber} at row ${nextRow}`);

      return {
        found: false,
        action: 'created',
        row: nextRow,
        name: name,
        attendance: attendanceValue,
        message: 'New entry created with attendance marked'
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
