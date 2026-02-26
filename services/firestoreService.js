// ============================================================================
//  services/firestoreService.js — Firestore CRM Database
//
//  Lead storage with history tracking. Uses centralized helpers.
// ============================================================================

const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const config = require('../config');
const { normalizePhone, cleanString, nowISO } = require('../utils/helpers');

const LOG_PREFIX = '[Firestore]';

let db = null;

const COLLECTION = 'leads';
const COUNTERS_DOC = 'system/counters';
const FAILED_SYNCS_COLLECTION = 'sync_failures';


// ═══════════════════════════════════════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

function getDb() {
  if (!db) {
    if (!admin.apps.length) {
      admin.initializeApp({
        databaseURL: config.FIREBASE.DATABASE_URL
      });
    }
    db = getFirestore();
    console.log(`${LOG_PREFIX} Initialized`);
  }
  return db;
}


// ═══════════════════════════════════════════════════════════════════════════
//  COUNTRY CODE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

const COUNTRY_CODES = {
  '91': { iso: 'IN', name: 'India' },
  '1': { iso: 'US', name: 'USA/Canada' },
  '971': { iso: 'AE', name: 'UAE' },
  '65': { iso: 'SG', name: 'Singapore' },
  '44': { iso: 'GB', name: 'UK' },
  '61': { iso: 'AU', name: 'Australia' },
  '81': { iso: 'JP', name: 'Japan' },
  '49': { iso: 'DE', name: 'Germany' },
  '33': { iso: 'FR', name: 'France' },
  '86': { iso: 'CN', name: 'China' },
  '7': { iso: 'RU', name: 'Russia' },
  '92': { iso: 'PK', name: 'Pakistan' },
  '880': { iso: 'BD', name: 'Bangladesh' },
  '94': { iso: 'LK', name: 'Sri Lanka' },
  '977': { iso: 'NP', name: 'Nepal' },
  '966': { iso: 'SA', name: 'Saudi Arabia' },
  '974': { iso: 'QA', name: 'Qatar' },
  '968': { iso: 'OM', name: 'Oman' },
  '973': { iso: 'BH', name: 'Bahrain' },
  '965': { iso: 'KW', name: 'Kuwait' },
};

function extractCountryInfo(phone) {
  const digits = normalizePhone(phone);
  for (const len of [3, 2, 1]) {
    const prefix = digits.substring(0, len);
    if (COUNTRY_CODES[prefix]) {
      return {
        ...COUNTRY_CODES[prefix],
        countryCode: '+' + prefix,
        localNumber: digits.substring(len)
      };
    }
  }
  return { iso: 'XX', name: 'Unknown', countryCode: '', localNumber: digits };
}


// ═══════════════════════════════════════════════════════════════════════════
//  CGID GENERATION
// ═══════════════════════════════════════════════════════════════════════════

async function getNextCgId() {
  const firestore = getDb();
  const counterRef = firestore.doc(COUNTERS_DOC);
  
  try {
    const newId = await firestore.runTransaction(async (transaction) => {
      const counterDoc = await transaction.get(counterRef);
      let nextNum = counterDoc.exists ? (counterDoc.data().leadCounter || 0) + 1 : 1;
      
      transaction.set(counterRef, { 
        leadCounter: nextNum,
        lastUpdated: nowISO()
      }, { merge: true });
      
      return nextNum;
    });
    
    return `CG${String(newId).padStart(5, '0')}`;
  } catch (error) {
    console.error(`${LOG_PREFIX} getNextCgId error: ${error.message}`);
    return `CG${Date.now().toString(36).toUpperCase()}`;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  QUERIES
// ═══════════════════════════════════════════════════════════════════════════

async function findLeadByPhone(phone) {
  try {
    const firestore = getDb();
    const phoneNorm = normalizePhone(phone);
    
    if (!phoneNorm || phoneNorm.length < 10) return null;
    
    const snapshot = await firestore
      .collection(COLLECTION)
      .where('phoneNormalized', '==', phoneNorm)
      .limit(1)
      .get();
    
    if (snapshot.empty) return null;
    
    const doc = snapshot.docs[0];
    return { docId: doc.id, data: doc.data() };
  } catch (error) {
    console.error(`${LOG_PREFIX} findLeadByPhone error: ${error.message}`);
    return null;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  CRUD
// ═══════════════════════════════════════════════════════════════════════════

async function createLead(leadData) {
  try {
    const firestore = getDb();
    const phone = leadData.phone || leadData.waId || '';
    const phoneNorm = normalizePhone(phone);

    if (!phoneNorm || phoneNorm.length < 10) {
      console.warn(`${LOG_PREFIX} createLead skipped — invalid phone: ${phone}`);
      return null;
    }

    const existing = await findLeadByPhone(phone);
    if (existing) {
      console.log(`${LOG_PREFIX} Lead exists: ${existing.data.cgId}`);
      return { docId: existing.docId, cgId: existing.data.cgId, created: false };
    }

    const cgId = await getNextCgId();
    const now = nowISO();
    const countryInfo = extractCountryInfo(phone);

    const doc = {
      cgId,
      phone,
      phoneNormalized: phoneNorm,
      countryISO: countryInfo.iso,
      countryCode: countryInfo.countryCode,
      localNumber: countryInfo.localNumber,
      name: cleanString(leadData.name || leadData.senderName),
      email: cleanString(leadData.email),
      stage: leadData.team || config.STAGES.NOT_ASSIGNED,
      status: leadData.status || config.DEFAULTS.STATUS,
      agent: leadData.team || config.STAGES.NOT_ASSIGNED,
      location: cleanString(leadData.location),
      product: leadData.product || config.DEFAULTS.PRODUCT,
      source: cleanString(leadData.source),
      message: cleanString(leadData.message),
      remark: cleanString(leadData.remark),
      regiNo: cleanString(leadData.regiNo),
      createdAt: now,
      updatedAt: now,
      sheetRow: leadData.sheetRow || null,
      history: [{
        action: 'lead_created',
        by: 'system',
        at: now,
        details: { source: leadData.source || '', channel: leadData.channel || 'webhook' }
      }]
    };

    const docRef = await firestore.collection(COLLECTION).add(doc);
    console.log(`${LOG_PREFIX} Lead created: ${cgId} (${docRef.id})`);
    return { docId: docRef.id, cgId, created: true };

  } catch (error) {
    console.error(`${LOG_PREFIX} createLead error: ${error.message}`);
    return null;
  }
}

async function updateLead(phone, updates, historyEntry) {
  try {
    const firestore = getDb();
    const existing = await findLeadByPhone(phone);
    
    if (!existing) {
      console.log(`${LOG_PREFIX} updateLead: not found ${normalizePhone(phone)}`);
      return null;
    }

    const docRef = firestore.collection(COLLECTION).doc(existing.docId);
    const payload = { ...updates, updatedAt: nowISO() };

    if (historyEntry) {
      payload.history = FieldValue.arrayUnion({
        action: historyEntry.action,
        by: historyEntry.by || 'system',
        at: nowISO(),
        details: historyEntry.details || {}
      });
    }

    await docRef.update(payload);
    console.log(`${LOG_PREFIX} Lead updated: ${existing.data.cgId}`);
    return { docId: existing.docId, cgId: existing.data.cgId, updated: true };

  } catch (error) {
    console.error(`${LOG_PREFIX} updateLead error: ${error.message}`);
    return null;
  }
}

async function addHistory(phone, action, by, details = {}) {
  try {
    const existing = await findLeadByPhone(phone);
    if (!existing) return null;

    const firestore = getDb();
    await firestore.collection(COLLECTION).doc(existing.docId).update({
      updatedAt: nowISO(),
      history: FieldValue.arrayUnion({
        action, by: by || 'system', at: nowISO(), details
      })
    });

    console.log(`${LOG_PREFIX} History added: ${existing.data.cgId} → ${action}`);
    return { docId: existing.docId, cgId: existing.data.cgId, action };
  } catch (error) {
    console.error(`${LOG_PREFIX} addHistory error: ${error.message}`);
    return null;
  }
}

async function createOrUpdateLead(leadData, historyEntry) {
  try {
    const phone = leadData.phone || leadData.waId || '';
    const existing = await findLeadByPhone(phone);

    if (existing) {
      const updates = {};
      if (leadData.name) updates.name = leadData.name;
      if (leadData.location) updates.location = leadData.location;
      if (leadData.email) updates.email = leadData.email;
      if (leadData.message) {
        const current = existing.data.message || '';
        updates.message = current ? `${current} | ${leadData.message}` : leadData.message;
      }
      if (leadData.remark) {
        const current = existing.data.remark || '';
        updates.remark = current ? `${current} | ${leadData.remark}` : leadData.remark;
      }
      return await updateLead(phone, updates, historyEntry || {
        action: 'contact_updated', by: 'system', details: { source: leadData.source || '' }
      });
    }

    return await createLead(leadData);
  } catch (error) {
    console.error(`${LOG_PREFIX} createOrUpdateLead error: ${error.message}`);
    return null;
  }
}

async function storeSyncFailure(edit, error) {
  try {
    const firestore = getDb();
    await firestore.collection(FAILED_SYNCS_COLLECTION).add({
      edit,
      error: error.message || error.toString(),
      createdAt: nowISO(),
      retryCount: edit.retryCount || 0,
      resolved: false
    });
    console.log(`${LOG_PREFIX} Sync failure stored`);
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to store sync failure: ${err.message}`);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  getDb,
  findLeadByPhone,
  createLead,
  updateLead,
  addHistory,
  createOrUpdateLead,
  getNextCgId,
  extractCountryInfo,
  storeSyncFailure,
};