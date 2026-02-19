// Load environment variables FIRST
require('dotenv').config();

const functions = require('@google-cloud/functions-framework');
const { Datastore } = require('@google-cloud/datastore');
const ContactHandler = require('./handlers/contactHandler');
const FormHandler = require('./handlers/formHandler');
const PaymentHandler = require('./handlers/paymentHandler');
const SyncHandler = require('./handlers/syncHandler');           // ✅ NEW
const SheetService = require('./services/sheetsService');
const { containsFuzzyKeywords, isFromAdvertisement, fuzzyMatchesRegistrationCheck } = require('./utils/helpers');
const datastore = new Datastore();
const config = require('./config');

// Verify environment variables on startup
console.log('Environment check:', {
  hasSpreadsheetId: !!process.env.SPREADSHEET_ID,
  hasWatiTenantId: !!process.env.WATI_TENANT_ID,
  hasWatiToken: !!process.env.WATI_BEARER_TOKEN,
  hasWatiBaseUrl: !!process.env.WATI_BASE_URL,
  hasFirebaseUrl: !!process.env.FIREBASE_DATABASE_URL,
  firestoreEnabled: process.env.FIRESTORE_ENABLED !== 'false'   // ✅ NEW
});

const processedEvents = new Map();
const waIdMutex = new Map();


// Mutex helper
async function withWaIdMutex(waId, fn) {
  if (!waId) return fn();
  
  const lockKey = datastore.key(['waId_locks', waId]);
  const maxRetries = 60;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      const [lockEntity] = await datastore.get(lockKey);
      if (!lockEntity) break;
      console.log(`⏳ Mutex WAITING: waId ${waId} is locked, waiting...`);
      await new Promise(r => setTimeout(r, 50));
      retries++;
    } catch (error) {
      console.error(`Error checking lock for ${waId}:`, error.message);
      break;
    }
  }
  
  if (retries >= maxRetries) {
    console.warn(`⚠️ Mutex TIMEOUT: waId ${waId} - proceeding anyway`);
  }
  
  console.log(`🔒 Mutex LOCKED: waId ${waId}`);
  try {
    await datastore.save({
      key: lockKey,
      data: {
        locked: true,
        timestamp: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + 30
      }
    });
  } catch (error) {
    console.error(`Error acquiring lock for ${waId}:`, error.message);
  }
  
  try {
    return await fn();
  } finally {
    console.log(`🔓 Mutex UNLOCKED: waId ${waId}`);
    try {
      await datastore.delete(lockKey);
    } catch (error) {
      console.error(`Error releasing lock for ${waId}:`, error.message);
    }
  }
}

// Clean processedEvents every hour
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  for (const [key, timestamp] of processedEvents.entries()) {
    if (timestamp < oneHourAgo) processedEvents.delete(key);
  }
}, 3600000);

functions.http('webhook', async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).send('CosmoGuru Webhook is running.');
  }

  if (req.path === '/diagnostic' && req.method === 'POST') {
    try {
      await SheetService.listAllTables();
      return res.status(200).json({ status: 'Diagnostic ran - check logs' });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const params = req.body;
    console.log('Received webhook:', JSON.stringify(params));

    const eventId = generateEventId(params);
    const waId = params.waId || '';

    // ✅ Skip duplicate check for events that are always unique
    const skipDuplicateCheck = params.event === 'user_login'
                            || params.eventType === 'sheet_edit';   // ✅ NEW

    if (!skipDuplicateCheck) {
      if (processedEvents.has(eventId)) {
        console.log(`Duplicate blocked: ${eventId}`);
        return res.status(200).json({ status: 'success', message: 'duplicate_ignored' });
      }
      processedEvents.set(eventId, Date.now());
    }
    const eventType = params.eventType || params.event_type || '';
    const type = params.type || '';
    const listReplyId = params.listReply?.id || '';
    const sourceUrl = params.sourceUrl || '';
    const messageText = params.text || '';

    let result;

    // ✅ NEW: Real-time Sheet → Firestore sync (from onEdit trigger)
    if (eventType === 'sheet_edit') {
      result = await SyncHandler.handleSheetEdit(params);

    } else if (eventType === config.EVENT_TYPES.CG_Web) {
      result = await ContactHandler.handleWebForm(params);

    } else if (eventType === config.EVENT_TYPES.NEW_CONTACT) {
      result = await ContactHandler.handleNewContact(params);

    // ✅ Registration check — exact match, runs BEFORE fuzzy keyword check
    } else if (eventType === 'message' && messageText && fuzzyMatchesRegistrationCheck(messageText)) {
      result = await ContactHandler.handleRegistrationCheck(params);

    } else if (eventType === 'message' && messageText && containsFuzzyKeywords(messageText)) {
      result = await ContactHandler.handleKeywordContact(params);

    } else if (isFromAdvertisement(sourceUrl)) {
      result = await ContactHandler.handleAdvertisementContact(params);

    } else if (eventType === config.EVENT_TYPES.CRM_Entry) {
      result = await ContactHandler.handleManualEntry(params);

    } else if (listReplyId === config.LIST_REPLY_IDS.INTERESTED) {
      result = await ContactHandler.handleInterestedUser(params);

    } else if (type === 'whatsapp_flow_reply') {
      result = await FormHandler.handleFlowReply(params);

    } else if (eventType === config.EVENT_TYPES.FORM_FILLED) {
      result = await FormHandler.handleFormSubmission(params);

    } else if (eventType === config.EVENT_TYPES.GRP_JOIN) {
      result = await SheetService.handleCommunityJoin(params);

    } else if (eventType === config.EVENT_TYPES.PAYMENT) {
      result = await PaymentHandler.handlePayment(params);

    // ✅ Handle user login from CosmoGuru Live app
    } else if (params.event === 'user_login') {
      result = await ContactHandler.handleUserLogin(params);

    } else {
      console.log('No handler found for:', eventType);
      result = { message: 'No handler found' };
    }

    return res.status(200).json({ status: 'success', ...result });

  } catch (error) {
    console.error('Error:', error);
    return res.status(200).json({ status: 'error', message: error.message });
  }
});

function generateEventId(params) {
  // ✅ Safe access — sheet_edit events don't have waId or data.phone
  const waId = params.waId || params.wa_num || params.phone || params.data?.phone || '';
  const type = params.type || params.eventType || params.event_type || params.event || '';
  const messageId = params.messageId || params.id || '';
  const timestamp = params.timestamp || Date.now();

  if (messageId) return `msg_${messageId}`;
  if (type === 'whatsapp_flow_reply') return `flow_${waId}`;
  if (type === 'sheet_edit') return `sheet_edit_${timestamp}`;    // ✅ NEW
  
  return `${type}_${waId}_${Math.floor(timestamp / 10000)}`;
}
