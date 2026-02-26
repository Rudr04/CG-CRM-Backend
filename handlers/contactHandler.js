// ============================================================================
//  handlers/contactHandler.js — Contact Event Handlers
// ============================================================================

const SheetService = require('../services/sheetsService');
const WatiService = require('../services/watiService');
const FirebaseService = require('../services/firebaseService');
const SmartfloService = require('../services/smartfloService');
const FirestoreService = require('../services/firestoreService');
const { shouldAssignRobo } = require('../utils/helpers');
const {
  ValidationError,
  ExternalServiceError,
  validateRequired,
  validatePhoneNumber
} = require('../lib/errorHandler');

const LOG_PREFIX = '[Contact]';


// ═══════════════════════════════════════════════════════════════════════════
//  HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleNewContact(params) {
  try {
    console.log(`${LOG_PREFIX} New WATI Contact`);
    const phoneNumber = validatePhoneNumber(params.waId, { source: 'handleNewContact' });
    const name = params.senderName || '';

    // Non-blocking syncs
    SmartfloService.createContact(phoneNumber, name, 'wati_new_contact')
      .catch(e => console.error(`${LOG_PREFIX} Smartflo: ${e.message}`));
    
    FirestoreService.createLead(params)
      .catch(e => console.warn(`${LOG_PREFIX} Firestore: ${e.message}`));

    return await WatiService.setWaidAttribute(params);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ExternalServiceError(error.message, 'WATI', { handler: 'handleNewContact' });
  }
}

async function handleInterestedUser(params) {
  console.log(`${LOG_PREFIX} Interested user`);
  return await SheetService.insertNewContact(params);
}

async function handleAdvertisementContact(params) {
  console.log(`${LOG_PREFIX} Advertisement contact`);
  if (shouldAssignRobo(params.text)) params.team = 'ROBO';
  return await SheetService.insertNewContact(params);
}

async function handleWebForm(params) {
  try {
    console.log(`${LOG_PREFIX} Web form`);
    validateRequired(params, ['name', 'phone'], { source: 'handleWebForm' });
    const phoneNumber = validatePhoneNumber(params.phone, { source: 'handleWebForm' });

    return await SheetService.insertNewContact({
      senderName: params.name || '',
      waId: phoneNumber,
      location: params.state || '',
      source: 'CGI Web Form',
      product: 'CGI',
      sourceUrl: '',
      text: '',
      remark: ''
    });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ExternalServiceError(error.message, 'Sheet', { handler: 'handleWebForm' });
  }
}

async function handleKeywordContact(params) {
  console.log(`${LOG_PREFIX} Keyword contact`);
  const contactParams = {
    senderName: params.senderName || '',
    waId: params.waId,
    sourceUrl: params.sourceUrl || 'keyword_message',
    msg: `Keyword: ${params.text || ''}`
  };
  if (shouldAssignRobo(params.text)) contactParams.team = 'ROBO';
  return await SheetService.insertNewContact(contactParams);
}

async function handleManualEntry(params) {
  try {
    console.log(`${LOG_PREFIX} Manual entry`);
    validateRequired(params, ['senderName', 'waId'], { source: 'handleManualEntry' });
    const phoneNumber = validatePhoneNumber(params.waId, { source: 'handleManualEntry' });

    const result = await SheetService.insertNewContactManual({
      senderName: params.senderName || '',
      waId: phoneNumber,
      remark: params.remark || '',
      location: params.location || '',
      product: params.product || 'CGI',
      source: params.source || 'Manual Entry',
      team: params.team || 'Not Assigned'
    });
    
    return { status: 'success', message: 'Manual inquiry added', row: result.row };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ExternalServiceError(error.message, 'Sheet', { handler: 'handleManualEntry' });
  }
}

async function handleRegistrationCheck(params) {
  try {
    const waId = validatePhoneNumber(params.waId, { source: 'handleRegistrationCheck' });
    const senderName = params.senderName || '';
    console.log(`${LOG_PREFIX} Registration check: ${waId}`);

    const registeredNumber = await SheetService.checkFirebaseWhitelist(waId);

    if (registeredNumber) {
      await WatiService.sendSessionMessage(waId,
        `*${registeredNumber}* is your registration number\n\nUse this to join the MasterClass\n\nCosmoGuru.live`
      );
      return { message: 'already_whitelisted', registeredNumber };
    }

    await FirebaseService.addToWhitelist(waId, senderName || waId, 'self_registration')
      .catch(e => console.error(`${LOG_PREFIX} Firebase: ${e.message}`));

    await WatiService.sendSessionMessage(waId,
      `You were not registered in our system,\nbut we have registered you right now *${waId}*.\n\n*You are now Registered! ✓*`
    );

    return { message: 'registered_and_notified' };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ExternalServiceError(error.message, 'Registration', { handler: 'handleRegistrationCheck' });
  }
}

async function handleUserLogin(params) {
  try {
    console.log(`${LOG_PREFIX} User login`);
    const phone = params.data?.phone || '';
    const name = params.data?.name || '';
    const loginTimestamp = params.data?.loginTimestamp || '';

    const phoneNumber = validatePhoneNumber(phone, { source: 'handleUserLogin' });
    const result = await SheetService.updateAttendance(phoneNumber, name, loginTimestamp);

    return { status: 'success', message: 'Attendance updated', ...result };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ExternalServiceError(error.message, 'Attendance', { handler: 'handleUserLogin' });
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  handleNewContact,
  handleInterestedUser,
  handleAdvertisementContact,
  handleWebForm,
  handleKeywordContact,
  handleManualEntry,
  handleRegistrationCheck,
  handleUserLogin
};