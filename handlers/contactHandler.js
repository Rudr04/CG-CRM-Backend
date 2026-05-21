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
const SheetService = require('../services/sheetsService');
const { shouldAssignRobo, deriveSource } = require('../utils/helpers');
const { ValidationError, ExternalServiceError, validateRequired, validatePhoneNumber } = require('../lib/errorHandler');
const config = require('../config');
const TaskService = require('../services/taskService');
const { buildWriteBoth, tryWriteOrQueue } = require('../lib/writeBoth');

const ONBOARDING_CHATBOTS = [
  '6a0d8be4ad26a69870ac7847',
  '69691e0302430341c43f1352',
];

const TEST_PHONES = new Set([
  '918469346151', // your test number
  '919825975070', // add more test numbers as needed
]);

// ═════════════════════════════════════════════════════════════
//  HANDLE NEW CONTACT (WATI: newContactMessageReceived)
// ═════════════════════════════════════════════════════════════
async function handleNewContact(params) {
  try {
    const phone = validatePhoneNumber(params.waId, { source: 'handleNewContact' });
    const name  = params.senderName || '';
    const ad    = config.getAdMapping(params.sourceId);

    // Side-effect: Smartflo sync (non-blocking, non-transactional)
    if (phone) {
      SmartfloService.createContact(phone, name, 'wati_new_contact')
        .catch(err => console.error(`[Smartflo] ${err.message}`));
    }

    // Transactional write: Firestore + Sheet
    const leadData = {
      phone, name, source: 'WhatsApp', status: config.DEFAULTS.STATUS,
      team: config.DEFAULTS.TEAM, inquiry: config.DEFAULTS.INQUIRY, channel: 'wati_new_contact',
      adCampaign: ad.adCampaign, adSet: ad.adSet,
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

    // Side-effect: WATI onboarding (non-transactional, fire-and-forget)
    triggerWatiOnboarding(phone);

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
  const ad    = config.getAdMapping(params.sourceId);

  const leadData = {
    phone, name: params.senderName || '', source: deriveSource(params),
    message: params.text || params.msg || '', team: config.DEFAULTS.TEAM,
    inquiry: config.DEFAULTS.INQUIRY, channel: 'interested_reply',
    adCampaign: ad.adCampaign, adSet: ad.adSet,
  };

  const writeFn = buildWriteBoth(leadData, {
    action: 'interested_reply', by: 'system', details: { source: leadData.source }
  });
  await tryWriteOrQueue(writeFn, `interested_${phone}_${Date.now()}`, {
    phone, handler: 'handleInterestedUser'
  });

  // Side-effect: WATI onboarding (non-transactional, fire-and-forget)
  triggerWatiOnboarding(phone);

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
  const ad   = config.getAdMapping(params.sourceId);

  const leadData = {
    phone, name: params.senderName || '', source: deriveSource(params),
    message: text, team, inquiry: config.DEFAULTS.INQUIRY, channel: 'advertisement',
    adCampaign: ad.adCampaign, adSet: ad.adSet,
  };

  const writeFn = buildWriteBoth(leadData, {
    action: 'lead_created', by: 'system', details: { source: leadData.source, channel: 'advertisement' }
  });
  await tryWriteOrQueue(writeFn, `advert_${phone}_${Date.now()}`, {
    phone, handler: 'handleAdvertisementContact'
  });

  // Side-effect: WATI onboarding (non-transactional, fire-and-forget)
  triggerWatiOnboarding(phone);

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

    // Side-effect: WATI onboarding (non-transactional, fire-and-forget)
    triggerWatiOnboarding(phone);

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
  const ad   = config.getAdMapping(params.sourceId);

  const leadData = {
    phone, name: params.senderName || '', source: deriveSource(params),
    message: `Keyword: ${text}`, inquiry: config.DEFAULTS.INQUIRY,
    channel: 'keyword_message',
    adCampaign: ad.adCampaign, adSet: ad.adSet,
  };

  const writeFn = buildWriteBoth(leadData, {
    action: 'lead_created', by: 'system', details: { source: leadData.source, keyword: text }
  });
  await tryWriteOrQueue(writeFn, `keyword_${phone}_${Date.now()}`, {
    phone, handler: 'handleKeywordContact'
  });

  // Side-effect: WATI onboarding (non-transactional, fire-and-forget)
  triggerWatiOnboarding(phone);

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
      phone, name: params.senderName || '',
      location: params.location || '',
      inquiry: params.inquiry || config.DEFAULTS.INQUIRY,
      product: params.product || '',
      source: params.source || 'Manual Entry',
      team: params.team || config.DEFAULTS.TEAM,
      remark: params.remark || '',
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
    currentStatus = sheetLead.data.status || '';
    currentTeam   = sheetLead.data.team   || config.DEFAULTS.TEAM;
  }

  const newStatus   = currentStatus.includes('Evening') ? config.FORM_OPTIONS.EVENING_GROUP_JOINED : config.FORM_OPTIONS.MORNING_GROUP_JOINED;
  const assignRobo  = currentTeam === config.DEFAULTS.TEAM;

  const fsUpdates = { status: newStatus };
  if (assignRobo) { fsUpdates.agent = config.DEFAULTS.ROBO_AGENT; fsUpdates.pipelineStage = config.DEFAULTS.ROBO_AGENT; }

  const customFirestore = async () => {
    await FirestoreService.updateLead(phone, fsUpdates, {
      action: 'community_joined', by: 'system',
      details: { status: newStatus, groupType: currentStatus.includes('Evening') ? 'evening' : 'morning' }
    });
  };

  const customSheet = async () => {
    if (sheetRow) {
      const colMap = await SheetService.getColumnMap(config.SHEETS.DSR);
      const M = colMap.map;
      const cellUpdates = { [M.status]: newStatus };
      if (assignRobo) cellUpdates[M.team] = config.DEFAULTS.ROBO_AGENT;
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
  try {triggerWatiOnboarding 
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

// ═════════════════════════════════════════════════════════════
//  HANDLE SCHEDULED FOLLOW-UP (from Cloud Tasks)
// ═════════════════════════════════════════════════════════════
async function handleScheduledFollowup(params) {
  const phone = params.phone;
  if (!phone) throw new ValidationError('Phone missing in scheduled task');

  console.log(`[FollowUp] Processing for ${phone}`);

  const result = await FirestoreService.findLeadByPhone(phone);
  const lead = result?.data;

  if (!lead) {
    console.log(`[FollowUp] Lead ${phone} not found — skipping`);
    return { status: 'skipped', reason: 'lead_not_found' };
  }

  const attr = lead.attributes || {};

  if (attr.mc_form_filled === true) {
    console.log(`[FollowUp] ${phone} filled form — skipping`);
    return { status: 'skipped', reason: 'form_filled' };
  }

  if (attr.callback_requested === true) {
    console.log(`[FollowUp] ${phone} requested callback — skipping`);
    return { status: 'skipped', reason: 'callback_requested' };
  }

  if (attr.followUp_sent === true) {
    console.log(`[FollowUp] ${phone} already received 3rd message — skipping`);
    return { status: 'skipped', reason: 'already_sent' };
  }

  await WatiService.sendTemplateMessage(phone, config.WATI.TEMPLATES.COURSE_DETAILS);

  await FirestoreService.updateLead(phone, { 'attributes.followUp_sent': true }, {
    action: 'followup_sent', by: 'scheduler',
    details: { template: config.WATI.TEMPLATES.COURSE_DETAILS }
  });

  TaskService.scheduleWebhookTask(
    `inactive-${phone}-${Date.now()}`,
    { eventType: 'scheduled_inactive_check', phone },
    600  // 24hrs after 3rd message (use 600 for testing)
  ).catch(e => console.error(`[Tasks] schedule inactive check: ${e.message}`));

  console.log(`[FollowUp] Template sent to ${phone}`);
  return { status: 'success', message: 'followup_sent' };
}

// ═════════════════════════════════════════════════════════════
//  HANDLE REACTIVATION (manual broadcast CTA: "I Want to Join Demo Class")
// ═════════════════════════════════════════════════════════════
async function handleReactivation(params) {
  const phone = validatePhoneNumber(params.waId, { source: 'handleReactivation' });
  console.log(`[Reactivation] Triggered for ${phone}`);

  await triggerWatiOnboarding(phone);

  return { status: 'success', message: 'reactivation_triggered' };
}

async function triggerWatiOnboarding(phone) {
  if (!TEST_PHONES.has(phone)) return;

  const existing = await FirestoreService.findLeadByPhone(phone);
  if (existing?.data) {
    const status = existing.data.status || '';
    if (config.CONVERTED_STATUSES.includes(status) || config.SEMI_CONVERTED_STATUSES.includes(status)) {
      console.log(`[Onboarding] ${phone} is converted/semi-converted (${status}) — skipping`);
      return;
    }
  }

  const waId = phone;

  FirestoreService.updateLead(phone, {
    'attributes.mc_form_filled': false,
    'attributes.callback_requested': false,
    'attributes.followUp_sent': false,
  }).catch(e => console.error(`[Firestore] init attributes: ${e.message}`));

  WatiService.setContactAttribute(waId, 'mc_form_filled', 'FALSE')
    .catch(e => console.error(`[WATI] mc_form_filled: ${e.message}`));

  WatiService.startChatbot(waId, '6a0d8be4ad26a69870ac7847')
    .then(() => WatiService.startChatbot(waId, '69691e0302430341c43f1352'))
    .catch(e => console.error(`[WATI] startChatbot chain: ${e.message}`));

  TaskService.scheduleWebhookTask(
    `followup-${phone}-${Date.now()}`,
    { eventType: config.EVENT_TYPES.SCHEDULED_FOLLOWUP, phone },
    config.CLOUD_TASKS.FOLLOWUP_DELAY_SEC
  ).catch(e => console.error(`[Tasks] schedule followup: ${e.message}`));
}

// ═════════════════════════════════════════════════════════════
//  HANDLE INACTIVE CHECK (48hrs after 3rd message)
// ═════════════════════════════════════════════════════════════
async function handleInactiveCheck(params) {
  const phone = params.phone;
  if (!phone) throw new ValidationError('Phone missing in scheduled task');

  console.log(`[InactiveCheck] Processing for ${phone}`);

  const result = await FirestoreService.findLeadByPhone(phone);
  const lead = result?.data;

  if (!lead) {
    console.log(`[InactiveCheck] Lead ${phone} not found — skipping`);
    return { status: 'skipped', reason: 'lead_not_found' };
  }

  const attr = lead.attributes || {};

  // Skip if they engaged after 3rd message
  if (attr.mc_form_filled === true || attr.callback_requested === true) {
    console.log(`[InactiveCheck] ${phone} engaged — skipping`);
    return { status: 'skipped', reason: 'lead_engaged' };
  }

  // Skip if already converted
  const status = lead.status || '';
  if (config.CONVERTED_STATUSES.includes(status) || config.SEMI_CONVERTED_STATUSES.includes(status)) {
    console.log(`[InactiveCheck] ${phone} converted — skipping`);
    return { status: 'skipped', reason: 'already_converted' };
  }

  // Mark inactive in Firestore
  await FirestoreService.updateLead(phone, {
    status: 'Inactive',
    agent: config.DEFAULTS.ROBO_AGENT,
  }, {
    action: 'marked_inactive', by: 'scheduler',
    details: { reason: 'no_response_48hrs' }
  });

  // Mark inactive in Sheet
  try {
    const existing = await SheetService.findByPhone(phone);
    if (existing) {
      const colMap = await SheetService.getColumnMap(config.SHEETS.DSR);
      const M = colMap.map;
      await SheetService.updateContactCells(existing.row, {
        [M.status]: 'Inactive',
        [M.team]: config.DEFAULTS.ROBO_AGENT,
      });
    }
  } catch (e) {
    console.error(`[InactiveCheck] Sheet update failed for ${phone}: ${e.message}`);
  }

  console.log(`[InactiveCheck] ${phone} marked Inactive + ROBO`);
  return { status: 'success', message: 'marked_inactive' };
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
  handleScheduledFollowup,
  handleReactivation,
  handleInactiveCheck,
};