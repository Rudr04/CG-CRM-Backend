// Validate required environment variables
const requiredEnvVars = [
  'SPREADSHEET_ID',
  'WATI_TENANT_ID', 
  'WATI_BEARER_TOKEN',
  'WATI_BASE_URL'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('CRITICAL: Missing environment variables:', missingVars);
  console.error('Set these in Cloud Console or your .env file');
}

module.exports = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  SHEETS: {
    DSR: 'Sheet5',
    PAID: 'Paid_Users',
    MANUAL_REVIEW: 'Manual_Review',
    FIREBASE_WHITELIST: 'OnlineAttendence'
  },
  WATI: {
    TENANT_ID: process.env.WATI_TENANT_ID,
    BEARER_TOKEN: process.env.WATI_BEARER_TOKEN,
    BASE_URL: process.env.WATI_BASE_URL
  },
  FIREBASE: {
    DATABASE_URL: process.env.FIREBASE_DATABASE_URL || '',
    SECRET: process.env.FIREBASE_SECRET             || '',
    PATHS: {
      WHITELIST: 'whitelist'
    }
  },

  // ─── Firestore (CRM database) ─────────────────────────────
  // Phase 1: parallel write alongside Sheets
  // Phase 2+: Firestore becomes source of truth
  FIRESTORE: {
    COLLECTION: 'leads',
    ENABLED: process.env.FIRESTORE_ENABLED !== 'false'  // on by default, set 'false' to disable
  },

  SMARTFLO: {
    API_KEY:          process.env.SMARTFLO_API_KEY          || '',
    CONTACT_GROUP_ID: process.env.SMARTFLO_CONTACT_GROUP_ID || ''
  },
  SERIAL_NUMBER_START: 210001,

  // ─── Pipeline stages ──────────────────────────────────────
  // "Not Assigned" = unclaimed. Agent changes Team cell to their name = claimed.
  STAGES: {
    NOT_ASSIGNED:    'Not Assigned',
    AGENT_WORKING:   'agent_working',    // agent claimed it (Team = agent name)
    SALES_REVIEW:    'sales_review',
    PAYMENT_PENDING: 'payment_pending',
    DELIVERY:        'delivery',
    COMPLETED:       'completed',
    DEAD:            'dead'
  },

  EVENT_TYPES: {
    NEW_CONTACT: 'newContactMessageReceived',
    FORM_FILLED: 'MC_FormFilled',
    PAYMENT: 'Payment_Received',
    GRP_JOIN: 'GRP_LINK_CLICK',
    CG_Web: 'CGI_Web_Form',
    CRM_Entry: 'Manually_Entry'
  },
  LIST_REPLY_IDS: {
    INTERESTED: 'EPXcDmp'
  },
  SHEET_COLUMNS: {
    CGILN: 0, DATE: 1, TIME: 2, NAME: 3, NUMBER: 4, REGI_NO: 5,
    LOCATION: 6, PRODUCT: 7, MESSAGE: 8, SOURCE: 9, TEAM: 10, STATUS: 11,
    RATING: 12, REMARK: 14, TEAM_2: 15, STATUS_2: 16, REMARK_2: 17,
    CONF_CB_PRIORITY: 18, CONFIRMATION: 19, JOIN_POLL: 20, NO_WITHOUT_91: 21,
    DAY: 22, HOURS: 23, CONVERTED: 24, ATTENDANCE: 25, INTERACTION: 26
  }
};
