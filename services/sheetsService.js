// ============================================================================
//  services/sheetsService.js — Google Sheets CRUD
//
//  All Sheet operations. Uses centralized helpers.
//  Includes fire-and-forget Firestore parallel writes.
// ============================================================================

const { google } = require('googleapis');
const config = require('../config');
const { 
  formatDate, 
  formatTimeIST,
  formatTimeShortIST,
  getLastTenDigits, 
  phoneNumbersMatch,
  detectSource,
  cleanString,
  buildAttendanceString
} = require('../utils/helpers');
const FirestoreService = require('./firestoreService');

const LOG_PREFIX = '[Sheets]';

let sheets;


// ═══════════════════════════════════════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

async function getSheets() {
  if (!sheets) {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheets = google.sheets({ version: 'v4', auth });
    console.log(`${LOG_PREFIX} API initialized`);
  }
  return sheets;
}


// ═══════════════════════════════════════════════════════════════════════════
//  FIRESTORE HELPER (fire-and-forget)
// ═══════════════════════════════════════════════════════════════════════════

function fireAndForgetFirestore(fn) {
  if (!config.FIRESTORE.ENABLED) return;
  
  fn()
    .then(r => r?.cgId && console.log(`${LOG_PREFIX} [Firestore] ${r.cgId}`))
    .catch(e => console.error(`${LOG_PREFIX} [Firestore] ${e.message}`));
}


// ═══════════════════════════════════════════════════════════════════════════
//  FIND USER
// ═══════════════════════════════════════════════════════════════════════════

async function findUserByPhoneNumber(phoneNumber) {
  const api = await getSheets();
  const response = await api.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${config.SHEETS.DSR}!A2:AA`
  });

  const rows = response.data.values || [];
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const registeredNum = row[config.SHEET_COLUMNS.NUMBER] || '';
    const otherNum = row[config.SHEET_COLUMNS.REGI_NO] || '';

    if (phoneNumbersMatch(phoneNumber, registeredNum) || phoneNumbersMatch(phoneNumber, otherNum)) {
      return { row: i + 2, data: row };
    }
  }
  return null;
}


// ═══════════════════════════════════════════════════════════════════════════
//  INSERT CONTACT (webhook)
// ═══════════════════════════════════════════════════════════════════════════

async function insertNewContact(params) {
  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;
  
  const senderName = cleanString(params.senderName);
  const waId = cleanString(params.waId);
  const sourceUrl = params.sourceUrl || '';
  const remark = cleanString(params.remark);
  const messageText = cleanString(params.text || params.msg);
  const team = params.team || config.DEFAULTS.TEAM;
  const source = params.source || detectSource(sourceUrl);
  const location = cleanString(params.location);

  const existingContact = await findUserByPhoneNumber(waId);
  
  if (existingContact) {
    console.log(`${LOG_PREFIX} Contact exists at row ${existingContact.row}`);

    const updates = [];
    if (messageText) {
      const currentMsg = existingContact.data[config.SHEET_COLUMNS.MESSAGE] || '';
      updates.push({
        range: `${sheetName}!I${existingContact.row}`,
        values: [[currentMsg ? `${currentMsg} | ${messageText}` : messageText]]
      });
    }
    if (remark) {
      const currentRemark = existingContact.data[config.SHEET_COLUMNS.REMARK] || '';
      updates.push({
        range: `${sheetName}!O${existingContact.row}`,
        values: [[currentRemark ? `${currentRemark} | ${remark}` : remark]]
      });
    }

    if (updates.length > 0) {
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: config.SPREADSHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: updates }
      });
    }

    fireAndForgetFirestore(() => FirestoreService.createOrUpdateLead({
      phone: waId, name: senderName, message: messageText, remark, source, location
    }, { action: 'contact_updated', by: 'system', details: { source, trigger: 'duplicate_webhook' } }));

    return { message: 'Existing contact updated', row: existingContact.row };
  }

  // New contact
  const response = await api.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A2:Z`
  });
  
  const rows = response.data.values || [];
  const nextRow = rows.length + 2;
  const now = new Date();

  const rowData = Array(27).fill('');
  rowData[config.SHEET_COLUMNS.CGILN] = '=ROW()-1+230000';
  rowData[config.SHEET_COLUMNS.DATE] = formatDate(now);
  rowData[config.SHEET_COLUMNS.TIME] = formatTimeIST(now);
  rowData[config.SHEET_COLUMNS.NAME] = senderName;
  rowData[config.SHEET_COLUMNS.NUMBER] = waId;
  rowData[config.SHEET_COLUMNS.LOCATION] = location;
  rowData[config.SHEET_COLUMNS.PRODUCT] = config.DEFAULTS.PRODUCT;
  rowData[config.SHEET_COLUMNS.MESSAGE] = messageText;
  rowData[config.SHEET_COLUMNS.SOURCE] = source;
  rowData[config.SHEET_COLUMNS.TEAM] = team;
  rowData[config.SHEET_COLUMNS.STATUS] = config.DEFAULTS.STATUS;
  rowData[config.SHEET_COLUMNS.DAY] = `=IFERROR(WEEKDAY($B${nextRow},2)&TEXT($B${nextRow},"dddd"), "")`;
  rowData[config.SHEET_COLUMNS.HOURS] = `=IFERROR(HOUR($C${nextRow}), "")`;
  rowData[config.SHEET_COLUMNS.CONVERTED] = `=SWITCH(L${nextRow},"Admission Done",1,"Seat Booked",1,0)`;
  if (remark) rowData[config.SHEET_COLUMNS.REMARK] = remark;

  await api.spreadsheets.values.append({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A:AA`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowData] }
  });
  
  console.log(`${LOG_PREFIX} New contact at row ${nextRow}`);

  fireAndForgetFirestore(() => FirestoreService.createLead({
    phone: waId, name: senderName, location, product: config.DEFAULTS.PRODUCT,
    source, message: messageText, remark, team, status: config.DEFAULTS.STATUS,
    sheetRow: nextRow, channel: 'webhook'
  }));

  return { message: 'New contact created', row: nextRow };
}


// ═══════════════════════════════════════════════════════════════════════════
//  INSERT CONTACT MANUAL
// ═══════════════════════════════════════════════════════════════════════════

async function insertNewContactManual(params) {
  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;
  
  const senderName = cleanString(params.senderName);
  const waId = cleanString(params.waId);
  const location = cleanString(params.location);
  const product = params.product || config.DEFAULTS.PRODUCT;
  const source = params.source || 'Manual Entry';
  const team = params.team || config.DEFAULTS.TEAM;
  const remark = cleanString(params.remark);

  const existingContact = await findUserByPhoneNumber(waId);
  if (existingContact) {
    console.log(`${LOG_PREFIX} Contact exists at row ${existingContact.row}`);

    if (remark) {
      const currentRemark = existingContact.data[config.SHEET_COLUMNS.REMARK] || '';
      await api.spreadsheets.values.update({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${sheetName}!O${existingContact.row}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[currentRemark ? `${currentRemark} | ${remark}` : remark]] }
      });
    }

    fireAndForgetFirestore(() => FirestoreService.createOrUpdateLead({
      phone: waId, name: senderName, remark, source, location
    }, { action: 'contact_updated', by: 'system', details: { source, trigger: 'manual_duplicate' } }));

    return { message: 'Existing contact updated', row: existingContact.row };
  }

  const response = await api.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A2:Z`
  });
  
  const rows = response.data.values || [];
  const nextRow = rows.length + 2;
  const now = new Date();

  const rowData = [
    '=ROW()-1+230000', formatDate(now), formatTimeIST(now), senderName, waId, '',
    location, product, '', source, team, config.DEFAULTS.STATUS, '', '', remark,
    '', '', '', '', '', '', '',
    `=IFERROR(WEEKDAY($B${nextRow},2)&TEXT($B${nextRow},"dddd"), "")`,
    `=IFERROR(HOUR($C${nextRow}), "")`,
    `=SWITCH(L${nextRow},"Admission Done",1,"Seat Booked",1,0)`,
    '', ''
  ];

  await api.spreadsheets.values.append({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A:AA`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowData] }
  });
  
  console.log(`${LOG_PREFIX} Manual entry at row ${nextRow}`);

  fireAndForgetFirestore(() => FirestoreService.createLead({
    phone: waId, name: senderName, location, product, source, remark, team,
    status: config.DEFAULTS.STATUS, sheetRow: nextRow, channel: 'manual_entry'
  }));

  return { message: 'Manual entry created', row: nextRow };
}


// ═══════════════════════════════════════════════════════════════════════════
//  FORM DATA & WHITELIST
// ═══════════════════════════════════════════════════════════════════════════

async function updateFormData(params) {
  const api = await getSheets();
  const sheetName = config.SHEETS.DSR;

  const waId = params.wa_num || '';
  const name = params.name || '';
  const formNum = params.form_num || '';
  const option = params.option || '';

  const userMatch = await findUserByPhoneNumber(waId);
  if (!userMatch) throw new Error('No match found');

  const targetRow = userMatch.row;
  const isOnline = option.toLowerCase().includes('online');
  const statusValue = isOnline ? "Online MC Link Sent" : "Ahm MC Link Sent";

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

  console.log(`${LOG_PREFIX} Form data updated row=${targetRow}`);

  fireAndForgetFirestore(() => FirestoreService.updateLead(waId, {
    name, regiNo: formNum, status: statusValue
  }, { action: 'form_submitted', by: 'system', details: { formNum, option, statusValue } }));

  return true;
}

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
        console.log(`${LOG_PREFIX} Whitelist match: ${phoneNumber}`);
        return regiNumber || mainNumber;
      }
    }

    console.log(`${LOG_PREFIX} No whitelist match: ${phoneNumber}`);
    return null;
  } catch (error) {
    console.error(`${LOG_PREFIX} checkFirebaseWhitelist error: ${error.message}`);
    return null;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  COMMUNITY JOIN
// ═══════════════════════════════════════════════════════════════════════════

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
    phoneNumbersMatch(row[config.SHEET_COLUMNS.NUMBER] || '', phoneNumber)
  );

  if (matchingRowIndex === -1) return { message: 'Phone not found' };

  const targetRow = matchingRowIndex + 2;
  const currentStatus = rows[matchingRowIndex][config.SHEET_COLUMNS.STATUS] || '';
  const currentTeam = rows[matchingRowIndex][config.SHEET_COLUMNS.TEAM] || '';

  const isOnline = currentStatus.includes('Online');
  const statusValue = isOnline ? 'Online MC GrpJoined' : 'Ahm MC GrpJoined';

  const updates = [{ range: `${sheetName}!L${targetRow}`, values: [[statusValue]] }];
  if (currentTeam === config.DEFAULTS.TEAM) {
    updates.push({ range: `${sheetName}!K${targetRow}`, values: [['ROBO']] });
  }

  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: config.SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: updates }
  });

  console.log(`${LOG_PREFIX} Community join: ${phoneNumber}`);

  const firestoreUpdates = { status: statusValue };
  if (currentTeam === config.DEFAULTS.TEAM) {
    firestoreUpdates.agent = 'ROBO';
    firestoreUpdates.stage = 'ROBO';
  }
  fireAndForgetFirestore(() => FirestoreService.updateLead(phoneNumber, firestoreUpdates, {
    action: 'community_joined', by: 'system', details: { statusValue, groupType: isOnline ? 'online' : 'ahmedabad' }
  }));

  return { message: 'Click tracked', row: targetRow };
}


// ═══════════════════════════════════════════════════════════════════════════
//  ATTENDANCE
// ═══════════════════════════════════════════════════════════════════════════

async function updateAttendance(phoneNumber, name, loginTimestamp) {
  const api = await getSheets();
  const sheetName = config.SHEETS.FIREBASE_WHITELIST;

  try {
    const response = await api.spreadsheets.values.get({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!E2:L`
    });

    const rows = response.data.values || [];
    let foundRow = null;
    let fullRowData = [];

    for (let i = 0; i < rows.length; i++) {
      const numberCol = rows[i][0] || '';
      const regiCol = rows[i][1] || '';

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
    const formattedTime = formatTimeShortIST(loginDate);

    if (foundRow) {
      const currentAttendance = fullRowData[11] || '';
      const updatedAttendance = buildAttendanceString(currentAttendance, formattedTime);

      await api.spreadsheets.values.update({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${sheetName}!L${foundRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[updatedAttendance]] }
      });

      console.log(`${LOG_PREFIX} Attendance updated: ${phoneNumber} row ${foundRow}`);

      fireAndForgetFirestore(() => FirestoreService.addHistory(
        phoneNumber, 'attendance_marked', 'system', { time: formattedTime, timestamp: loginTimestamp }
      ));

      return {
        found: true, action: 'updated', row: foundRow,
        name: fullRowData[3] || name, attendance: updatedAttendance,
        message: 'Attendance marked as Present'
      };
    }

    // Create new entry
    const allRowsResponse = await api.spreadsheets.values.get({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!A2:A`
    });
    const existingRows = allRowsResponse.data.values || [];
    const nextRow = existingRows.length + 2;
    const now = new Date();
    const attendanceValue = buildAttendanceString('', formattedTime);

    await api.spreadsheets.values.append({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!A:L`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[
        '=ROW()-1', formatDate(now), formatTimeIST(now), name,
        phoneNumber, phoneNumber, '', config.DEFAULTS.PRODUCT, '', '', '', attendanceValue
      ]] }
    });

    console.log(`${LOG_PREFIX} New attendance entry: ${phoneNumber} row ${nextRow}`);

    return {
      found: false, action: 'created', row: nextRow,
      name, attendance: attendanceValue,
      message: 'New entry created with attendance marked'
    };
  } catch (error) {
    console.error(`${LOG_PREFIX} updateAttendance error: ${error.message}`);
    throw error;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  insertNewContact,
  insertNewContactManual,
  findUserByPhoneNumber,
  checkFirebaseWhitelist,
  updateFormData,
  handleCommunityJoin,
  updateAttendance
};