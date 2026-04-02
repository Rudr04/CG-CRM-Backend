// ============================================================================
//  contactHandler.js — Lead Event Orchestrator
//
//  Every handler writes to BOTH Firestore and Sheet.
//  If either fails, the operation is queued for in-memory retry.
//  writeBoth tracks what succeeded — retries only run the failed part.
// ============================================================================

const SheetService     = require('../services/sheetsService');
const FirestoreService = require('../services/firestoreService');
const WatiService      = require('../services/watiService');
const FirebaseService  = require('../services/firebaseService');
const SmartfloService  = require('../services/smartfloService');
const PendingQueue     = require('../services/pendingQueue');
const { shouldAssignRobo, deriveSource } = require('../utils/helpers');
const { ValidationError, ExternalServiceError, validateRequired, validatePhoneNumber } = require('../lib/errorHandler');
const config = require('../config');

// Shared write abstraction (was defined locally, now shared with formHandler)
const { buildWriteBoth, tryWriteOrQueue } = require('../lib/writeBoth');


// ═════════════════════════════════════════════════════════════
//  HANDLE NEW CONTACT (WATI: newContactMessageReceived)
// ═════════════════════════════════════════════════════════════
async function handleNewContact(params) {
  try {
    const phone = validatePhoneNumber(params.waId, { source: 'handleNewContact' });
    const name  = params.senderName || '';

    // Side-effect: Smartflo sync (non-blocking, non-transactional)
    if (phone) {
      SmartfloService.createContact(phone, name, 'wati_new_contact')
        .catch(err => console.error(`[Smartflo] ${err.message}`));
    }

    // Transactional write: Firestore + Sheet
    const leadData = {
      phone, name, source: 'WhatsApp', status: config.DEFAULTS.STATUS,
      team: config.DEFAULTS.TEAM, inquiry: config.DEFAULTS.INQUIRY, channel: 'wati_new_contact',
    };

    const writeFn = buildWriteBoth(leadData, {
      action: 'lead_created', by: 'system', details: { source: 'WhatsApp', channel: 'wati_new_contact' }
    });
    await tryWriteOrQueue(writeFn, `newContact_${phone}_${Date.now()}`, {
      phone, handler: 'handleNewContact'
    });

    // Side-effect: WATI attribute (non-transactional)
    try { await WatiService.setWaidAttribute(params); }
    catch (e) { console.error(`[WATI] setWaidAttribute: ${e.message}`); }

    return { status: 'success', message: 'New contact processed' };

  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ExternalServiceError(error.message, 'Contact', { handler: 'handleNewContact' });
  }
}


// ═════════════════════════════════════════════════════════════
//  HANDLE INTERESTED USER (listReply: EPXcDmp)
// ═════════════════════════════════════════════════════════════
async function handleInterestedUser(params) {
  console.log('For Learning selected');
  const phone = validatePhoneNumber(params.waId, { source: 'handleInterestedUser' });

  const leadData = {
    phone, name: params.senderName || '', source: deriveSource(params),
    message: params.text || params.msg || '', team: config.DEFAULTS.TEAM,
    inquiry: config.DEFAULTS.INQUIRY, channel: 'interested_reply',
  };

  const writeFn = buildWriteBoth(leadData, {
    action: 'interested_reply', by: 'system', details: { source: leadData.source }
  });
  await tryWriteOrQueue(writeFn, `interested_${phone}_${Date.now()}`, {
    phone, handler: 'handleInterestedUser'
  });

  return { status: 'success' };
}


// ═════════════════════════════════════════════════════════════
//  HANDLE ADVERTISEMENT CONTACT
// ═════════════════════════════════════════════════════════════
async function handleAdvertisementContact(params) {
  console.log('Contact from advertise');
  const phone = validatePhoneNumber(params.waId, { source: 'handleAdvertisementContact' });
  const text = params.text || '';
  const team = shouldAssignRobo(text) ? config.DEFAULTS.ROBO_AGENT : config.DEFAULTS.TEAM;

  const leadData = {
    phone, name: params.senderName || '', source: deriveSource(params),
    message: text, team, inquiry: config.DEFAULTS.INQUIRY, channel: 'advertisement',
  };

  const writeFn = buildWriteBoth(leadData, {
    action: 'lead_created', by: 'system', details: { source: leadData.source, channel: 'advertisement' }
  });
  await tryWriteOrQueue(writeFn, `advert_${phone}_${Date.now()}`, {
    phone, handler: 'handleAdvertisementContact'
  });

  return { status: 'success' };
}


// ═════════════════════════════════════════════════════════════
//  HANDLE WEB FORM (CGI_Web_Form)
// ═════════════════════════════════════════════════════════════
async function handleWebForm(params) {
  try {
    console.log('Web Form Submission received');
    validateRequired(params, ['name', 'phone'], { source: 'handleWebForm' });
    const phone = validatePhoneNumber(params.phone, { source: 'handleWebForm' });

    const leadData = {
      phone, name: params.name || '', location: params.state || '',
      source: 'CGI Web Form', inquiry: config.DEFAULTS.INQUIRY, team: config.DEFAULTS.TEAM,
      channel: 'web_form',
    };

    const writeFn = buildWriteBoth(leadData, {
      action: 'lead_created', by: 'system', details: { source: 'CGI Web Form' }
    });
    await tryWriteOrQueue(writeFn, `webform_${phone}_${Date.now()}`, {
      phone, handler: 'handleWebForm'
    });

    return { status: 'success' };

  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ExternalServiceError(error.message, 'WebForm', { handler: 'handleWebForm' });
  }
}


// ═════════════════════════════════════════════════════════════
//  HANDLE KEYWORD CONTACT (fuzzy keyword message match)
// ═════════════════════════════════════════════════════════════
async function handleKeywordContact(params) {
  console.log('Contact from keyword message');
  const phone = validatePhoneNumber(params.waId, { source: 'handleKeywordContact' });
  const text = params.text || '';
  const team = shouldAssignRobo(text) ? config.DEFAULTS.ROBO_AGENT : config.DEFAULTS.TEAM;

  const leadData = {
    phone, name: params.senderName || '', source: deriveSource(params),
    message: `Keyword: ${text}`, team, inquiry: config.DEFAULTS.INQUIRY,
    channel: 'keyword_message',
  };

  const writeFn = buildWriteBoth(leadData, {
    action: 'lead_created', by: 'system', details: { source: leadData.source, keyword: text }
  });
  await tryWriteOrQueue(writeFn, `keyword_${phone}_${Date.now()}`, {
    phone, handler: 'handleKeywordContact'
  });

  return { status: 'success' };
}


// ═════════════════════════════════════════════════════════════
//  HANDLE MANUAL ENTRY (from Apps Script form: Manually_Entry)
// ═════════════════════════════════════════════════════════════
async function handleManualEntry(params) {
  try {
    console.log('Processing manual entry from AppScript');
    validateRequired(params, ['senderName', 'waId'], { source: 'handleManualEntry' });
    const phone = validatePhoneNumber(params.waId, { source: 'handleManualEntry' });

    const leadData = {
      phone, name: params.senderName || '', location: params.location || '',
      inquiry: params.inquiry || 'CGI', product: params.product || '',
      source: params.source || 'Manual Entry',
      team: params.team || config.DEFAULTS.TEAM, remark: params.remark || '',
      channel: 'manual_entry',
    };

    const writeFn = buildWriteBoth(leadData, {
      action: 'manual_entry', by: 'system', details: { source: leadData.source }
    });
    await tryWriteOrQueue(writeFn, `manual_${phone}_${Date.now()}`, {
      phone, handler: 'handleManualEntry'
    });

    return { status: 'success', message: 'Manual inquiry added' };

  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ExternalServiceError(error.message, 'Sheet', { handler: 'handleManualEntry' });
  }
}


// ═════════════════════════════════════════════════════════════
//  HANDLE COMMUNITY JOIN (GRP_LINK_CLICK)
// ═════════════════════════════════════════════════════════════
async function handleCommunityJoin(params) {
  const phone = params.wa_num || '';
  if (!phone) throw new Error('Phone missing in community join');

  // Look up lead: try Firestore first, then Sheet
  let currentStatus = '';
  let currentTeam   = config.DEFAULTS.TEAM;
  let sheetRow      = null;

  let firestoreLead = null;
  try {
    firestoreLead = await FirestoreService.findLeadByPhone(phone);
  } catch (e) {
    console.warn(`[CommunityJoin] Firestore lookup failed, falling back to Sheet: ${e.message}`);
  }

  if (firestoreLead) {
    currentStatus = firestoreLead.data.status || '';
    currentTeam   = firestoreLead.data.agent || config.DEFAULTS.TEAM;
    sheetRow      = firestoreLead.data.sheetRow || null;
  } else {
    const sheetLead = await SheetService.findByPhone(phone);
    if (!sheetLead) {
      console.warn(`[CommunityJoin] Phone not found in Firestore or Sheet: ${phone}`);
      throw new ValidationError('Phone not found in CRM', { phone, handler: 'handleCommunityJoin' });
    }
    sheetRow      = sheetLead.row;
    currentStatus = sheetLead.data[config.SHEET_COLUMNS.STATUS] || '';
    currentTeam   = sheetLead.data[config.SHEET_COLUMNS.TEAM]   || config.DEFAULTS.TEAM;
  }

  const newStatus   = currentStatus.includes('Online') ? config.FORM_OPTIONS.ONLINE_GROUP_JOINED : config.FORM_OPTIONS.OFFLINE_GROUP_JOINED;
  const assignRobo  = currentTeam === config.DEFAULTS.TEAM;

  const fsUpdates = { status: newStatus };
  if (assignRobo) { fsUpdates.agent = config.DEFAULTS.ROBO_AGENT; fsUpdates.stage = config.DEFAULTS.ROBO_AGENT; }

  const customFirestore = async () => {
    await FirestoreService.updateLead(phone, fsUpdates, {
      action: 'community_joined', by: 'system',
      details: { status: newStatus, groupType: currentStatus.includes('Online') ? 'online' : 'ahmedabad' }
    });
  };

  const customSheet = async () => {
    if (sheetRow) {
      const C = config.SHEET_COLUMNS;
      const cellUpdates = { [C.STATUS]: newStatus };
      if (assignRobo) cellUpdates[C.TEAM] = config.DEFAULTS.ROBO_AGENT;
      await SheetService.updateContactCells(sheetRow, cellUpdates);
    }
  };

  const writeFn = buildWriteBoth(null, null, customFirestore, customSheet);
  await tryWriteOrQueue(writeFn, `community_${phone}_${Date.now()}`, {
    phone, handler: 'handleCommunityJoin'
  });

  return { message: 'Community join tracked', status: newStatus };
}


// ═════════════════════════════════════════════════════════════
//  HANDLE REGISTRATION CHECK (unchanged — no lead create/update)
// ═════════════════════════════════════════════════════════════
async function handleRegistrationCheck(params) {
  try {
    const waId = validatePhoneNumber(params.waId, { source: 'handleRegistrationCheck' });
    const senderName = params.senderName || '';

    console.log(`Registration check for: ${waId}`);

    const registeredNumber = await SheetService.checkFirebaseWhitelist(waId);

    if (registeredNumber) {
      console.log(`${waId} already whitelisted with registered number: ${registeredNumber}`);
      await WatiService.sendSessionMessage(
        waId,
        `*${registeredNumber}* is your registration number\n\nUse this to join the MasterClass\n\nCosmoGuru.live`
      );
      return { message: 'already_whitelisted', registeredNumber };
    }

    console.log(`${waId} not whitelisted – adding now`);

    const whitelistFn = async () => {
      await FirebaseService.addToWhitelist(waId, senderName || waId, 'self_registration');
    };

    let whitelistSuccess = false;
    try {
      await whitelistFn();
      whitelistSuccess = true;
    } catch (fbError) {
      PendingQueue.enqueue(`whitelist_${waId}_${Date.now()}`, whitelistFn, {
        phone: waId, handler: 'handleRegistrationCheck_whitelist'
      });
      console.error(`[Registration] Whitelist failed, queued for retry: ${fbError.message}`);
    }

    if (whitelistSuccess) {
      await WatiService.sendSessionMessage(
        waId,
        `You were not registered in our system,\nbut we have registered you right now *${waId}*.\n\n*You are now Registered! ✓*`
      );
      return { message: 'newly_whitelisted', registeredNumber: waId };
    } else {
      await WatiService.sendSessionMessage(
        waId,
        `We are processing your registration. Please try again in a few minutes.`
      );
      return { message: 'whitelist_queued', registeredNumber: waId };
    }

  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ExternalServiceError(error.message, 'Registration', { handler: 'handleRegistrationCheck' });
  }
}


// ═════════════════════════════════════════════════════════════
//  HANDLE USER LOGIN (unchanged — different sheet, attendance only)
// ═════════════════════════════════════════════════════════════
async function handleUserLogin(params) {
  try {
    console.log('User login event received from CosmoGuru Live');
    const phone = params.data?.phone || '';
    const name  = params.data?.name || '';
    const loginTimestamp = params.data?.loginTimestamp || '';

    const phoneNumber = validatePhoneNumber(phone, { source: 'handleUserLogin' });
    const result = await SheetService.updateAttendance(phoneNumber, name, loginTimestamp);

    return { status: 'success', message: 'Attendance updated', ...result };

  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ExternalServiceError(error.message, 'Attendance', { handler: 'handleUserLogin' });
  }
}


module.exports = {
  handleNewContact,
  handleInterestedUser,
  handleAdvertisementContact,
  handleWebForm,
  handleKeywordContact,
  handleManualEntry,
  handleCommunityJoin,
  handleRegistrationCheck,
  handleUserLogin,
};