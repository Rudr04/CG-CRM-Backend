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
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
      ]
    });
    sheets = google.sheets({ version: 'v4', auth });
    console.log('Google Sheets API initialized');
  }
  return sheets;
}

let drive;

async function getDrive() {
  if (!drive) {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    drive = google.drive({ version: 'v3', auth });
    console.log('Google Drive API initialized');
  }
  return drive;
}


// ═══════════════════════════════════════════════════════════════════════════
//  DYNAMIC COLUMN MAP — reads header row, caches with 5-min TTL
//  Returns: { map: { fieldKey: colIndex }, reverseMap: { colIndex: fieldKey }, headerCount, fetchedAt }
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes
const _columnMapCache = {};  // keyed by `${spreadsheetId}::${sheetName}`

async function getColumnMap(sheetName, spreadsheetId) {
  spreadsheetId = spreadsheetId || config.SPREADSHEET_ID;
  const cacheKey = `${spreadsheetId}::${sheetName}`;

  const cached = _columnMapCache[cacheKey];
  if (cached && (Date.now() - cached.fetchedAt < CACHE_TTL_MS)) {
    return cached;
  }

  const api = await getSheets();
  const response = await api.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: `${sheetName}!1:1`
  });

  const headers = (response.data.values && response.data.values[0]) || [];
  const map = {};          // fieldKey → 0-based colIndex
  const reverseMap = {};   // 0-based colIndex → fieldKey

  for (let i = 0; i < headers.length; i++) {
    const headerText = (headers[i] || '').trim();
    if (!headerText) continue;
    const fieldKey = config.HEADER_TO_FIELD[headerText];
    if (fieldKey) {
      map[fieldKey] = i;
      reverseMap[i] = fieldKey;
    }
  }

  // Validate critical fields
  const critical = ['number', 'name', 'status', 'team'];
  const missing = critical.filter(f => map[f] === undefined);
  if (missing.length > 0) {
    console.error(`[Sheet] WARNING: Missing headers in ${sheetName}: ${missing.join(', ')}`);
  }

  const result = { map, reverseMap, headerCount: headers.length, fetchedAt: Date.now() };
  _columnMapCache[cacheKey] = result;
  console.log(`[Sheet] Column map cached for ${cacheKey}: ${Object.keys(map).length} fields mapped`);
  return result;
}

/**
 * Convert raw row array to field-keyed object using column map
 */
function rowToObject(rowArray, colMap) {
  const obj = {};
  for (const [fieldKey, colIdx] of Object.entries(colMap.map)) {
    obj[fieldKey] = (rowArray[colIdx] || '').toString();
  }
  return obj;
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

  const existing = await findByPhone(phone);
  const colMap = await getColumnMap(sheetName);  // cached from findByPhone
  const M = colMap.map;

  if (existing) {
    // ── Update existing row ──
    const cellUpdates = {};  // colIndex → value

    // Append fields (merge with existing)
    if (leadData.message) {
      const current = existing.data.message || '';
      cellUpdates[M.message] = current ? `${current} | ${leadData.message}` : leadData.message;
    }
    if (leadData.remark) {
      const current = existing.data.remark || '';
      cellUpdates[M.remark] = current ? `${current} | ${leadData.remark}` : leadData.remark;
    }

    // Fill blanks (don't overwrite existing)
    if (leadData.name && !existing.data.name)         cellUpdates[M.name] = leadData.name;
    if (leadData.location && !existing.data.location) cellUpdates[M.location] = leadData.location;
    if (leadData.source && !existing.data.source)     cellUpdates[M.source] = leadData.source;

    // Append inquiry and product (comma-space separator for Sheet dropdowns)
    if (leadData.inquiry) {
      const currentInquiry = existing.data.inquiry || '';
      if (!currentInquiry.split(', ').includes(leadData.inquiry)) {
        cellUpdates[M.inquiry] = currentInquiry ? `${currentInquiry}, ${leadData.inquiry}` : leadData.inquiry;
      }
    }
    if (leadData.product) {
      const currentProduct = existing.data.product || '';
      if (!currentProduct.split(', ').includes(leadData.product)) {
        cellUpdates[M.product] = currentProduct ? `${currentProduct}, ${leadData.product}` : leadData.product;
      }
    }
    if (leadData.adCampaign && M.adCampaign !== undefined) {
      const currentAdCampaign = existing.data.adCampaign || '';
      if (!currentAdCampaign.split(', ').includes(leadData.adCampaign)) {
        cellUpdates[M.adCampaign] = currentAdCampaign ? `${currentAdCampaign}, ${leadData.adCampaign}` : leadData.adCampaign;
      }
    }
    if (leadData.adSet && M.adSet !== undefined) {
      const currentAdSet = existing.data.adSet || '';
      if (!currentAdSet.split(', ').includes(leadData.adSet)) {
        cellUpdates[M.adSet] = currentAdSet ? `${currentAdSet}, ${leadData.adSet}` : leadData.adSet;
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
    const inquiry  = leadData.inquiry || config.DEFAULTS.INQUIRY;
    const product  = leadData.product || '';
    const source   = leadData.source || '';
    const team     = leadData.team || leadData.agent || config.DEFAULTS.TEAM;
    const message  = leadData.message || '';
    const remark   = leadData.remark || '';
    const status   = leadData.status || config.DEFAULTS.STATUS;

    const totalCols = colMap.headerCount;
    const rowData = new Array(totalCols).fill('');

    const set = (fieldKey, value) => {
      if (M[fieldKey] !== undefined) rowData[M[fieldKey]] = value;
    };

    set('cgid',     leadData.cgId || `=ROW()-1+${config.DEFAULTS.SERIAL_OFFSET}`);
    set('date',     date);
    set('time',     time);
    set('name',     name);
    set('number',   phone);
    set('location', location);
    set('inquiry',  inquiry);
    set('product',  product);
    set('message',  message);
    set('source',   source);
    set('team',     team);
    set('status',   status);
    set('remark',   remark);
    set('adCampaign', leadData.adCampaign || '');
    set('adSet',      leadData.adSet || '');

    const dateLetter   = config.colLetter(M.date);
    const timeLetter   = config.colLetter(M.time);
    const statusLetter = config.colLetter(M.status);

    set('day',   `=IFERROR(WEEKDAY($${dateLetter}${nextRow},2)&TEXT($${dateLetter}${nextRow},"dddd"), "")`);
    set('hours', `=IFERROR(HOUR($${timeLetter}${nextRow}), "")`);

    const switchCases = config.CONVERTED_STATUSES.map(s => `"${s}",1`).join(',');
    set('converted', `=SWITCH(${statusLetter}${nextRow},${switchCases},0)`);

    const lastLetter = config.colLetter(totalCols - 1);
    await api.spreadsheets.values.append({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!A:${lastLetter}`,
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
//  specific fields. Keys are 0-based column indices.
//
//  @param {number} row    - Sheet row number
//  @param {Object} fields - { [colIdx]: 'value', ... } — colIdx from getColumnMap()
// ═════════════════════════════════════════════════════════════
async function updateContactCells(row, fields, spreadsheetId, tabName) {
  if (!row) throw new Error('updateContactCells: row is required');
  spreadsheetId = spreadsheetId || config.SPREADSHEET_ID;
  tabName = tabName || config.SHEETS.DSR;

  const api = await getSheets();

  const updates = [];
  for (const [colIdx, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const letter = config.colLetter(parseInt(colIdx));
    updates.push({
      range: `${tabName}!${letter}${row}`,
      values: [[value]]
    });
  }

  if (updates.length > 0) {
    await api.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: updates }
    });
    console.log(`[Sheet] Updated ${updates.length} cell(s) on ${tabName} row ${row}`);
  }
}


// ═════════════════════════════════════════════════════════════
//  FIND BY PHONE — Sheet-only phone scan
//  Scans Sheet5 for a matching phone number.
//  NO Firestore lookup — handler does that separately.
//
//  @returns {{ row: number, data: string[] }} or null
// ═════════════════════════════════════════════════════════════
async function findByPhone(phoneNumber, spreadsheetId, tabName) {
  spreadsheetId = spreadsheetId || config.SPREADSHEET_ID;
  tabName = tabName || config.SHEETS.DSR;

  const api = await getSheets();
  const colMap = await getColumnMap(tabName, spreadsheetId);

  const phoneColIdx = colMap.map.number;
  if (phoneColIdx === undefined) {
    throw new Error(`findByPhone: "Mobile Number" header not found in ${tabName}`);
  }

  const phoneLetter = config.colLetter(phoneColIdx);
  const phoneResponse = await api.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: `${tabName}!${phoneLetter}2:${phoneLetter}`
  });

  const phoneCol = phoneResponse.data.values || [];

  for (let i = 0; i < phoneCol.length; i++) {
    const registeredNum = phoneCol[i][0] || '';
    if (phoneNumbersMatch(phoneNumber, registeredNum)) {
      const matchedRow = i + 2;

      const lastLetter = config.colLetter(colMap.headerCount - 1);
      const rowResponse = await api.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: `${tabName}!A${matchedRow}:${lastLetter}${matchedRow}`
      });

      const rowArray = (rowResponse.data.values && rowResponse.data.values[0]) || [];
      return { row: matchedRow, data: rowToObject(rowArray, colMap) };
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
//  UPDATE MC ATTENDANCE — Direct cell write using sheetRow
//
//  @param {number} sheetRow — 1-based row number in DSR
//  @param {string} formattedTime — e.g. "14:30"
//  @returns {{ updated: boolean, attendance: string }}
// ═════════════════════════════════════════════════════════════
async function updateMcAttendance(sheetRow, formattedTime, spreadsheetId = config.SPREADSHEET_ID, tabName = config.SHEETS.DSR) {
  const api = await getSheets();

  const colMap = await getColumnMap(tabName, spreadsheetId);
  const mcAttColIndex = colMap.map.mcAttendance ?? colMap.map.attendance;

  if (mcAttColIndex === undefined) {
    throw new Error('updateMcAttendance: Attendance column not found in headers.');
  }

  const mcAttLetter = config.colLetter(mcAttColIndex);

  const currentRes = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!${mcAttLetter}${sheetRow}`,
  });

  const currentValue = (currentRes.data.values?.[0]?.[0] || '').trim();
  const finalValue = currentValue
    ? `${currentValue} | ${formattedTime}`
    : `Present ${formattedTime}`;

  await api.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!${mcAttLetter}${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[finalValue]] },
  });

  console.log(`[Sheet] Attendance at row ${sheetRow}: ${finalValue}`);
  return { updated: true, attendance: finalValue };
}


// ═════════════════════════════════════════════════════════════
//  APPEND TO MC LOGGED IN — For leads without sheetRow or
//  not found in CRM at all.
//  Fixed 4-column layout: CGID | Time | Number | Attendence
//
//  @param {string} cgId
//  @param {string} phoneNumber
//  @param {string} attendanceValue — e.g. "Present 14:30"
//  @returns {{ row: number }}
// ═════════════════════════════════════════════════════════════
async function appendToMcLoggedIn(cgId, phoneNumber, formattedTime) {
  const api = await getSheets();
  const sheetName = config.SHEETS.MC_LOGGED_IN;

  // Check if phone already exists in Number column (C)
  const numberRes = await api.spreadsheets.values.get({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!C2:C`,
  });

  const numbers = numberRes.data.values || [];
  let existingRow = null;

  for (let i = 0; i < numbers.length; i++) {
    if ((numbers[i][0] || '').toString().trim() === phoneNumber.toString().trim()) {
      existingRow = i + 2;
      break;
    }
  }

  if (existingRow) {
    // Update existing — append time to Attendence column (D)
    const currentRes = await api.spreadsheets.values.get({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!D${existingRow}`,
    });

    const currentValue = (currentRes.data.values?.[0]?.[0] || '').trim();
    const finalValue = currentValue
      ? `${currentValue} | ${formattedTime}`
      : `Present ${formattedTime}`;

    await api.spreadsheets.values.update({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `${sheetName}!D${existingRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[finalValue]] },
    });

    console.log(`[Sheet] MC Logged In updated row ${existingRow}: ${finalValue}`);
    return { row: existingRow, action: 'updated' };
  }

  // New row — insert
  const now = new Date();
  const time = now.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const newRow = [cgId, time, phoneNumber, `Present ${formattedTime}`];

  const appendRes = await api.spreadsheets.values.append({
    spreadsheetId: config.SPREADSHEET_ID,
    range: `${sheetName}!A:D`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [newRow] },
  });

  const updatedRange = appendRes.data.updates?.updatedRange || '';
  const rowMatch = updatedRange.match(/!A(\d+)/);
  const row = rowMatch ? parseInt(rowMatch[1], 10) : -1;

  console.log(`[Sheet] MC Logged In new row ${row}: ${phoneNumber}`);
  return { row, action: 'inserted' };
}


// ═════════════════════════════════════════════════════════════
//  ADD THREADED COMMENT — anchored to a specific cell
//
//  Uses Drive API v3 with matrix anchor format.
//  Row and col are 1-indexed (row 2, col 3 = cell C2).
//
//  @param {number} row           - Sheet row (1-based)
//  @param {number} colIdx        - 0-based column index (converted to 1-based internally)
//  @param {string} commentText   - Comment content
//  @param {string} spreadsheetId
// ═════════════════════════════════════════════════════════════
async function addComment(row, colIdx, commentText, spreadsheetId) {
  spreadsheetId = spreadsheetId || config.SPREADSHEET_ID;
  const driveApi = await getDrive();

  const anchor = JSON.stringify({
    r: 'head',
    a: [{ matrix: { r: row, c: colIdx + 1, w: 1, h: 1 } }]
  });

  const response = await driveApi.comments.create({
    fileId: spreadsheetId,
    fields: 'id',
    requestBody: {
      content: commentText,
      anchor,
    },
  });

  console.log(`[Sheet] Comment added on row ${row} col ${colIdx + 1}, id: ${response.data.id}`);
  return response.data.id;
}

// ═════════════════════════════════════════════════════════════
//  ADD NOTE TO CELL
// ═════════════════════════════════════════════════════════════
async function addCellNote(row, colIdx, noteText, spreadsheetId, tabName) {
  spreadsheetId = spreadsheetId || config.SPREADSHEET_ID;
  tabName = tabName || config.SHEETS.DSR;

  const api = await getSheets();

  const meta = await api.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties'
  });
  const sheet = meta.data.sheets.find(s => s.properties.title === tabName);
  if (!sheet) throw new Error(`addCellNote: tab '${tabName}' not found`);

  await api.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateCells: {
          rows: [{ values: [{ note: noteText }] }],
          fields: 'note',
          range: {
            sheetId: sheet.properties.sheetId,
            startRowIndex: row - 1,
            endRowIndex: row,
            startColumnIndex: colIdx,
            endColumnIndex: colIdx + 1,
          }
        }
      }]
    }
  });

  console.log(`[Sheet] Note added on ${tabName} row ${row} col ${colIdx}`);
}

// ═════════════════════════════════════════════════════════════
//  INSERT ROW TO SHEET — Write lead data to any target sheet
//
//  Uses dynamic column mapping: reads row 1 headers of the
//  target sheet, maps Firestore field keys to column positions.
//
//  @param {string} spreadsheetId — target spreadsheet
//  @param {string} tabName — target sheet tab name
//  @param {Object} leadData — Firestore document data (field-keyed)
//  @returns {{ row: number }}
// ═════════════════════════════════════════════════════════════
async function insertRowToSheet(spreadsheetId, tabName, leadData) {
  const api = await getSheets();

  // Read target sheet headers dynamically
  const headerResponse = await api.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: `${tabName}!1:1`
  });

  const headers = (headerResponse.data.values && headerResponse.data.values[0]) || [];
  if (headers.length === 0) {
    throw new Error(`insertRowToSheet: No headers found in ${tabName}`);
  }

  // Build field key → column index map for target sheet
  const targetMap = {};
  for (let i = 0; i < headers.length; i++) {
    const headerText = (headers[i] || '').trim();
    if (!headerText) continue;
    const fieldKey = config.HEADER_TO_FIELD[headerText];
    if (fieldKey) targetMap[fieldKey] = i;
  }

  // Get next row number
  const rowCountResponse = await api.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range: `${tabName}!A2:A`
  });
  const existingRows = rowCountResponse.data.values || [];
  const nextRow = existingRows.length + 2;

  // Build row array using target sheet's column positions
  const totalCols = headers.length;
  const rowData = new Array(totalCols).fill('');

  // Map Firestore field names to internal field keys
  // leadData uses Firestore keys (cgId, agent, etc.)
  // HEADER_TO_FIELD/FIELD_HEADERS use internal keys (cgid, team, etc.)
  const firestoreToFieldKey = {
    cgId:           'cgid',
    createdAt:      'date',       // Will be formatted
    name:           'name',
    phone:          'number',
    location:       'location',
    inquiry:        'inquiry',
    product:        'product',
    source:         'source',
    agent:          'team',       // Firestore 'agent' → sheet 'Team'
    status:         'status',
    rating:         'rating',
    remark:         'remark',
    cbDate:         'cbDate',
    pipelineStage:  'pipelineStage',
    scholarship:    'scholarship',
    installment:    'installment',
    // Phase 3 fields
    salesRemark:    'salesRemark',
    approvalDate:   'approvalDate',
    quantity:       'quantity',
    productPrice:   'productPrice',
    amountPaid:     'amountPaid',
    pendingAmount:  'pendingAmount',
    modeOfPay:      'modeOfPay',
    paymentRefId:   'paymentRefId',
    dateOfPayment:  'dateOfPayment',
    receivedAccount:'receivedAccount',
    fulfillmentStatus: 'fulfillmentStatus',
    fulfillmentDate:   'fulfillmentDate',
    fulfillmentRemark: 'fulfillmentRemark',
    mcAttendance:      'mcAttendance',
    formFilled:        'formFilled',
    callLog:           'callLog',
    // Sales review + payment transition fields
    // (paymentDate reuses dateOfPayment above; txnLast4 reuses paymentRefId above;
    //  adjustedFee reuses finalPrice below)
    salesApproval:    'salesApproval',
    paymentApproval:  'paymentApproval',
    modeOfStudy:      'modeOfStudy',
    certificateType:  'certificateType',
    batch:            'batch',
    finalPrice:       'finalPrice',
    partialAccess:    'partialAccess',
    accessThreshold:  'accessThreshold',
    paymentDeadline:  'paymentDeadline',
    adCampaign:       'adCampaign',
    adSet:            'adSet',
  };

  const set = (fieldKey, value) => {
    if (targetMap[fieldKey] !== undefined && value !== undefined && value !== null) {
      rowData[targetMap[fieldKey]] = value;
    }
  };

  // Map each Firestore field to the target sheet
  for (const [fsKey, fieldKey] of Object.entries(firestoreToFieldKey)) {
    let value = leadData[fsKey];
    if (value === undefined || value === null) value = '';

    // Special handling for date — Firestore stores ISO string, sheet needs MM/DD/YYYY
    if (fsKey === 'createdAt' && value) {
      try {
        const d = new Date(value);
        const parts = new Intl.DateTimeFormat('en-IN', {
          timeZone: config.TIMEZONE,
          year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(d);
        const month = parts.find(p => p.type === 'month').value;
        const day   = parts.find(p => p.type === 'day').value;
        const year  = parts.find(p => p.type === 'year').value;
        value = `${month}/${day}/${year}`;
      } catch (e) { /* keep original */ }
    }
    set(fieldKey, value);
  }

  // Append to target sheet
  const lastLetter = config.colLetter(totalCols - 1);
  await api.spreadsheets.values.append({
    spreadsheetId: spreadsheetId,
    range: `${tabName}!A:${lastLetter}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowData] }
  });

  console.log(`[Sheet] Inserted row ${nextRow} into ${tabName} for ${leadData.cgId}`);
  return { row: nextRow };
}


// ═════════════════════════════════════════════════════════════
//  DELETE ROW FROM SHEET — physically removes a row
//  (rows below shift up; row numbers for those rows become invalid)
//
//  @param {string} spreadsheetId
//  @param {string} tabName
//  @param {number} row — 1-based row number to delete
// ═════════════════════════════════════════════════════════════
async function deleteRowFromSheet(spreadsheetId, tabName, row) {
  const api = await getSheets();

  const spreadsheet = await api.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties'
  });

  const targetSheet = spreadsheet.data.sheets.find(
    s => s.properties.title === tabName
  );
  if (!targetSheet) {
    throw new Error(`deleteRowFromSheet: Tab "${tabName}" not found in spreadsheet ${spreadsheetId}`);
  }

  await api.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: targetSheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: row - 1,  // 0-based inclusive
            endIndex: row,         // 0-based exclusive
          }
        }
      }]
    }
  });

  console.log(`[Sheet] Row ${row} deleted from ${tabName}`);
}


// ═════════════════════════════════════════════════════════════
//  UPSERT CVPT CONTACT — Leads sheet for CVPT campaign
// ═════════════════════════════════════════════════════════════
async function upsertCVPTContact(phone, updates, name = '') {
  const spreadsheetId = config.CVPT.SPREADSHEET_ID;
  const tabName = config.CVPT.SHEET_NAME;
  const api = await getSheets();
  const colMap = await getColumnMap(tabName, spreadsheetId);
  const M = colMap.map;

  const existing = await findByPhone(phone, spreadsheetId, tabName);

  if (existing) {
    const cellUpdates = {};
    for (const [fieldKey, value] of Object.entries(updates)) {
      if (M[fieldKey] !== undefined && value !== undefined) {
        cellUpdates[M[fieldKey]] = value;
      }
    }
    if (Object.keys(cellUpdates).length > 0) {
      await updateContactCells(existing.row, cellUpdates, spreadsheetId, tabName);
    }
    console.log(`[Sheet] CVPT updated row ${existing.row} for ${phone}`);
    return { row: existing.row, action: 'updated' };
  } else {
    const now = new Date();
    const date = formatDate(now);
    const timeOpts = { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' };
    const time = new Intl.DateTimeFormat('en-IN', timeOpts).format(now);

    const totalCols = colMap.headerCount;
    const rowData = new Array(totalCols).fill('');

    const set = (fieldKey, value) => {
      if (M[fieldKey] !== undefined) rowData[M[fieldKey]] = value;
    };

    set('date', date);
    set('time', time);
    set('number', phone);
    set('name', name);
    set('team', 'Not Assigned');

    for (const [fieldKey, value] of Object.entries(updates)) {
      set(fieldKey, value);
    }

    const lastLetter = config.colLetter(totalCols - 1);
    const appendRes = await api.spreadsheets.values.append({
      spreadsheetId,
      range: `${tabName}!A:${lastLetter}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowData] },
    });

    const updatedRange = appendRes.data.updates?.updatedRange || '';
    const rowMatch = updatedRange.match(/(\d+)(?::\w+\d+)?$/);
    const appendedRow = rowMatch ? parseInt(rowMatch[1]) : null;

    console.log(`[Sheet] CVPT appended row ${appendedRow} for ${phone}`);
    return { row: appendedRow, action: 'created' };
  }
}

module.exports = {
  upsertContact,
  updateContactCells,
  findByPhone,
  getColumnMap,
  rowToObject,
  checkFirebaseWhitelist,
  updateMcAttendance,
  appendToMcLoggedIn,
  insertRowToSheet,
  deleteRowFromSheet,
  addCellNote,
  addComment,
  upsertCVPTContact
};
