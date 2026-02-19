const SheetService = require('../services/sheetsService');
const WatiService = require('../services/watiService');
const FirebaseService = require('../services/firebaseService');

async function handleFormSubmission(params) {
  try {
    // Try to update existing user first
    let result;
    try {
      result = await SheetService.updateFormData(params);
    } catch (updateError) {
      // If user not found (no match), create new entry
      if (updateError.message === 'No match found') {
        console.log('User not found in sheet, creating new entry');
        
        // Create new contact with form data
        const newContactParams = {
          senderName: params.name || '',
          waId: params.wa_num || '',
          sourceUrl: 'whatsapp_form',
          source: 'WhatsApp Form',
          remark: `Form submitted: ${params.option || ''}`,
          text: ''
        };
        
        // Insert new contact
        result = await SheetService.insertNewContact(newContactParams);
        
        // Now update with form details
        await SheetService.updateFormData(params);
      } else {
        // If it's a different error, throw it
        throw updateError;
      }
    }
    
    const phoneNumber = params.form_num || params.wa_num;
    const name = params.name;

    if (phoneNumber && name) {
      try {
        await FirebaseService.addToWhitelist(phoneNumber, name, 'whatsapp_form');
        console.log(`Added to Firebase: ${phoneNumber}`);
      } catch (fbError) {
        console.error(`Firebase error: ${fbError.message}`);
      }
    }

    await WatiService.sendRegistrationConfirmation(params);
    return { status: 'form_update_success' };
  } catch (error) {
    console.error('Form error:', error.message);
    throw error;
  }
}

async function handleFlowReply(params) {
  try {
    console.log('Processing flow reply');
    const phoneNumber = params.waId || params.wa_num || params.senderName;
    if (!phoneNumber) throw new Error('Phone number not found');

    const contactData = await WatiService.getContactDetails(phoneNumber);
    if (!contactData?.contact) throw new Error('Failed to get contact details');

    const formData = extractFormDataFromContact(contactData.contact, phoneNumber);
    if (!formData) throw new Error('Required form data not found');

    console.log(`Extracted: ${JSON.stringify(formData)}`);
    return await handleFormSubmission(formData);
  } catch (error) {
    console.error(`Flow reply error: ${error.message}`);
    throw error;
  }
}

function extractFormDataFromContact(contact, phoneNumber) {
  const customParams = contact.customParams || [];
  const nameParam = customParams.find(p => p.name === 'mc_regi_form_23_screen_0_textinput_0');
  const phoneParam = customParams.find(p => p.name === 'mc_regi_form_23_screen_0_textinput_1');
  const optionParam = customParams.find(p => p.name === 'mc_regi_form_23_screen_0_radiobuttonsgroup_0');

  if (!nameParam || !phoneParam || !optionParam) return null;

  return {
    wa_num: phoneNumber,
    name: nameParam.value,
    form_num: phoneParam.value,
    option: optionParam.value
  };
}

module.exports = { handleFormSubmission, handleFlowReply };