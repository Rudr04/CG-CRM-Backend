// ============================================================================
//  config.js — SINGLE SOURCE OF TRUTH for all configuration
//
//  ALL constants, timeouts, URLs, templates live here.
//  NO other file should have hardcoded values.
// ============================================================================


// ═══════════════════════════════════════════════════════════════════════════
//  ENVIRONMENT VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

const REQUIRED_ENV_VARS = [
  'SPREADSHEET_ID',
  'WATI_TENANT_ID', 
  'WATI_BEARER_TOKEN',
  'WATI_BASE_URL'
];

const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('CRITICAL: Missing environment variables:', missingVars);
}


// ═══════════════════════════════════════════════════════════════════════════
//  TIMEOUTS (centralized)
// ═══════════════════════════════════════════════════════════════════════════

const TIMEOUTS = {
  DEFAULT: 10000,      // 10s - general API calls
  FIREBASE: 5000,      // 5s  - Firebase RTDB (simple writes)
  SHEETS: 30000,       // 30s - Google Sheets (can be slow)
  WATI: 10000,         // 10s - WhatsApp API
  SMARTFLO: 10000,     // 10s - Smartflo calling API
};

// ═══════════════════════════════════════════════════════════════════════════
//  WHATSAPP GROUP LINKS & TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════

const WHATSAPP = {
  GROUP_LINKS: {
    ONLINE: 'https://chat.whatsapp.com/EgpO11VxMPcAnmu8YylIqI',
    OFFLINE: 'https://chat.whatsapp.com/LU7lyII2CaOK5aJLw6PhZ9',
  },
  TEMPLATES: {
    ONLINE_CONFIRMATION: 'cgi_22_test3',
    OFFLINE_CONFIRMATION: 'cgi_22_test3_2',
  },
  BROADCAST_NAME: 'Registration_Confirmation',
};


// ═══════════════════════════════════════════════════════════════════════════
//  TIMEZONE
// ═══════════════════════════════════════════════════════════════════════════

const TIMEZONE = 'Asia/Kolkata';


// ═══════════════════════════════════════════════════════════════════════════
//  COLUMN UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert 0-based column index to letter (0→A, 3→D, 25→Z, 26→AA)
 */
function colLetter(idx) {
  let letter = '';
  let n = idx;
  while (n >= 0) {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}


// ═══════════════════════════════════════════════════════════════════════════
//  FIELD HEADERS — Maps internal field keys to sheet header text
//  Used by sheetsService.getColumnMap() to find columns dynamically
//  To add a field: add here + add to sheet header row
//  To rename a column: change header text here + in sheet
// ═══════════════════════════════════════════════════════════════════════════

const FIELD_HEADERS = {
  cgid:          'CGID',
  date:          'Date',
  time:          'Time',
  name:          'Name',
  number:        'Mobile Number',
  location:      'Location',
  inquiry:       'Inquiry',
  product:       'Product',
  message:       'Message',
  source:        'Source',
  team:          'Team',
  status:        'Status',
  rating:        'Rating',
  cbDate:        'CB Date',
  remark:        'Remark',
  day:           'Day',
  hours:         'Hours',
  converted:     'Converted',
  pipelineStage: 'Pipeline Stage',
  scholarship:     'Scholarship',
  installment:     'Installment',
  // Phase 3 fields (will exist on other sheets later)
  salesRemark:     'Sales Remark',
  approvalDate:    'Approval Date',
  quantity:        'Quantity',
  productPrice:    'Product Price',
  amountPaid:      'Amount Paid',
  pendingAmount:   'Pending Amount',
  modeOfPay:       'Mode of Pay',
  paymentRefId:    'Payment Ref. ID',
  dateOfPayment:   'Date of Payment',
  receivedAccount: 'Received Account',
  fulfillmentStatus: 'Fulfillment Status',
  fulfillmentDate:   'Fulfillment Date',
  fulfillmentRemark: 'Fulfillment Remark',
  // Added in Part 3A for Phase 3 Payment + Fulfillment sheets (wired in 3B)
  discount:          'Discount',
  finalPrice:        'Final Price',
  paymentStatus:     'Payment Status',
  paymentRemark:     'Payment Remark',
  fullyPaid:         'Fully Paid',
  fulfillmentType:   'Fulfillment Type',
  batchOrSlot:       'Batch / Slot',
  consultant:        'Consultant',
};

// Reverse map: header text → field key
const HEADER_TO_FIELD = {};
for (const [field, header] of Object.entries(FIELD_HEADERS)) {
  HEADER_TO_FIELD[header] = field;
}


// ═══════════════════════════════════════════════════════════════════════════
//  TRACKED FIELDS — Which fields trigger Firestore sync on sheet edit
//  Keys are field names (matching what GAS sends in edit.field)
// ═══════════════════════════════════════════════════════════════════════════

const TRACKED_FIELDS = {
  name:          { firestoreField: 'name',          historyAction: 'name_updated' },
  location:      { firestoreField: 'location',      historyAction: 'location_updated' },
  inquiry:       { firestoreField: 'inquiry',       historyAction: 'inquiry_changed' },
  product:       { firestoreField: 'product',       historyAction: 'product_added' },
  team:          { firestoreField: 'agent',          historyAction: 'claimed' },
  status:        { firestoreField: 'status',         historyAction: 'status_changed' },
  rating:        { firestoreField: 'rating',         historyAction: 'rating_changed' },
  remark:        { firestoreField: 'remark',         historyAction: 'remark_added' },
  pipelineStage: { firestoreField: 'pipelineStage',  historyAction: 'stage_changed' },
  scholarship:     { firestoreField: 'scholarship',   historyAction: 'scholarship_updated' },
  installment:     { firestoreField: 'installment',    historyAction: 'installment_updated' },
  // Phase 3
  salesRemark:     { firestoreField: 'salesRemark',     historyAction: 'sales_remark_added' },
  fulfillmentStatus: { firestoreField: 'fulfillmentStatus', historyAction: 'fulfillment_status_changed' },
  fulfillmentRemark: { firestoreField: 'fulfillmentRemark', historyAction: 'fulfillment_remark_added' },
};

// Auto-generated lookup maps
const SHEET_TO_FIRESTORE = {};
const HISTORY_ACTIONS = {};

for (const [fieldName, mapping] of Object.entries(TRACKED_FIELDS)) {
  SHEET_TO_FIRESTORE[fieldName] = mapping.firestoreField;
  HISTORY_ACTIONS[fieldName] = mapping.historyAction;
}


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // ─── Google Sheets ────────────────────────────────────────────────────────
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,

  SHEETS: {
    DSR: 'Sheet5',
    PAID: 'Paid_Users',
    MANUAL_REVIEW: 'Manual_Review',
    FIREBASE_WHITELIST: 'OnlineAttendence'
  },

  // ─── WATI (WhatsApp) ──────────────────────────────────────────────────────
  WATI: {
    TENANT_ID: process.env.WATI_TENANT_ID,
    BEARER_TOKEN: process.env.WATI_BEARER_TOKEN,
    BASE_URL: process.env.WATI_BASE_URL,
    ...WHATSAPP,
    FORM_PARAMS: {
      NAME:   'mc_regi_form_23_screen_0_textinput_0',
      PHONE:  'mc_regi_form_23_screen_0_textinput_1',
      OPTION: 'mc_regi_form_23_screen_0_radiobuttonsgroup_0',
    },
  },

  // ─── Firebase RTDB (Whitelist only) ───────────────────────────────────────
  FIREBASE: {
    DATABASE_URL: process.env.FIREBASE_DATABASE_URL || '',
    SECRET: process.env.FIREBASE_SECRET || '',
  },

  // ─── Firestore (CRM Database) ─────────────────────────────────────────────
  FIRESTORE: {
    COLLECTION: 'leads',
    COUNTERS_DOC: 'system/counters',
    ENABLED: process.env.FIRESTORE_ENABLED !== 'false',
    PHASE: parseInt(process.env.FIRESTORE_PHASE || '2', 10)  // 1 = Sheet-first (parallel), 2 = Firestore-first
  },

  // ─── Smartflo (Calling) ───────────────────────────────────────────────────
  SMARTFLO: {
    API_KEY: process.env.SMARTFLO_API_KEY || '',
    CONTACT_GROUP_ID: process.env.SMARTFLO_CONTACT_GROUP_ID || '',
    BASE_URL: process.env.SMARTFLO_BASE_URL || ''
  },

  // ─── Timeouts ─────────────────────────────────────────────────────────────
  TIMEOUTS,

  // ─── Timezone ─────────────────────────────────────────────────────────────
  TIMEZONE,

  // ─── Pipeline Stages ──────────────────────────────────────────────────────
  STAGES: {
    NOT_ASSIGNED:  'unclaimed',
    AGENT_WORKING: 'agent_working',
    SALES_REVIEW:  'sales_review',
    PAYMENT:       'payment',
    FULFILLMENT:   'fulfillment',
    COMPLETED:     'completed',
    DEAD:          'dead'
  },

  // ─── Event Types (webhook routing) ────────────────────────────────────────
  EVENT_TYPES: {
    NEW_CONTACT: 'newContactMessageReceived',
    FORM_FILLED: 'MC_FormFilled',
    PAYMENT: 'Payment_Received',
    GRP_JOIN: 'GRP_LINK_CLICK',
    CG_WEB: 'CGI_Web_Form',
    CRM_ENTRY: 'Manually_Entry',
    SHEET_EDIT: 'sheet_edit',
    STAGE_TRANSITION: 'stage_transition',
    USER_LOGIN: 'user_login',
    MESSAGE: 'message',
  },

  // ─── List Reply IDs ───────────────────────────────────────────────────────
  LIST_REPLY_IDS: {
    INTERESTED: 'EPXcDmp'
  },

  // ─── Sheet Columns ─────────────────────────────────────────────────────────
  colLetter,             // utility: colLetter(3) → 'D'
  FIELD_HEADERS,         // fieldKey → sheet header text
  HEADER_TO_FIELD,       // sheet header text → fieldKey

  // ─── Field Sync Mappings ────────────────────────────────────────────────────
  TRACKED_FIELDS,        // fieldName → { firestoreField, historyAction }
  SHEET_TO_FIRESTORE,    // auto-generated: { 'team': 'agent', 'status': 'status', ... }
  HISTORY_ACTIONS,       // auto-generated: { 'team': 'claimed', 'status': 'status_changed', ... }

  // ─── Form Options & Status Values ─────────────────────────────────────────
  FORM_OPTIONS: {
    OFFLINE_OPTION: "Offline (અમદાવાદ ક્લાસ માં)",
    OFFLINE_STATUS: "Ahm MC Link Sent",
    ONLINE_STATUS: "Online MC Link Sent",
    OFFLINE_GROUP_JOINED: "Ahm MC GrpJoined",
    ONLINE_GROUP_JOINED: "Online MC GrpJoined",
  },

  CONVERTED_STATUSES: ['Admission Done', 'Seat Booked'],

  // ─── Defaults ─────────────────────────────────────────────────────────────
  DEFAULTS: {
    STATUS: 'Lead',
    TEAM: 'Not Assigned',
    INQUIRY: 'CGI',
    ROBO_AGENT: 'ROBO',
    SERIAL_OFFSET: 230000,
  },

  // ─── Stage Transitions ────────────────────────────────────────────────────
  // Maps: currentStage → [allowed target stages]
  // Any transition not listed here is BLOCKED
  STAGE_TRANSITIONS: {
    'unclaimed':      ['dead'],
    'agent_working':  ['sales_review', 'dead'],
    'sales_review':   ['payment', 'agent_working', 'dead'],
    'payment':        ['fulfillment', 'sales_review', 'dead'],
    'fulfillment':    ['completed', 'dead'],
  },

  // ─── Transition Requirements ────────────────────────────────────────────
  // Mandatory fields for each stage transition. Checked by stageHandler
  // as a safety net — primary enforcement is the GAS form.
  TRANSITION_REQUIREMENTS: {
    'agent_working→sales_review': {
      required: ['amountPaid', 'modeOfPay'],
      description: 'Payment evidence required before sales review',
    },
  },

  // ─── Sheet Routing ────────────────────────────────────────────────────────
  // Maps: target stage → spreadsheet config for cross-sheet routing
  SHEET_ROUTING: {
    'sales_review': {
      spreadsheetId: '1Kiw7dB0qedZxJ5VcqL5IDekZLPN-HaeCYSSbbTkwcZ8',
      tabName: 'Sheet1',
    },
    'payment': {
      spreadsheetId: '1wxnMYorziRoln6DT7YOSbb4dL5-c2yALYYet0zq4Gtk',
      tabName: 'Payments',
    },
    'fulfillment': {
      spreadsheetId: '1B7LvXJ-UZ4c4ltuzlk6HKGpNpCBBgUu_eaEaVZC5_us',
      tabName: 'Fulfillment',
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  STAGE → SHEET MAP
//  Pure function: every stage knows which sheet its leads live in.
//  Computed after module.exports so it can reference SPREADSHEET_ID, SHEETS,
//  SHEET_ROUTING, and STAGES from the exports object.
// ═══════════════════════════════════════════════════════════════════════════

module.exports.STAGE_TO_SHEET = {
  [module.exports.STAGES.NOT_ASSIGNED]:
    { spreadsheetId: module.exports.SPREADSHEET_ID, tabName: module.exports.SHEETS.DSR },
  [module.exports.STAGES.AGENT_WORKING]:
    { spreadsheetId: module.exports.SPREADSHEET_ID, tabName: module.exports.SHEETS.DSR },
  [module.exports.STAGES.SALES_REVIEW]:
    module.exports.SHEET_ROUTING['sales_review'] || null,
  [module.exports.STAGES.PAYMENT]:
    module.exports.SHEET_ROUTING['payment'] || null,
  [module.exports.STAGES.FULFILLMENT]:
    module.exports.SHEET_ROUTING['fulfillment'] || null,
  [module.exports.STAGES.COMPLETED]: null,
  [module.exports.STAGES.DEAD]:      null,
};

/**
 * Returns the sheet config for a given stage, or null if the stage has no sheet.
 * @param {string} stage — one of the STAGES values
 * @returns {{spreadsheetId: string, tabName: string}|null}
 */
module.exports.getSheetForStage = function(stage) {
  return module.exports.STAGE_TO_SHEET[stage] || null;
};