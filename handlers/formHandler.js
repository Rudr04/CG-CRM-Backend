// ============================================================================
//  handlers/formHandler.js — Form Submission Handlers
// ============================================================================

const SheetService = require('../services/sheetsService');
const WatiService = require('../services/watiService');
const FirebaseService = require('../services/firebaseService');
const { ValidationError, ExternalServiceError } = require('../lib/errorHandler');

const LOG_PREFIX = '[Form]';


async function handleFormSubmission(params) {
  try {
    console.log(`${LOG_PREFIX} Processing form`);
    
    let result;
    try {
      result = await SheetService.updateFormData(params);
    } catch (updateError) {
      if (updateError.message === 'No match found') {
        console.log(`${LOG_PREFIX} User not found, creating`);
        
        await SheetService.insertNewContact({
          senderName: params.name || '',
          waId: params.wa_num || '',
          sourceUrl: 'whatsapp_form',
          source: 'WhatsApp Form',
          remark: `Form submitted: ${params.option || ''}`,
          text: ''
        });
        
        await SheetService.updateFormData(params);
      } else {
        throw updateError;
      }
    }
    
    const phoneNumber = params.form_num || params.wa_num;
    const name = params.name;

    if (phoneNumber && name) {
      await FirebaseService.addToWhitelist(phoneNumber, name, 'whatsapp_form')
        .catch(e => console.error(`${LOG_PREFIX} Firebase: ${e.message}`));
    }

    await WatiService.sendRegistrationConfirmation(params);
    return { status: 'form_update_success' };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error: ${error.message}`);
    if (error instanceof ValidationError) throw error;
    throw new ExternalServiceError(error.message, 'Form', { handler: 'handleFormSubmission' });
  }
}


async function handleFlowReply(params) {
  try {
    console.log(`${LOG_PREFIX} Processing flow reply`);
    
    const phoneNumber = params.waId || params.wa_num || params.senderName;
    if (!phoneNumber) {
      throw new ValidationError('Phone number not found in flow reply');
    }

    const contactData = await WatiService.getContactDetails(phoneNumber);
    if (!contactData?.contact) {
      throw new ExternalServiceError('Failed to get contact details', 'WATI');
    }

    const formData = extractFormDataFromContact(contactData.contact, phoneNumber);
    if (!formData) {
      throw new ValidationError('Required form data not found');
    }

    console.log(`${LOG_PREFIX} Extracted: ${JSON.stringify(formData)}`);
    return await handleFormSubmission(formData);

  } catch (error) {
    console.error(`${LOG_PREFIX} Flow reply error: ${error.message}`);
    if (error instanceof ValidationError) throw error;
    if (error instanceof ExternalServiceError) throw error;
    throw new ExternalServiceError(error.message, 'Form', { handler: 'handleFlowReply' });
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


module.exports = {
  handleFormSubmission,
  handleFlowReply
};