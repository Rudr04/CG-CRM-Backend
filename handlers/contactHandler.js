const SheetService = require('../services/sheetsService');
const WatiService = require('../services/watiService');
const FirebaseService = require('../services/firebaseService');
const SmartfloService = require('../services/smartfloService');

function shouldAssignRobo(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return t.includes('free masterclass') || t.includes('free mc');
}

async function handleNewContact(params) {
  console.log('New WATI Contact Found');

  const phoneNumber = params.waId || '';
  const name = params.senderName || '';

  if (phoneNumber) {
    SmartfloService.createContact(phoneNumber, name, 'wati_new_contact')
      .then(() => console.log(`[Smartflo] Contact synced for ${phoneNumber}`))
      .catch(err  => console.error(`[Smartflo] Non-blocking sync error for ${phoneNumber}: ${err.message}`));
  } else {
    console.warn('[Smartflo] Skipped â€” no waId on params');
  }

  return await WatiService.setWaidAttribute(params);

  //await SheetService.insertNewContact(params);
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
    const contactData = {
      senderName: params.name || '',
      waId: params.phone || '',
      location: params.state || '',
      source: 'CGI Web Form',
      product: 'CGI',
      sourceUrl: '',
      text: '',
      remark: ''
    };
    return await SheetService.insertNewContact(contactData);
  } catch (error) {
    console.error('Web form error:', error.message);
    throw error;
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
    const contactParams = {
      senderName: params.senderName || '',
      waId: params.waId || '',
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
    console.error('Manual entry error:', error.message);
    return {
      status: 'error',
      message: error.message
    };
  }
}

// âœ… UPDATED: Registration check handler with proper messaging
async function handleRegistrationCheck(params) {
  const waId = params.waId || '';
  const senderName = params.senderName || '';

  console.log(`Registration check for: ${waId}`);

  if (!waId) {
    console.error('Registration check: waId missing');
    return { message: 'waId missing' };
  }

  // Check if number exists in FirebaseWhitelist sheet
  // Returns registered number if found, null if not found
  const registeredNumber = await SheetService.checkFirebaseWhitelist(waId);

  if (registeredNumber) {
    // Already registered - send them their registered number
    console.log(`${waId} already whitelisted with registered number: ${registeredNumber}`);
    
    await WatiService.sendSessionMessage(
      waId,
      `*${registeredNumber}* is your registration number\n\nUse this to join the MasterClass\n\nCosmoGuru.live`
    );

    return { message: 'already_whitelisted', registeredNumber };
  }

  // Not found â€” add to Firebase whitelist now
  console.log(`${waId} not whitelisted â€” adding now`);
  try {
    await FirebaseService.addToWhitelist(waId, senderName || waId, 'self_registration');
    console.log(`${waId} added to Firebase whitelist`);
  } catch (fbError) {
    // Don't block the message even if Firebase fails
    console.error(`Firebase whitelist error for ${waId}: ${fbError.message}`);
  }

  // Send session message informing them they're now registered
  await WatiService.sendSessionMessage(
    waId,
    `You were not registered in our system,\nbut we have registered you right now *${waId}*.\n\n*You are now Registered! âœ…*`
  );

  return { message: 'registered_and_notified' };
}

// Add this new function before module.exports
async function handleUserLogin(params) {
  try {
    console.log('User login event received from CosmoGuru Live');
    
    const phone = params.data?.phone || '';
    const name = params.data?.name || '';
    const loginTimestamp = params.data?.loginTimestamp || '';

    if (!phone) {
      console.error('User login: phone missing');
      return { message: 'phone missing' };
    }

    console.log(`Processing login for: ${phone} (${name})`);

    // Update attendance in sheet
    const result = await SheetService.updateAttendance(phone, name, loginTimestamp);

    return {
      status: 'success',
      message: 'Attendance updated',
      ...result
    };

  } catch (error) {
    console.error('User login error:', error.message);
    return {
      status: 'error',
      message: error.message
    };
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