// ============================================================================
//  index.js — Cloud Function Entry Point
//
//  Uses object-based router (lib/router.js) following Open-Closed Principle.
//  NO if-else chains for routing. Add new routes by adding to ROUTES object.
// ============================================================================

require('dotenv').config();

const functions = require('@google-cloud/functions-framework');
const { Datastore } = require('@google-cloud/datastore');
const config = require('./config');
const { routeEvent, shouldSkipDuplicate } = require('./lib/router');
const { errorToResponse } = require('./lib/errorHandler');
const PendingQueue = require('./services/pendingQueue');

const datastore = new Datastore();


// ═══════════════════════════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════════════════════════

console.log('CosmoGuru Webhook Starting...', {
  hasSpreadsheetId: !!process.env.SPREADSHEET_ID,
  hasWatiConfig: !!(process.env.WATI_TENANT_ID && process.env.WATI_BEARER_TOKEN),
  hasFirebaseUrl: !!process.env.FIREBASE_DATABASE_URL,
  firestoreEnabled: config.FIRESTORE.ENABLED,
  firestorePhase: config.FIRESTORE.PHASE
});


// ═══════════════════════════════════════════════════════════════════════════
//  DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════════════

const processedEvents = new Map();

setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  for (const [key, timestamp] of processedEvents.entries()) {
    if (timestamp < oneHourAgo) processedEvents.delete(key);
  }
}, 3600000);

function generateEventId(params) {
  const type = params.eventType || params.event_type || params.type || params.event || 'unknown';
  const waId = params.waId || params.wa_num || params.phone || params.data?.phone || '';
  const messageId = params.messageId || params.id || '';
  const timestamp = params.timestamp || Date.now();

  if (messageId) return `msg_${messageId}`;
  if (type === 'whatsapp_flow_reply') return `flow_${waId}`;
  if (type === 'sheet_edit') return `sheet_${timestamp}`;
  
  return `${type}_${waId}_${Math.floor(timestamp / 10000)}`;
}


// ═══════════════════════════════════════════════════════════════════════════
//  MUTEX LOCKING
// ═══════════════════════════════════════════════════════════════════════════

async function withMutex(waId, fn) {
  if (!waId) return fn();
  
  const lockKey = datastore.key(['waId_locks', waId]);
  const maxRetries = 60;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      const [lockEntity] = await datastore.get(lockKey);
      if (!lockEntity) break;
      await new Promise(r => setTimeout(r, 50));
      retries++;
    } catch (error) {
      break;
    }
  }
  
  try {
    await datastore.save({
      key: lockKey,
      data: { locked: true, timestamp: Date.now(), ttl: Math.floor(Date.now() / 1000) + 30 }
    });
  } catch (error) {
    console.error(`Mutex acquire error: ${error.message}`);
  }
  
  try {
    return await fn();
  } finally {
    try {
      await datastore.delete(lockKey);
    } catch (error) {
      console.error(`Mutex release error: ${error.message}`);
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  MAIN WEBHOOK HANDLER
// ═══════════════════════════════════════════════════════════════════════════

functions.http('webhook', async (req, res) => {
  // Health check
  if (req.method === 'GET') {
    return res.status(200).send('CosmoGuru Webhook is running.');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const params = req.body;
    console.log('Webhook received:', JSON.stringify(params).substring(0, 500));

    // Deduplication (skip for certain event types)
    if (!shouldSkipDuplicate(params)) {
      const eventId = generateEventId(params);
      if (processedEvents.has(eventId)) {
        console.log(`Duplicate blocked: ${eventId}`);
        return res.status(200).json({ status: 'success', message: 'duplicate_ignored' });
      }
      processedEvents.set(eventId, Date.now());
    }

    // Route to appropriate handler (no if-else chains!)
    const { handled, result, routeName } = await routeEvent(params);

    if (handled) {
      console.log(`Handled by: ${routeName}`);
    }

    return res.status(200).json({ status: 'success', ...result });

  } catch (error) {
    console.error('Webhook error:', error);
    const { statusCode, body } = errorToResponse(error);
    return res.status(statusCode).json(body);
  }
});


// ═══════════════════════════════════════════════════════════════════════════
//  DIAGNOSTIC ENDPOINT — Queue Status
// ═══════════════════════════════════════════════════════════════════════════

functions.http('diagnostic', async (req, res) => {
  try {
    const queueStats = PendingQueue.getStats();
    return res.status(200).json({
      status: 'running',
      pendingQueue: queueStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Diagnostic error:', error);
    return res.status(500).json({ error: error.message });
  }
});