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
    ENABLED: process.env.FIRESTORE_ENABLED !== 'false'
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
    NOT_ASSIGNED: 'Not Assigned',
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

  // ─── Sheet Column Indices (0-based) ───────────────────────────────────────
  SHEET_COLUMNS: {
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
  },

  // ─── Defaults ─────────────────────────────────────────────────────────────
  DEFAULTS: {
    PRODUCT: 'CGI',
    STATUS: 'Lead',
    TEAM: 'Not Assigned',
  }
};