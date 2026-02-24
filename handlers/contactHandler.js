const SheetService = require('../services/sheetsService');
const WatiService = require('../services/watiService');
const FirebaseService = require('../services/firebaseService');
const SmartfloService = require('../services/smartfloService');
const FirestoreService = require('../services/firestoreService');
const {
  ValidationError,
  ExternalServiceError,
  validateRequired,
  validatePhoneNumber
} = require('../lib/errorHandler');

const { FIRESTORE } = require('../config');

function shouldAssignRobo(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return t.includes('free masterclass') || t.includes('free mc');
}

async function handleNewContact(params) {
  try {
    console.log('New WATI Contact Found');

    const phoneNumber = validatePhoneNumber(params.waId, { source: 'handleNewContact' });
    const name = params.senderName || '';

    // Non-blocking Smartflo sync
    if (phoneNumber) {
      SmartfloService.createContact(phoneNumber, name, 'wati_new_contact')
        .then(() => console.log(`[Smartflo] Contact synced for ${phoneNumber}`))
        .catch(err => console.error(`[Smartflo] Non-blocking sync error for ${phoneNumber}: ${err.message}`));
    }

    // Create lead in Firestore
    try {
      await FirestoreService.createLead(params);
    } catch (err) {
      console.warn(`[Firestore] Non-blocking create failed: ${err.message}`);
    }

    // Set WATI attribute
    return await WatiService.setWaidAttribute(params);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ExternalServiceError(error.message, 'WATI', { handler: 'handleNewContact' });
  }
}

async function handleInterestedUser(params) {
  console.log('For Learning selected');
  return await SheetService.insertNewContact(params);
}

async function handleAdvertisementContact(params) {
  console.log('Contact from advertise');
  const text = params.text || '';
  if (shouldAssignRobo(text)) {
    params.team = 'ROBO';
  }
  return await SheetService.insertNewContact(params);
}

async function handleWebForm(params) {
  try {
    console.log('Web Form Submission received');
    validateRequired(params, ['name', 'phone'], { source: 'handleWebForm' });
    const phoneNumber = validatePhoneNumber(params.phone, { source: 'handleWebForm' });

    const contactData = {
      senderName: params.name || '',
      waId: phoneNumber,
      location: params.state || '',
      source: 'CGI Web Form',
      product: 'CGI',
      sourceUrl: '',
      text: '',
      remark: ''
    };
    return await SheetService.insertNewContact(contactData);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    console.error('Web form error:', error.message);
    throw new ExternalServiceError(error.message, 'Sheet', { handler: 'handleWebForm' });
  }
}

async function handleKeywordContact(params) {
  console.log('Contact from keyword message');
  const text = params.text || '';
  const contactParams = {
    senderName: params.senderName || '',
    waId: params.waId,
    sourceUrl: params.sourceUrl || 'keyword_message',
    msg: `Keyword: ${params.text || ''}`
  };
  if (shouldAssignRobo(text)) {
    contactParams.team = 'ROBO';
  }
  return await SheetService.insertNewContact(contactParams);
}

async function handleManualEntry(params) {
  try {
    console.log('Processing manual entry from AppScript');
    validateRequired(params, ['senderName', 'waId'], { source: 'handleManualEntry' });
    const phoneNumber = validatePhoneNumber(params.waId, { source: 'handleManualEntry' });

    const contactParams = {
      senderName: params.senderName || '',
      waId: phoneNumber,
      sourceUrl: params.source || 'Manual Entry',
      remark: params.remark || '',
      text: '',
      location: params.location || '',
      product: params.product || 'CGI',
      source: params.source || 'Manual Entry',
      team: params.team || 'Not Assigned'
    };
    const result = await SheetService.insertNewContactManual(contactParams);
    return {
      status: 'success',
      message: 'Manual inquiry added',
      row: result.row
    };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    console.error('Manual entry error:', error.message);
    throw new ExternalServiceError(error.message, 'Sheet', { handler: 'handleManualEntry' });
  }
}

// ✅ UPDATED: Registration check handler with proper error handling
async function handleRegistrationCheck(params) {
  try {
    const waId = validatePhoneNumber(params.waId, { source: 'handleRegistrationCheck' });
    const senderName = params.senderName || '';

    console.log(`Registration check for: ${waId}`);

    // Check if number exists in FirebaseWhitelist sheet
    const registeredNumber = await SheetService.checkFirebaseWhitelist(waId);

    if (registeredNumber) {
      console.log(`${waId} already whitelisted with registered number: ${registeredNumber}`);
      await WatiService.sendSessionMessage(
        waId,
        `*${registeredNumber}* is your registration number\n\nUse this to join the MasterClass\n\nCosmoGuru.live`
      );
      return { message: 'already_whitelisted', registeredNumber };
    }

    // Not found – add to Firebase whitelist
    console.log(`${waId} not whitelisted – adding now`);
    try {
      await FirebaseService.addToWhitelist(waId, senderName || waId, 'self_registration');
      console.log(`${waId} added to Firebase whitelist`);
    } catch (fbError) {
      console.error(`Firebase whitelist error for ${waId}: ${fbError.message}`);
    }

    // Send session message
    await WatiService.sendSessionMessage(
      waId,
      `You were not registered in our system,\nbut we have registered you right now *${waId}*.\n\n*You are now Registered! ✓*`
    );

    return { message: 'registered_and_notified' };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    console.error('Registration check error:', error.message);
    throw new ExternalServiceError(error.message, 'Registration', { handler: 'handleRegistrationCheck' });
  }
}

// ✅ UPDATED: User login handler with proper error handling
async function handleUserLogin(params) {
  try {
    console.log('User login event received from CosmoGuru Live');

    const phone = params.data?.phone || '';
    const name = params.data?.name || '';
    const loginTimestamp = params.data?.loginTimestamp || '';

    const phoneNumber = validatePhoneNumber(phone, { source: 'handleUserLogin' });
    console.log(`Processing login for: ${phoneNumber} (${name})`);

    // Update attendance in sheet
    const result = await SheetService.updateAttendance(phoneNumber, name, loginTimestamp);

    return {
      status: 'success',
      message: 'Attendance updated',
      ...result
    };

  } catch (error) {
    if (error instanceof ValidationError) throw error;
    console.error('User login error:', error.message);
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
  handleRegistrationCheck,
  handleUserLogin
};