const axios = require('axios');
const config = require('../config');

async function setWaidAttribute(params) {
  const waId = params.waId || '';
  if (!waId) throw new Error('Phone missing');

  const url = `${config.WATI.BASE_URL}${config.WATI.TENANT_ID}/api/v1/updateContactAttributes/${waId}`;
  
  try {
    const response = await axios.post(url, {
      customParams: [{ name: "waid", value: waId }]
    }, {
      headers: {
        'Authorization': `Bearer ${config.WATI.BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    return response.status === 200;
  } catch (error) {
    console.error('WATI error:', error.message);
    throw error;
  }
}

async function sendRegistrationConfirmation(params) {
  const waId   = params.wa_num   || '';
  const name   = params.name     || '';
  const num    = params.form_num || '';
  const choice = params.option === "Offline (અમદાવાદ ક્લાસ માં)" ? "Offline" : "Online";

  if (!waId) throw new Error('Phone missing');

  const grp_link = choice === "Online" 
    ? "https://chat.whatsapp.com/EgpO11VxMPcAnmu8YylIqI"
    : "https://chat.whatsapp.com/LU7lyII2CaOK5aJLw6PhZ9";
  
  const template_name = choice === "Online" ? "cgi_22_test3" : "cgi_22_test3_2";

  try {
    const url = `${config.WATI.BASE_URL}${config.WATI.TENANT_ID}/api/v1/sendTemplateMessage?whatsappNumber=${waId}`;
    
    const response = await axios.post(url, {
      template_name,
      broadcast_name: "Registration_Confirmation",
      parameters: [
        { name: "mcregiform_screen_0_textinput_0", value: name },
        { name: "mcregiform_screen_0_textinput_1", value: num  },
        { name: "dynamic_track", value: `?num=${waId}&dest=${grp_link}` }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${config.WATI.BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.status === 200) {
      await setRegistrationApprovalAttribute(waId, choice.toLowerCase());
      return true;
    }
    return false;
  } catch (error) {
    console.error('Reg confirmation error:', error.message);
    throw error;
  }
}

async function setRegistrationApprovalAttribute(waId, approvalType) {
  const url = `${config.WATI.BASE_URL}${config.WATI.TENANT_ID}/api/v1/updateContactAttributes/${waId}`;
  
  try {
    await axios.post(url, {
      customParams: [{ name: "mc_approve", value: approvalType }]
    }, {
      headers: {
        'Authorization': `Bearer ${config.WATI.BEARER_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function getContactDetails(phoneNumber) {
  const sanitizedPhone = phoneNumber.toString().replace(/\D/g, '');
  const url = `${config.WATI.BASE_URL}${config.WATI.TENANT_ID}/api/v1/getContacts?name=${sanitizedPhone}`;

  try {
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${config.WATI.BEARER_TOKEN}`,
        'accept': '*/*'
      }
    });

    if (response.data?.result === "success" && response.data.contact_list?.length > 0) {
      return { result: true, contact: response.data.contact_list[0] };
    }
    throw new Error('No contact found');
  } catch (error) {
    throw error;
  }
}

// ✅ NEW: Send a plain session message to a WhatsApp number
async function sendSessionMessage(waId, messageText) {
  if (!waId) throw new Error('Phone missing');

  const url = `${config.WATI.BASE_URL}${config.WATI.TENANT_ID}/api/v1/sendSessionMessage/${waId}?messageText=${encodeURIComponent(messageText)}`;

  try {
    const response = await axios.post(url, '', {   // ✅ empty body
      headers: {
        'Authorization': `Bearer ${config.WATI.BEARER_TOKEN}`,
        'accept': '*/*'
      }
    });
    console.log(`Session message sent to ${waId}: status ${response.status}`);
    return response.status === 200;
  } catch (error) {
    console.error(`sendSessionMessage error for ${waId}: ${error.message}`);
    throw error;
  }
}

module.exports = {
  setWaidAttribute,
  sendRegistrationConfirmation,
  setRegistrationApprovalAttribute,
  getContactDetails,
  sendSessionMessage    // ✅ ADDED
};