// ============================================================================
//  index.js — Cloud Function Entry Point
//
//  Uses object-based router (lib/router.js) following Open-Closed Principle.
//  NO if-else chains for routing. Add new routes by adding to ROUTES object.
// ============================================================================

require('dotenv').config();

const crypto = require('crypto');
const functions = require('@google-cloud/functions-framework');
const { Firestore } = require('@google-cloud/firestore');
const config = require('./config');
const { routeEvent, shouldSkipDuplicate } = require('./lib/router');
const { errorToResponse } = require('./lib/errorHandler');
const PendingQueue = require('./services/pendingQueue');
const { handleDashboardRequest } = require('./handlers/dashboardHandler');

const _razorpayFirestore = new Firestore();


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
  const rawTs = params.timestamp || Date.now();
  const timestamp = typeof rawTs === 'string' ? new Date(rawTs).getTime() : rawTs;

  if (messageId) return `msg_${messageId}`;
  if (type === 'whatsapp_flow_reply') return `flow_${waId}`;
  if (type === 'sheet_edit') return `sheet_${timestamp}`;
  
  return `${type}_${waId}_${Math.floor(timestamp / 10000)}`;
}


// ═══════════════════════════════════════════════════════════════════════════
//  MAIN WEBHOOK HANDLER
// ═══════════════════════════════════════════════════════════════════════════

functions.http('webhook', async (req, res) => {
  // Inside the webhook function, replace the GET block:
  if (req.method === 'GET') {
    if (req.path === '/dashboard-data') {
      return handleDashboardRequest(req, res);
    }
    if (req.path === '/dashboard') {
      const fs = require('fs');
      const html = fs.readFileSync(__dirname + '/dashboard.html', 'utf8');
      res.set('Content-Type', 'text/html');
      return res.status(200).send(html);
    }
    return res.status(200).send('CosmoGuru Webhook is running.');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // ─── Razorpay webhook (isolated from WATI flow) ─────────────────────────
  if (req.headers['x-razorpay-signature']) {
    try {
      const expected = crypto
        .createHmac('sha256', config.RAZORPAY.WEBHOOK_SECRET)
        .update(req.rawBody)
        .digest('hex');

      if (expected !== req.headers['x-razorpay-signature']) {
        console.warn('[Razorpay] Signature mismatch');
        return res.status(401).json({ error: 'invalid_signature' });
      }

      const eventId = req.headers['x-razorpay-event-id'];
      if (eventId) {
        const docRef = _razorpayFirestore.collection('_razorpay_events').doc(eventId);
        const snap = await docRef.get();
        if (snap.exists) {
          console.log('[Razorpay] Event already processed:', eventId);
          return res.status(200).json({ status: 'already_processed' });
        }
      }

      const params = req.body;
      const { handled, result, routeName } = await routeEvent(params);
      if (handled) console.log(`Handled by: ${routeName}`);

      if (eventId) {
        await _razorpayFirestore.collection('_razorpay_events').doc(eventId).set({
          processedAt: new Date().toISOString(),
          event: params.event,
        });
      }

      return res.status(200).json({ status: 'success', ...(result || {}) });
    } catch (error) {
      console.error('[Razorpay] Handler failed:', error.message);
      return res.status(500).json({ error: 'processing_failed' });
    }
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