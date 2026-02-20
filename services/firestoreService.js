// ============================================================================
// firestoreService.js — Firestore Lead Database
// Phase 1: Parallel write (Sheets remains source of truth, Firestore gets copy)
// Document ID: last 10 digits of phone number
// Collection: leads
// ============================================================================

const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const config = require('../config');
const { getLastTenDigits } = require('../utils/helpers');

let db = null;

// ─────────────────────────────────────────────────────────────
//  INIT — lazy singleton, reused across Cloud Function invocations
// ─────────────────────────────────────────────────────────────
function getDb() {
  if (!db) {
    // firebase-admin auto-detects credentials on GCP (Cloud Functions)
    // Locally, it uses GOOGLE_APPLICATION_CREDENTIALS env var
    if (!admin.apps.length) {
      admin.initializeApp({
        databaseURL: config.FIREBASE.DATABASE_URL  // still needed for RTDB whitelist
      });
    }
    db = getFirestore();
    console.log('[Firestore] Initialized');
  }
  return db;
}

const COLLECTION = 'leads';

// ─────────────────────────────────────────────────────────────
//  CREATE LEAD — new document from webhook data
//  Called after Sheet write succeeds. Non-blocking on failure.
// ─────────────────────────────────────────────────────────────
async function createLead(leadData) {
  try {
    const firestore = getDb();
    const phone10 = getLastTenDigits(leadData.phone || leadData.waId || '');

    if (!phone10 || phone10.length < 10) {
      console.warn('[Firestore] createLead skipped — invalid phone:', leadData.phone);
      return null;
    }

    const now = new Date().toISOString();

    const doc = {
      // Identity
      phone:    leadData.phone || leadData.waId || '',
      phone10:  phone10,
      name:     (leadData.name || '').trim(),
      email:    (leadData.email || '').trim(),

      // Pipeline
      stage:    leadData.team || 'Not Assigned',
      status:   leadData.status || 'Lead',
      agent:    leadData.team || 'Not Assigned',

      // Lead info
      location: (leadData.location || '').trim(),
      product:  leadData.product || 'CGI',
      source:   (leadData.source || '').trim(),
      message:  (leadData.message || '').trim(),
      remark:   (leadData.remark || '').trim(),

      // Registration
      regiNo:   (leadData.regiNo || '').trim(),

      // Metadata
      createdAt: now,
      updatedAt: now,
      sheetRow:  leadData.sheetRow || null,

      // History — first entry
      history: [
        {
          action:  'lead_created',
          by:      'system',
          at:      now,
          details: {
            source:  leadData.source || '',
            channel: leadData.channel || 'webhook'
          }
        }
      ]
    };

    await firestore.collection(COLLECTION).doc(phone10).set(doc, { merge: false });
    console.log(`[Firestore] Lead created: ${phone10} (${doc.name})`);
    return { phone10, created: true };

  } catch (error) {
    // Non-blocking — Sheet already has the data
    console.error(`[Firestore] createLead error: ${error.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  UPDATE LEAD — partial update + history entry
//  Used when existing contact gets new data (message, remark, status change)
// ─────────────────────────────────────────────────────────────
async function updateLead(phone, updates, historyEntry) {
  try {
    const firestore = getDb();
    const phone10 = getLastTenDigits(phone);

    if (!phone10 || phone10.length < 10) {
      console.warn('[Firestore] updateLead skipped — invalid phone:', phone);
      return null;
    }

    const docRef = firestore.collection(COLLECTION).doc(phone10);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      console.log(`[Firestore] updateLead: ${phone10} not found, skipping`);
      return null;
    }

    const payload = {
      ...updates,
      updatedAt: new Date().toISOString()
    };

    // Append history entry if provided
    if (historyEntry) {
      payload.history = admin.firestore.FieldValue.arrayUnion({
        action:  historyEntry.action,
        by:      historyEntry.by || 'system',
        at:      new Date().toISOString(),
        details: historyEntry.details || {}
      });
    }

    await docRef.update(payload);
    console.log(`[Firestore] Lead updated: ${phone10}`);
    return { phone10, updated: true };

  } catch (error) {
    console.error(`[Firestore] updateLead error: ${error.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  GET LEAD BY PHONE — lookup for duplicate check
//  Phase 2+ will replace Sheet-based findUserByPhoneNumber
// ─────────────────────────────────────────────────────────────
async function getLeadByPhone(phone) {
  try {
    const firestore = getDb();
    const phone10 = getLastTenDigits(phone);

    if (!phone10 || phone10.length < 10) return null;

    const docSnap = await firestore.collection(COLLECTION).doc(phone10).get();

    if (!docSnap.exists) return null;

    return { phone10, data: docSnap.data() };

  } catch (error) {
    console.error(`[Firestore] getLeadByPhone error: ${error.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  ADD HISTORY — append a single history entry without other updates
//  Used for tracking calls, WhatsApp messages, etc.
// ─────────────────────────────────────────────────────────────
async function addHistory(phone, action, by, details = {}) {
  try {
    const firestore = getDb();
    const phone10 = getLastTenDigits(phone);

    if (!phone10 || phone10.length < 10) return null;

    const docRef = firestore.collection(COLLECTION).doc(phone10);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      console.log(`[Firestore] addHistory: ${phone10} not found, skipping`);
      return null;
    }

    await docRef.update({
      updatedAt: new Date().toISOString(),
      history: admin.firestore.FieldValue.arrayUnion({
        action,
        by:      by || 'system',
        at:      new Date().toISOString(),
        details
      })
    });

    console.log(`[Firestore] History added: ${phone10} → ${action}`);
    return { phone10, action };

  } catch (error) {
    console.error(`[Firestore] addHistory error: ${error.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  CREATE OR UPDATE — upsert logic
//  If doc exists: update fields + add history
//  If doc doesn't exist: create full document
// ─────────────────────────────────────────────────────────────
async function createOrUpdateLead(leadData, historyEntry) {
  try {
    const firestore = getDb();
    const phone10 = getLastTenDigits(leadData.phone || leadData.waId || '');

    if (!phone10 || phone10.length < 10) {
      console.warn('[Firestore] createOrUpdateLead skipped — invalid phone');
      return null;
    }

    const docRef = firestore.collection(COLLECTION).doc(phone10);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      // Existing lead — merge non-empty fields + append history
      const updates = {};
      if (leadData.name)     updates.name     = leadData.name;
      if (leadData.location) updates.location = leadData.location;
      if (leadData.email)    updates.email    = leadData.email;

      // Append message/remark instead of overwriting
      if (leadData.message) {
        const current = docSnap.data().message || '';
        updates.message = current ? `${current} | ${leadData.message}` : leadData.message;
      }
      if (leadData.remark) {
        const current = docSnap.data().remark || '';
        updates.remark = current ? `${current} | ${leadData.remark}` : leadData.remark;
      }

      return await updateLead(phone10, updates, historyEntry || {
        action: 'contact_updated',
        by: 'system',
        details: { source: leadData.source || '' }
      });

    } else {
      // New lead — create full document
      return await createLead(leadData);
    }

  } catch (error) {
    console.error(`[Firestore] createOrUpdateLead error: ${error.message}`);
    return null;
  }
}

module.exports = {
  createLead,
  updateLead,
  getLeadByPhone,
  addHistory,
  createOrUpdateLead,
  getDb   // exposed for Phase 2+ direct queries
};
