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
//  SHEET COLUMN INDICES (0-based) — SINGLE SOURCE OF TRUTH
// ═══════════════════════════════════════════════════════════════════════════

const SHEET_COLUMNS = {
  CGILN: 0,
  DATE: 1,
  TIME: 2,
  NAME: 3,
  NUMBER: 4,
  REGI_NO: 5,
  LOCATION: 6,
  PRODUCT: 7,
  MESSAGE: 8,
  SOURCE: 9,
  TEAM: 10,
  STATUS: 11,
  RATING: 12,
  CB_DATE: 13,
  REMARK: 14,
  TEAM_2: 15,
  STATUS_2: 16,
  REMARK_2: 17,
  CONF_CB_PRIORITY: 18,
  CONFIRMATION: 19,
  JOIN_POLL: 20,
  NO_WITHOUT_91: 21,
  DAY: 22,
  HOURS: 23,
  CONVERTED: 24,
  ATTENDANCE: 25,
  INTERACTION: 26
};

// ═══════════════════════════════════════════════════════════════════════════
//  COLUMN UTILITIES — derive everything from SHEET_COLUMNS
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

// 0-based index → column letter, auto-generated from SHEET_COLUMNS
const COLUMN_LETTERS = {};
for (const [name, idx] of Object.entries(SHEET_COLUMNS)) {
  COLUMN_LETTERS[name] = colLetter(idx);
}


// ═══════════════════════════════════════════════════════════════════════════
//  TRACKED FIELDS — complete mapping for Sheet↔Firestore sync
//  Keys are SHEET_COLUMNS indices. Single source for:
//    - which columns trigger sync (GAS onEdit checks this)
//    - GAS field name sent in payload
//    - Firestore field name written to doc
//    - history action logged in history[] array
// ═══════════════════════════════════════════════════════════════════════════

const TRACKED_FIELDS = {
  [SHEET_COLUMNS.NAME]:     { sheetField: 'name',     firestoreField: 'name',     historyAction: 'name_updated' },
  [SHEET_COLUMNS.LOCATION]: { sheetField: 'location', firestoreField: 'location', historyAction: 'location_updated' },
  [SHEET_COLUMNS.TEAM]:     { sheetField: 'team',     firestoreField: 'agent',    historyAction: 'claimed' },
  [SHEET_COLUMNS.STATUS]:   { sheetField: 'status',   firestoreField: 'status',   historyAction: 'status_changed' },
  [SHEET_COLUMNS.RATING]:   { sheetField: 'rating',   firestoreField: 'rating',   historyAction: 'rating_changed' },
  [SHEET_COLUMNS.REMARK]:   { sheetField: 'remark',   firestoreField: 'remark',   historyAction: 'remark_added' },
  [SHEET_COLUMNS.TEAM_2]:   { sheetField: 'team_2',   firestoreField: 'team2',    historyAction: 'team_2_changed' },
  [SHEET_COLUMNS.STATUS_2]: { sheetField: 'status_2', firestoreField: 'status2',  historyAction: 'status_2_changed' },
  [SHEET_COLUMNS.REMARK_2]: { sheetField: 'remark_2', firestoreField: 'remark2',  historyAction: 'remark_2_added' },
};

// Auto-generated lookup maps from TRACKED_FIELDS
const SHEET_TO_FIRESTORE = {};
const HISTORY_ACTIONS = {};

for (const [colIdx, mapping] of Object.entries(TRACKED_FIELDS)) {
  SHEET_TO_FIRESTORE[mapping.sheetField] = mapping.firestoreField;
  HISTORY_ACTIONS[mapping.sheetField] = mapping.historyAction;
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
  },

  // ─── Firebase RTDB (Whitelist only) ───────────────────────────────────────
  FIREBASE: {
    DATABASE_URL: process.env.FIREBASE_DATABASE_URL || '',
    SECRET: process.env.FIREBASE_SECRET || '',
  },

  // ─── Firestore (CRM Database) ─────────────────────────────────────────────
  FIRESTORE: {
    COLLECTION: 'leads',
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
    NOT_ASSIGNED: 'unclaimed',
    AGENT_WORKING: 'agent_working',
    SALES_REVIEW: 'sales_review',
    PAYMENT_PENDING: 'payment_pending',
    DELIVERY: 'delivery',
    COMPLETED: 'completed',
    DEAD: 'dead'
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
    USER_LOGIN: 'user_login',
    MESSAGE: 'message',
  },

  // ─── List Reply IDs ───────────────────────────────────────────────────────
  LIST_REPLY_IDS: {
    INTERESTED: 'EPXcDmp'
  },

  // ─── Sheet Columns ─────────────────────────────────────────────────────────
  SHEET_COLUMNS,         // 0-based indices: { NAME: 3, STATUS: 11, ... }
  COLUMN_LETTERS,        // auto-generated: { NAME: 'D', STATUS: 'L', ... }
  colLetter,             // utility: colLetter(3) → 'D'

  // ─── Field Sync Mappings ────────────────────────────────────────────────────
  TRACKED_FIELDS,        // full mapping: colIdx → { sheetField, firestoreField, historyAction }
  SHEET_TO_FIRESTORE,    // auto-generated: { 'team': 'agent', 'status': 'status', ... }
  HISTORY_ACTIONS,       // auto-generated: { 'team': 'claimed', 'status': 'status_changed', ... }

  // ─── Defaults ─────────────────────────────────────────────────────────────
  DEFAULTS: {
    STATUS: 'Lead',
    TEAM: 'Not Assigned',
  }
};