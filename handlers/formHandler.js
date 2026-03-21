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
  const formNum = params.form_num || '';

  const statusValue = option === "Offline (અમદાવાદ ક્લાસ માં)"
    ? "Ahm MC Link Sent"
    : "Online MC Link Sent";

  const whitelistPhone = formNum || phone;

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
      await FirestoreService.createOrUpdateLead({
        phone, name, regiNo: formNum, status: statusValue, inquiry: 'CGI',
      }, {
        action: 'form_submitted', by: 'system',
        details: { formNum, option, statusValue }
      });
    } catch (e) { errors.push(`firestore: ${e.message}`); }

    if (errors.length) throw new Error(errors.join('; '));
  };

  // Custom Sheet write (upsert + cell updates)
  const customSheetWrite = async () => {
    const upsertResult = await SheetService.upsertContact({
      phone, name, source: 'WhatsApp',
      remark: `Form submitted: ${option}`, inquiry: 'CGI',
    });
    const C = config.SHEET_COLUMNS;
    await SheetService.updateContactCells(upsertResult.row, {
      [C.NAME]:    name,
      [C.STATUS]:  statusValue,
    });
  };

  const writeFn = buildWriteBoth(null, null, customFirestoreWrite, customSheetWrite);
  await tryWriteOrQueue(writeFn, `form_${phone}_${Date.now()}`, {
    phone, handler: 'handleFormSubmission'
  });

  // WATI confirmation (only true side-effect — fire-and-forget)
  WatiService.sendRegistrationConfirmation(params)
    .catch(e => console.error(`[WATI] confirmation: ${e.message}`));

  return { status: 'form_update_success' };
}


async function handleFlowReply(params) {
  try {
    console.log('Processing flow reply');
    const phoneNumber = params.waId || params.wa_num || params.senderName;
    if (!phoneNumber) throw new Error('Phone number not found');

    const contactData = await WatiService.getContactDetails(phoneNumber);
    if (!contactData?.contact) throw new Error('Failed to get contact details');

    const formData = _extractFormDataFromContact(contactData.contact, phoneNumber);
    if (!formData) throw new Error('Required form data not found');

    console.log(`Extracted: ${JSON.stringify(formData)}`);
    return await handleFormSubmission(formData);
  } catch (error) {
    console.error(`Flow reply error: ${error.message}`);
    throw error;
  }
}


function _extractFormDataFromContact(contact, phoneNumber) {
  const customParams = contact.customParams || [];
  const nameParam   = customParams.find(p => p.name === 'mc_regi_form_23_screen_0_textinput_0');
  const phoneParam  = customParams.find(p => p.name === 'mc_regi_form_23_screen_0_textinput_1');
  const optionParam = customParams.find(p => p.name === 'mc_regi_form_23_screen_0_radiobuttonsgroup_0');

  if (!nameParam || !phoneParam || !optionParam) return null;

  return {
    wa_num:   phoneNumber,
    name:     nameParam.value,
    form_num: phoneParam.value,
    option:   optionParam.value,
  };
}


module.exports = {
  handleFormSubmission,
  handleFlowReply
};