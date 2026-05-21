// ============================================================================
//  formHandler.js — WhatsApp Form Submission Orchestrator
//
//  Uses shared buildWriteBoth from lib/writeBoth.js.
//  Custom writes for Firebase whitelist + Firestore + Sheet.
//  WATI confirmation is the only non-transactional side-effect.
// ============================================================================

const SheetService     = require('../services/sheetsService');
const FirestoreService = require('../services/firestoreService');
const WatiService      = require('../services/watiService');
const FirebaseService  = require('../services/firebaseService');
const config           = require('../config');
const { buildWriteBoth, tryWriteOrQueue } = require('../lib/writeBoth');


async function handleFormSubmission(params) {
  const phone   = params.wa_num || '';
  const name    = params.name || '';
  const option  = params.option || '';

  const statusValue = option === config.FORM_OPTIONS.EVENING_OPTION
    ? config.FORM_OPTIONS.EVENING_STATUS
    : config.FORM_OPTIONS.MORNING_STATUS;

  const whitelistPhone = phone; // Always use the messaging waId

  // Shared across firestore + sheet closures so the actual CGID flows from
  // the Firestore write into the Sheet write (instead of a row-1 formula).
  let cgId = null;

  // Custom Firestore write (whitelist + lead in one closure)
  const customFirestoreWrite = async () => {
    const errors = [];

    // Firebase RTDB whitelist (CRITICAL — user can't login without this)
    try {
      if (whitelistPhone && name) {
        await FirebaseService.addToWhitelist(whitelistPhone, name, 'whatsapp_form');
      }
    } catch (e) { errors.push(`whitelist: ${e.message}`); }

    // Firestore lead record
    try {
      const result = await FirestoreService.createOrUpdateLead({
        phone, name, status: statusValue, inquiry: config.DEFAULTS.INQUIRY,
      }, {
        action: 'form_submitted', by: 'system',
        details: { option, statusValue }
      });
      if (result?.cgId) cgId = result.cgId;
    } catch (e) { errors.push(`firestore: ${e.message}`); }

    if (errors.length) throw new Error(errors.join('; '));
  };

  // Custom Sheet write (upsert + cell updates)
  const customSheetWrite = async () => {
    const upsertResult = await SheetService.upsertContact({
      phone, name, cgId, source: 'WhatsApp',
      remark: `Form submitted: ${option}`, inquiry: config.DEFAULTS.INQUIRY,
    });
    const colMap = await SheetService.getColumnMap(config.SHEETS.DSR);
    const M = colMap.map;
    await SheetService.updateContactCells(upsertResult.row, {
      [M.name]:    name,
      [M.status]:  statusValue,
    });
    return upsertResult;
  };

  const writeFn = buildWriteBoth(null, null, customFirestoreWrite, customSheetWrite);
  await tryWriteOrQueue(writeFn, `form_${phone}_${Date.now()}`, {
    phone, handler: 'handleFormSubmission'
  });

  // Set mc_form_filled attribute
  FirestoreService.updateLead(phone, { 'attributes.mc_form_filled': true }, {
    action: 'mc_form_filled', by: 'system', details: { option: params.option }
  }).catch(e => console.error(`[Firestore] mc_form_filled: ${e.message}`));

  // WATI confirmation (only true side-effect — fire-and-forget)
  WatiService.sendRegistrationConfirmation(params)
    .catch(e => console.error(`[WATI] confirmation: ${e.message}`));

  return { status: 'form_update_success' };
}

// ═════════════════════════════════════════════════════════════
//  HANDLE CALLBACK FORM REPLY
// ═════════════════════════════════════════════════════════════
async function handleCallbackFormReply(customParams, phoneNumber) {
  const nameParam = customParams.find(p => p.name === config.WATI.CALLBACK_FORM_PARAMS.NAME);
  const timeParam = customParams.find(p => p.name === config.WATI.CALLBACK_FORM_PARAMS.TIME_SLOT);

  const name = nameParam?.value || '';
  const timeSlot = timeParam?.value || '';

  console.log(`Callback form: name=${name}, timeSlot=${timeSlot}, phone=${phoneNumber}`);

  const updates = {
    'attributes.callback_requested': true,
    status: 'Help',
    agent: config.DEFAULTS.TEAM,
  };
  if (name) updates.name = name;

  await FirestoreService.updateLead(phoneNumber, updates, {
    action: 'callback_requested', by: 'system',
    details: { name, timeSlot }
  });

  // Update sheet
  const colMap = await SheetService.getColumnMap(config.SHEETS.DSR);
  const M = colMap.map;
  const existing = await SheetService.findByPhone(phoneNumber);
  if (existing) {
    const cgid = existing.data.cgid || '';

    const cellUpdates = {
      [M.status]: 'Help',
      [M.team]: config.DEFAULTS.TEAM,
      [M.name]: name || existing.data.name || '',
      [M.cbReq]: timeSlot ||  '',
    };
    await SheetService.updateContactCells(existing.row, cellUpdates);

    // Threaded comment in sidebar — number + CGID
    await SheetService.addComment(
      existing.row,
      M.status,
      `Callback requested\nPhone: ${phoneNumber}\nCGID: ${cgid}\nTime: ${timeSlot}`
    );
  }

  // Send confirmation session message
  await WatiService.sendSessionMessage(
    phoneNumber,
    `Thank You for your response\nCosmo Counselor will *Call you shortly*\nwithin requested *Time Slot ${timeSlot}*`
  );

  return { status: 'callback_form_success', timeSlot };
}


async function handleFlowReply(params) {
  try {
    console.log('Processing flow reply');
    const phoneNumber = params.waId || params.wa_num || params.senderName;
    if (!phoneNumber) throw new Error('Phone number not found');

    const contactData = await WatiService.getContactDetails(phoneNumber);
    if (!contactData?.contact) throw new Error('Failed to get contact details');

    const customParams = contactData.contact.customParams || [];

    // Check which form was filled by param presence
    const hasMcForm = customParams.some(
      p => p.name === config.WATI.FORM_PARAMS.NAME && p.value
    );
    const hasCallbackForm = customParams.some(
      p => p.name === config.WATI.CALLBACK_FORM_PARAMS.NAME && p.value
    );

    if (hasCallbackForm) {
      console.log('Callback form detected');
      return await handleCallbackFormReply(customParams, phoneNumber);
    }

    if (hasMcForm) {
      console.log('MC registration form detected');
      const formData = _extractFormDataFromContact(contactData.contact, phoneNumber);
      if (!formData) throw new Error('Required form data not found');
      return await handleFormSubmission(formData);
    }

    throw new Error('Unknown flow reply — no matching form params');
  } catch (error) {
    console.error(`Flow reply error: ${error.message}`);
    throw error;
  }
}


function _extractFormDataFromContact(contact, phoneNumber) {
  const customParams = contact.customParams || [];
  const nameParam   = customParams.find(p => p.name === config.WATI.FORM_PARAMS.NAME);
  const optionParam = customParams.find(p => p.name === config.WATI.FORM_PARAMS.OPTION);

  if (!nameParam || !optionParam) return null;

  return {
    wa_num:   phoneNumber,
    name:     nameParam.value,
    option:   optionParam.value,
  };
}


module.exports = {
  handleFormSubmission,
  handleFlowReply,
  handleCallbackFormReply
};