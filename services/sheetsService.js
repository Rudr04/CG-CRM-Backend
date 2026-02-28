// ============================================================================
//  services/sheetsService.js — Google Sheets CRUD
//
//  Phase 2: Firestore-first (primary writes to Firestore, async backup to Sheet)
//  All Sheet operations. Uses centralized helpers.
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
//  FIRE-AND-FORGET HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function fireAndForgetFirestore(fn) {
  if (!config.FIRESTORE.ENABLED) return;
  fn().catch(err => console.error(`${LOG_PREFIX} [Firestore async] ${err.message}`));
}

function fireAndForgetSheet(fn) {
  fn().catch(err => console.error(`${LOG_PREFIX} [Sheet async] ${err.message}`));
}


// ═══════════════════════════════════════════════════════════════════════════
//  FIND USER
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
//  Convert Firestore doc to Sheet-row-shaped array
//  Callers like insertNewContact read data[config.SHEET_COLUMNS.MESSAGE] etc.
//  This bridges the gap so existing code doesn't break.
// ─────────────────────────────────────────────────────────────
function _firestoreToSheetRow(d) {
  const row = Array(27).fill('');
  row[config.SHEET_COLUMNS.NAME]     = d.name || '';
  row[config.SHEET_COLUMNS.NUMBER]   = d.phone || d.phone10 || '';
  row[config.SHEET_COLUMNS.LOCATION] = d.location || '';
  row[config.SHEET_COLUMNS.PRODUCT]  = d.product || '';
  row[config.SHEET_COLUMNS.MESSAGE]  = d.message || '';
  row[config.SHEET_COLUMNS.SOURCE]   = d.source || '';
  row[config.SHEET_COLUMNS.TEAM]     = d.agent || d.team || '';
  row[config.SHEET_COLUMNS.STATUS]   = d.status || '';
  row[config.SHEET_COLUMNS.RATING]   = d.rating || '';
  row[config.SHEET_COLUMNS.REMARK]   = d.remark || '';
  row[config.SHEET_COLUMNS.TEAM_2]   = d.team2 || '';
  row[config.SHEET_COLUMNS.STATUS_2] = d.status2 || '';
  row[config.SHEET_COLUMNS.REMARK_2] = d.remark2 || '';
  return row;
}

async function findUserByPhoneNumber(phoneNumber) {
  // Phase 2: Firestore lookup first (single doc read vs full Sheet scan)
  if (config.FIRESTORE.ENABLED && config.FIRESTORE.PHASE >= 2) {
    try {
      const firestoreLead = await FirestoreService.findLeadByPhone(phoneNumber);
      if (firestoreLead) {
        console.log(`${LOG_PREFIX} [Phase2] Duplicate found in Firestore: ${firestoreLead.docId}`);
        // Return shape compatible with all callers: { row, data }
        const d = firestoreLead.data;
        return {
          row: d.sheetRow || null,
          data: _firestoreToSheetRow(d),
          source: 'firestore'
        };
      }
      // Not in Firestore — fall through to Sheet scan as safety net
      console.log(`${LOG_PREFIX} [Phase2] Not in Firestore, falling back to Sheet scan for ${getLastTenDigits(phoneNumber)}`);
    } catch (err) {
      console.error(`${LOG_PREFIX} [Phase2] Firestore lookup failed, falling back to Sheet: ${err.message}`);
    }
  }

  // Phase 1 fallback / Phase 2 safety net: full Sheet scan
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
      return { row: i + 2, data: row, source: 'sheet' };
    }
  }
  return null;
}


// ═══════════════════════════════════════════════════════════════════════════
//  INSERT CONTACT (webhook)
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
//  Shared helper: append a new lead row to Sheet5
//  Returns the row number, or throws on failure
// ─────────────────────────────────────────────────────────────
async function _appendToSheet(api, sheetName, data) {
  const { senderName, waId, location, source, messageText, remark, team } = data;

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
  rowData[config.SHEET_COLUMNS.MESSAGE]   = messageText || '';
  rowData[config.SHEET_COLUMNS.SOURCE]    = source;
  rowData[config.SHEET_COLUMNS.TEAM]      = team;
  rowData[config.SHEET_COLUMNS.STATUS]    = 'Lead';
  rowData[config.SHEET_COLUMNS.DAY]       = `=IFERROR(WEEKDAY($B${nextRow},2)&TEXT($B${nextRow},"dddd"), "")`;
  rowData[config.SHEET_COLUMNS.HOURS]     = `=IFERROR(HOUR($C${nextRow}), "")`;
  rowData[config.SHEET_COLUMNS.CONVERTED] = `=SWITCH(L${nextRow},"Admission Done",1,"Seat Booked",1,0)`;
  if (remark) rowData[config.SHEET_COLUMNS.REMARK] = remark;

  await api.spreadsheets.values.append({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowData] }
  });

  console.log(`${LOG_PREFIX} [Sheet] New contact appended at row ${nextRow}`);
  return nextRow;
}

// ─────────────────────────────────────────────────────────────
//  Shared helper: append a new lead row to Sheet5 (manual entry)
//  Slightly different column layout for manual entries
// ─────────────────────────────────────────────────────────────
async function _appendToSheetManual(api, sheetName, data) {
  const { senderName, waId, location, product, source, team, remark } = data;

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

  console.log(`${LOG_PREFIX} [Sheet] Manual inquiry appended at row ${nextRow}`);
  return nextRow;
}

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
    console.log(`${LOG_PREFIX} Contact ${waId} exists at row ${existingContact.row}`);

    if (config.FIRESTORE.ENABLED && config.FIRESTORE.PHASE >= 2) {
      // Phase 2: Firestore-first update
      try {
        await FirestoreService.createOrUpdateLead({
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
        });
        console.log(`${LOG_PREFIX} [Phase2] Existing lead updated in Firestore: ${waId}`);

        // Sheet update is async backup (only if we have a valid row number)
        if (existingContact.row) {
          fireAndForgetSheet(async () => {
            const sheetApi = await getSheets();
            const updates = [];
            if (messageText) {
              const currentMsg = existingContact.data[config.SHEET_COLUMNS.MESSAGE] || '';
              const newMsg = currentMsg ? `${currentMsg} | ${messageText}` : messageText;
              updates.push({ range: `${sheetName}!I${existingContact.row}`, values: [[newMsg]] });
            }
            if (remark) {
              const currentRemark = existingContact.data[config.SHEET_COLUMNS.REMARK] || '';
              const newRemark = currentRemark ? `${currentRemark} | ${remark}` : remark;
              updates.push({ range: `${sheetName}!O${existingContact.row}`, values: [[newRemark]] });
            }
            if (updates.length > 0) {
              await sheetApi.spreadsheets.values.batchUpdate({
                spreadsheetId: config.SPREADSHEET_ID,
                requestBody: { valueInputOption: 'RAW', data: updates }
              });
            }
          });
        }

        return { message: 'Existing contact updated (Firestore-first)', row: existingContact.row };
      } catch (err) {
        console.error(`${LOG_PREFIX} [Phase2] Firestore update failed, falling back to Sheet: ${err.message}`);
        // Fall through to Phase 1 below
      }
    }

    // Phase 1 fallback
    const updates = [];
    if (messageText) {
      const currentMsg = existingContact.data[config.SHEET_COLUMNS.MESSAGE] || '';
      const newMsg = currentMsg ? `${currentMsg} | ${messageText}` : messageText;
      updates.push({ range: `${sheetName}!I${existingContact.row}`, values: [[newMsg]] });
    }
    if (remark) {
      const currentRemark = existingContact.data[config.SHEET_COLUMNS.REMARK] || '';
      const newRemark = currentRemark ? `${currentRemark} | ${remark}` : remark;
      updates.push({ range: `${sheetName}!O${existingContact.row}`, values: [[newRemark]] });
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

  // ── New contact ──
  if (config.FIRESTORE.ENABLED && config.FIRESTORE.PHASE >= 2) {
    // ── PHASE 2: Firestore-first ──
    try {
      const firestoreResult = await FirestoreService.createLead({
        phone: waId,
        name: senderName,
        location: location,
        product: 'CGI',
        source: source,
        message: messageText,
        remark: remark,
        team: team,
        status: 'Lead',
        channel: 'webhook'
      });
      console.log(`${LOG_PREFIX} [Phase2] Lead created in Firestore: ${firestoreResult?.cgId || waId}`);

      // Sheet write is now async/non-blocking backup
      fireAndForgetSheet(async () => {
        const sheetRow = await _appendToSheet(api, sheetName, {
          senderName, waId, location, source, messageText, remark, team
        });
        // Update Firestore with the sheetRow reference
        if (sheetRow && firestoreResult?.docId) {
          FirestoreService.updateLead(waId, { sheetRow }, null)
            .catch(err => console.error(`${LOG_PREFIX} [Phase2] sheetRow update failed: ${err.message}`));
        }
      });

      return { message: 'New contact created (Firestore-first)', row: null };

    } catch (firestoreErr) {
      // Firestore failed — fall back to Phase 1 (Sheet-first)
      console.error(`${LOG_PREFIX} [Phase2] Firestore create failed, falling back to Sheet: ${firestoreErr.message}`);
      // Fall through to Phase 1 path below
    }
  }

  // ── PHASE 1 FALLBACK: Sheet-first (also used when PHASE < 2) ──
  const sheetRow = await _appendToSheet(api, sheetName, {
    senderName, waId, location, source, messageText, remark, team
  });

  fireAndForgetFirestore(() => FirestoreService.createLead({
    phone: waId, name: senderName, location, product: 'CGI',
    source, message: messageText, remark, team, status: 'Lead',
    sheetRow: sheetRow, channel: 'webhook'
  }));

  return { message: 'New contact created', row: sheetRow };
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
    console.log(`${LOG_PREFIX} Contact ${waId} exists at row ${existingContact.row}`);

    if (config.FIRESTORE.ENABLED && config.FIRESTORE.PHASE >= 2) {
      // Phase 2: Firestore-first update
      try {
        await FirestoreService.createOrUpdateLead({
          phone: waId,
          name: senderName,
          remark: remark,
          source: source,
          location: location
        }, {
          action: 'contact_updated',
          by: 'system',
          details: { source, trigger: 'manual_duplicate' }
        });
        console.log(`${LOG_PREFIX} [Phase2] Existing lead updated in Firestore: ${waId}`);

        // Sheet update is now async backup
        fireAndForgetSheet(async () => {
          const sheetApi = await getSheets();
          const updates = [];
          if (remark) {
            const currentRemark = existingContact.data[config.SHEET_COLUMNS.REMARK] || '';
            const newRemark = currentRemark ? `${currentRemark} | ${remark}` : remark;
            updates.push({ range: `${sheetName}!O${existingContact.row}`, values: [[newRemark]] });
          }
          if (updates.length > 0) {
            await sheetApi.spreadsheets.values.batchUpdate({
              spreadsheetId: config.SPREADSHEET_ID,
              requestBody: { valueInputOption: 'RAW', data: updates }
            });
          }
        });

        return { message: 'Existing contact updated (Firestore-first)', row: existingContact.row };
      } catch (err) {
        console.error(`${LOG_PREFIX} [Phase2] Firestore update failed, falling back to Sheet: ${err.message}`);
        // Fall through to Phase 1 below
      }
    }

    // Phase 1 fallback
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

  // ── New contact ──
  if (config.FIRESTORE.ENABLED && config.FIRESTORE.PHASE >= 2) {
    try {
      const firestoreResult = await FirestoreService.createLead({
        phone: waId,
        name: senderName,
        location: location,
        product: product,
        source: source,
        remark: remark,
        team: team,
        status: 'Lead',
        channel: 'manual_entry'
      });
      console.log(`${LOG_PREFIX} [Phase2] Manual lead created in Firestore: ${firestoreResult?.cgId || waId}`);

      fireAndForgetSheet(async () => {
        const sheetRow = await _appendToSheetManual(api, sheetName, {
          senderName, waId, location, product, source, team, remark
        });
        if (sheetRow && firestoreResult?.docId) {
          FirestoreService.updateLead(waId, { sheetRow }, null)
            .catch(err => console.error(`${LOG_PREFIX} [Phase2] sheetRow update failed: ${err.message}`));
        }
      });

      return { message: 'Manual inquiry created (Firestore-first)', row: null };
    } catch (firestoreErr) {
      console.error(`${LOG_PREFIX} [Phase2] Firestore create failed, falling back to Sheet: ${firestoreErr.message}`);
    }
  }

  // Phase 1 fallback
  const sheetRow = await _appendToSheetManual(api, sheetName, {
    senderName, waId, location, product, source, team, remark
  });

  fireAndForgetFirestore(() => FirestoreService.createLead({
    phone: waId, name: senderName, location, product, source, remark,
    team, status: 'Lead', sheetRow, channel: 'manual_entry'
  }));

  return { message: 'Manual inquiry created', row: sheetRow };
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