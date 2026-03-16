// ============================================================================
//  formHandler.js — WhatsApp Form Submission Orchestrator
//
//  Writes to BOTH Firestore and Sheet transactionally.
//  Firebase whitelist is inside the transactional closure (critical for login).
//  WATI confirmation is the only non-transactional side-effect.
// ============================================================================

const SheetService     = require('../services/sheetsService');
const FirestoreService = require('../services/firestoreService');
const WatiService      = require('../services/watiService');
const FirebaseService  = require('../services/firebaseService');
const PendingQueue     = require('../services/pendingQueue');


async function handleFormSubmission(params) {
  const phone   = params.wa_num || '';
  const name    = params.name || '';
  const option  = params.option || '';
  const formNum = params.form_num || '';

  const statusValue = option === "Offline (અમદાવાદ ક્લાસ માં)"
    ? "Ahm MC Link Sent"
    : "Online MC Link Sent";

  const whitelistPhone = formNum || phone;

  const writeBoth = async () => {
    const errors = [];

    // 1. Firebase RTDB whitelist (CRITICAL — user can't login without this)
    try {
      if (whitelistPhone && name) {
        await FirebaseService.addToWhitelist(whitelistPhone, name, 'whatsapp_form');
      }
    } catch (e) { errors.push(`whitelist: ${e.message}`); }

    // 2. Firestore lead record (main DB)
    try {
      await FirestoreService.createOrUpdateLead({
        phone, name, regiNo: formNum, status: statusValue,
      }, {
        action: 'form_submitted', by: 'system',
        details: { formNum, option, statusValue }
      });
    } catch (e) { errors.push(`firestore: ${e.message}`); }

    // 3. Sheet write (agent frontend)
    try {
      const upsertResult = await SheetService.upsertContact({
        phone, name, source: 'WhatsApp',
        remark: `Form submitted: ${option}`, product: 'CGI',
      });
      await SheetService.updateFormData(params, upsertResult.row);
    } catch (e) { errors.push(`sheet: ${e.message}`); }

    if (errors.length) throw new Error(errors.join('; '));
  };

  try {
    await writeBoth();
  } catch (err) {
    PendingQueue.enqueue(`form_${phone}_${Date.now()}`, writeBoth, {
      phone, handler: 'handleFormSubmission'
    });
    console.error(`[FormHandler] Write failed, queued: ${err.message}`);
  }

  // 4. WATI confirmation (only true side-effect — fire-and-forget)
  //    User is already whitelisted + registered even without this message
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


module.exports = { handleFormSubmission, handleFlowReply };
