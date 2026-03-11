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

  // ─── Sheet Column Indices (0-based) — Legacy Sheet5 ──────────────────────
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

  // ─── Field Definitions (Firestore key → Sheet header) ──────────────────
  FIELD_DEFS: {
    cgid:            'CGID',
    date:            'Date',
    time:            'Time',
    name:            'Name',
    mobile:          'Mobile Number',
    location:        'Location',
    inq:             'Inquiry',
    product:         'Product',
    source:          'Source',
    team:            'Team',
    status:          'Status',
    rating:          'Rating',
    remark:          'Remark',
    cbDate:          'CB Date',
    stage:           'Stage',
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
    deliveryStatus:  'Delivery Status',
    deliveryDate:    'Delivery Date',
    deliveryRemark:  'Delivery Remark',
  },

  // ─── Sheet Schemas (which fields each sheet shows, in order) ───────────
  SHEET_SCHEMAS: {
    AGENTS: [
      'cgid','date','time','name','mobile','location',
      'inq','product','source','team','status','rating',
      'remark','cbDate','stage'
    ],
    SALES: [
      'cgid','date','name','mobile','location',
      'inq','product','source','team','status','rating',
      'remark','salesRemark','approvalDate','stage'
    ],
    PAYMENTS: [
      'cgid','name','mobile','product','quantity',
      'productPrice','amountPaid','pendingAmount','modeOfPay',
      'paymentRefId','dateOfPayment','receivedAccount','remark','stage'
    ],
    DELIVERY: [
      'cgid','name','mobile','product','quantity',
      'amountPaid','deliveryStatus','deliveryDate','remark','stage'
    ],
    MASTER: [
      'cgid','date','time','name','mobile','location',
      'inq','product','source','team','status','rating',
      'remark','cbDate','stage',
      'salesRemark','approvalDate',
      'quantity','productPrice','amountPaid','pendingAmount',
      'modeOfPay','paymentRefId','dateOfPayment','receivedAccount',
      'deliveryStatus','deliveryDate','deliveryRemark'
    ],
  },

  // ─── Defaults ─────────────────────────────────────────────────────────────
  DEFAULTS: {
    STATUS: 'Lead',
    TEAM: 'Not Assigned',
    PRODUCT: 'CGI'
  },

  // ─── Multi-Spreadsheet Sync Targets (Phase 3) ────────────────────────────
  // Each target maps stage(s) to a specific spreadsheet with a role + tab name
  SYNC_TARGETS: [
    {
      id: process.env.SHEET_AGENTS_ID || process.env.SPREADSHEET_ID,
      role: 'AGENTS',
      sheet: process.env.SHEET_AGENTS_TAB || 'Sheet5',
      filter: (stage) => ['unclaimed', 'Not Assigned', 'agent_working'].includes(stage),
    },
    {
      id: process.env.SHEET_SALES_ID || '',
      role: 'SALES',
      sheet: process.env.SHEET_SALES_TAB || 'Review',
      filter: (stage) => stage === 'sales_review',
    },
    {
      id: process.env.SHEET_PAYMENTS_ID || '',
      role: 'PAYMENTS',
      sheet: process.env.SHEET_PAYMENTS_TAB || 'Payments',
      filter: (stage) => stage === 'payment_pending',
    },
    {
      id: process.env.SHEET_DELIVERY_ID || '',
      role: 'DELIVERY',
      sheet: process.env.SHEET_DELIVERY_TAB || 'Delivery',
      filter: (stage) => stage === 'delivery',
    },
    {
      id: process.env.SHEET_MASTER_ID || '',
      role: 'MASTER',
      sheet: process.env.SHEET_MASTER_TAB || 'All',
      filter: () => true,
    },
  ],

  // ─── Allowed Stage Transitions (Phase 3) ─────────────────────────────────
  // Map of: currentStage → [allowed next stages]
  ALLOWED_TRANSITIONS: {
    'unclaimed': ['agent_working', 'dead'],
    'Not Assigned': ['agent_working', 'dead'],
    'agent_working': ['sales_review', 'dead'],
    'sales_review': ['payment_pending', 'agent_working', 'dead'],
    'payment_pending': ['delivery', 'sales_review'],
    'delivery': ['completed'],
    'completed': [],
    'dead': ['unclaimed'],
  },
};