// ============================================================================
//  lib/router.js — Event Router (Strategy Pattern)
//
//  Replaces if-else chains with object-based routing.
//  Open-Closed Principle: Add new routes by adding to ROUTES object,
//  not by modifying routing logic.
//
//  USAGE:
//    const { routeEvent } = require('./lib/router');
//    const result = await routeEvent(params);
// ============================================================================

const config = require('../config');
const { 
  containsFuzzyKeywords, 
  isFromAdvertisement, 
  fuzzyMatchesRegistrationCheck 
} = require('../utils/helpers');


// ═══════════════════════════════════════════════════════════════════════════
//  LAZY HANDLER LOADING
//  Avoids circular dependencies by loading handlers on first use
// ═══════════════════════════════════════════════════════════════════════════

let _handlers = null;

function getHandlers() {
  if (!_handlers) {
    _handlers = {
      contact: require('../handlers/contactHandler'),
      form: require('../handlers/formHandler'),
      payment: require('../handlers/paymentHandler'),
      sync: require('../handlers/syncHandler'),
    };
  }
  return _handlers;
}


// ═══════════════════════════════════════════════════════════════════════════
//  ROUTE DEFINITIONS
//  Each route: { match: (params) => boolean, handler: async (params) => result }
//  Routes are checked in order - first match wins
// ═══════════════════════════════════════════════════════════════════════════

const ROUTES = [
  // ─── Sheet → Firestore Sync ───────────────────────────────────────────────
  {
    name: 'sheet_edit',
    match: (p) => p.eventType === config.EVENT_TYPES.SHEET_EDIT,
    handler: async (p) => getHandlers().sync.handleSheetEdit(p),
    skipDuplicate: true,
  },

  // ─── User Login (Attendance) ──────────────────────────────────────────────
  {
    name: 'user_login',
    match: (p) => p.event === config.EVENT_TYPES.USER_LOGIN,
    handler: async (p) => getHandlers().contact.handleUserLogin(p),
    skipDuplicate: true,
  },

  // ─── Web Form ─────────────────────────────────────────────────────────────
  {
    name: 'web_form',
    match: (p) => p.eventType === config.EVENT_TYPES.CG_WEB,
    handler: async (p) => getHandlers().contact.handleWebForm(p),
  },

  // ─── New WATI Contact ─────────────────────────────────────────────────────
  {
    name: 'new_contact',
    match: (p) => p.eventType === config.EVENT_TYPES.NEW_CONTACT,
    handler: async (p) => getHandlers().contact.handleNewContact(p),
  },

  // ─── Registration Check (before fuzzy keywords) ───────────────────────────
  {
    name: 'registration_check',
    match: (p) => p.eventType === config.EVENT_TYPES.MESSAGE && 
                  p.text && 
                  fuzzyMatchesRegistrationCheck(p.text),
    handler: async (p) => getHandlers().contact.handleRegistrationCheck(p),
  },

  // ─── Keyword Message ──────────────────────────────────────────────────────
  {
    name: 'keyword_message',
    match: (p) => p.eventType === config.EVENT_TYPES.MESSAGE && 
                  p.text && 
                  containsFuzzyKeywords(p.text),
    handler: async (p) => getHandlers().contact.handleKeywordContact(p),
  },

  // ─── Advertisement Contact ────────────────────────────────────────────────
  {
    name: 'advertisement',
    match: (p) => isFromAdvertisement(p.sourceUrl),
    handler: async (p) => getHandlers().contact.handleAdvertisementContact(p),
  },

  // ─── Manual CRM Entry ─────────────────────────────────────────────────────
  {
    name: 'manual_entry',
    match: (p) => p.eventType === config.EVENT_TYPES.CRM_ENTRY,
    handler: async (p) => getHandlers().contact.handleManualEntry(p),
  },

  // ─── Interested User (List Reply) ─────────────────────────────────────────
  {
    name: 'interested_user',
    match: (p) => p.listReply?.id === config.LIST_REPLY_IDS.INTERESTED,
    handler: async (p) => getHandlers().contact.handleInterestedUser(p),
  },

  // ─── WhatsApp Flow Reply ──────────────────────────────────────────────────
  {
    name: 'flow_reply',
    match: (p) => p.type === 'whatsapp_flow_reply',
    handler: async (p) => getHandlers().form.handleFlowReply(p),
  },

  // ─── Form Filled ──────────────────────────────────────────────────────────
  {
    name: 'form_filled',
    match: (p) => p.eventType === config.EVENT_TYPES.FORM_FILLED,
    handler: async (p) => getHandlers().form.handleFormSubmission(p),
  },

  // ─── Payment Received ─────────────────────────────────────────────────────
  {
    name: 'payment',
    match: (p) => p.eventType === config.EVENT_TYPES.PAYMENT,
    handler: async (p) => getHandlers().payment.handlePayment(p),
  },

  // ─── Community Group Join ─────────────────────────────────────────────────
  {
    name: 'group_join',
    match: (p) => p.eventType === config.EVENT_TYPES.GRP_JOIN,
    handler: async (p) => getHandlers().contact.handleCommunityJoin(p),
  },
];


// ═══════════════════════════════════════════════════════════════════════════
//  ROUTER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find matching route for params
 * @param {object} params - Webhook payload
 * @returns {{ route: object, name: string } | null}
 */
function findRoute(params) {
  for (const route of ROUTES) {
    if (route.match(params)) {
      return { route, name: route.name };
    }
  }
  return null;
}

/**
 * Route event to appropriate handler
 * @param {object} params - Webhook payload
 * @returns {Promise<{ handled: boolean, result?: any, routeName?: string, skipDuplicate?: boolean }>}
 */
async function routeEvent(params) {
  const match = findRoute(params);
  
  if (!match) {
    const eventType = params.eventType || params.event_type || params.type || 'unknown';
    console.log(`[Router] No handler for: ${eventType}`);
    return { 
      handled: false, 
      result: { message: 'event_ignored' } 
    };
  }

  console.log(`[Router] Matched: ${match.name}`);
  
  const result = await match.route.handler(params);
  
  return {
    handled: true,
    result,
    routeName: match.name,
    skipDuplicate: match.route.skipDuplicate || false,
  };
}

/**
 * Check if route should skip duplicate check
 * @param {object} params - Webhook payload
 * @returns {boolean}
 */
function shouldSkipDuplicate(params) {
  const match = findRoute(params);
  return match?.route?.skipDuplicate || false;
}


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  routeEvent,
  findRoute,
  shouldSkipDuplicate,
  ROUTES,  // Export for testing/introspection
};