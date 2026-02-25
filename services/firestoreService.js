// ============================================================================
// firestoreService.js — Firestore Lead Database
//
// DOCUMENT STRUCTURE:
//   Document ID: Firestore auto-generated
//   cgId:        Business reference (CG00001, CG00002, ...)
//   phone:       Original format (+919876543210)
//   phoneNormalized: For querying (919876543210) — INDEXED
//
// PHASE 1: Parallel write (Sheets remains source of truth, Firestore gets copy)
// ============================================================================

const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const config = require('../config');

let db = null;

// ─────────────────────────────────────────────────────────────
//  INIT — lazy singleton, reused across Cloud Function invocations
// ─────────────────────────────────────────────────────────────
function getDb() {
  if (!db) {
    if (!admin.apps.length) {
      admin.initializeApp({
        databaseURL: config.FIREBASE.DATABASE_URL
      });
    }
    db = getFirestore();
    console.log('[Firestore] Initialized');
  }
  return db;
}

const COLLECTION = 'leads';
const COUNTERS_DOC = 'system/counters';
const FAILED_SYNCS_COLLECTION = 'sync_failures';


// ─────────────────────────────────────────────────────────────
//  PHONE NORMALIZATION — strip all non-digits, keep country code
// ─────────────────────────────────────────────────────────────
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.toString().replace(/\D/g, '');
}

// Extract country info from phone (simple embedded lookup)
const COUNTRY_CODES = {
  '91':  { iso: 'IN', name: 'India' },
  '1':   { iso: 'US', name: 'USA/Canada' },
  '971': { iso: 'AE', name: 'UAE' },
  '65':  { iso: 'SG', name: 'Singapore' },
  '44':  { iso: 'GB', name: 'UK' },
  '55':  { iso: 'BR', name: 'Brazil' },
  '61':  { iso: 'AU', name: 'Australia' },
  '81':  { iso: 'JP', name: 'Japan' },
  '49':  { iso: 'DE', name: 'Germany' },
  '33':  { iso: 'FR', name: 'France' },
  '86':  { iso: 'CN', name: 'China' },
  '82':  { iso: 'KR', name: 'South Korea' },
  '7':   { iso: 'RU', name: 'Russia' },
  '39':  { iso: 'IT', name: 'Italy' },
  '34':  { iso: 'ES', name: 'Spain' },
  '31':  { iso: 'NL', name: 'Netherlands' },
  '46':  { iso: 'SE', name: 'Sweden' },
  '41':  { iso: 'CH', name: 'Switzerland' },
  '62':  { iso: 'ID', name: 'Indonesia' },
  '60':  { iso: 'MY', name: 'Malaysia' },
  '66':  { iso: 'TH', name: 'Thailand' },
  '84':  { iso: 'VN', name: 'Vietnam' },
  '63':  { iso: 'PH', name: 'Philippines' },
  '92':  { iso: 'PK', name: 'Pakistan' },
  '880': { iso: 'BD', name: 'Bangladesh' },
  '94':  { iso: 'LK', name: 'Sri Lanka' },
  '977': { iso: 'NP', name: 'Nepal' },
  '27':  { iso: 'ZA', name: 'South Africa' },
  '234': { iso: 'NG', name: 'Nigeria' },
  '254': { iso: 'KE', name: 'Kenya' },
  '20':  { iso: 'EG', name: 'Egypt' },
  '966': { iso: 'SA', name: 'Saudi Arabia' },
  '974': { iso: 'QA', name: 'Qatar' },
  '968': { iso: 'OM', name: 'Oman' },
  '973': { iso: 'BH', name: 'Bahrain' },
  '965': { iso: 'KW', name: 'Kuwait' },
};

function extractCountryInfo(phone) {
  const digits = normalizePhone(phone);
  // Check 3-digit codes first, then 2, then 1
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


// ─────────────────────────────────────────────────────────────
//  CGID GENERATION — Sequential business ID (CG00001)
//  Uses Firestore transaction for atomic increment
// ─────────────────────────────────────────────────────────────
async function getNextCgId() {
  const firestore = getDb();
  const counterRef = firestore.doc(COUNTERS_DOC);
  
  try {
    const newId = await firestore.runTransaction(async (transaction) => {
      const counterDoc = await transaction.get(counterRef);
      
      let nextNum = 1;
      if (counterDoc.exists) {
        nextNum = (counterDoc.data().leadCounter || 0) + 1;
      }
      
      transaction.set(counterRef, { 
        leadCounter: nextNum,
        lastUpdated: new Date().toISOString()
      }, { merge: true });
      
      return nextNum;
    });
    
    // Format: CG00001 (5 digits, zero-padded)
    return `CG${String(newId).padStart(5, '0')}`;
    
  } catch (error) {
    console.error(`[Firestore] getNextCgId error: ${error.message}`);
    // Fallback: timestamp-based ID if counter fails
    return `CG${Date.now().toString(36).toUpperCase()}`;
  }
}


// ─────────────────────────────────────────────────────────────
//  FIND LEAD BY PHONE — Query by normalized phone number
//  Returns { docId, data } or null
// ─────────────────────────────────────────────────────────────
async function findLeadByPhone(phone) {
  try {
    const firestore = getDb();
    const phoneNorm = normalizePhone(phone);
    
    if (!phoneNorm || phoneNorm.length < 10) {
      return null;
    }
    
    const snapshot = await firestore
      .collection(COLLECTION)
      .where('phoneNormalized', '==', phoneNorm)
      .limit(1)
      .get();
    
    if (snapshot.empty) {
      return null;
    }
    
    const doc = snapshot.docs[0];
    return { 
      docId: doc.id, 
      data: doc.data() 
    };
    
  } catch (error) {
    console.error(`[Firestore] findLeadByPhone error: ${error.message}`);
    return null;
  }
}


// ─────────────────────────────────────────────────────────────
//  CREATE LEAD — New document with auto-ID and cgId
// ─────────────────────────────────────────────────────────────
async function createLead(leadData) {
  try {
    const firestore = getDb();
    const phone = leadData.phone || leadData.waId || '';
    const phoneNorm = normalizePhone(phone);

    if (!phoneNorm || phoneNorm.length < 10) {
      console.warn('[Firestore] createLead skipped — invalid phone:', phone);
      return null;
    }

    // Check for existing lead
    const existing = await findLeadByPhone(phone);
    if (existing) {
      console.log(`[Firestore] Lead already exists: ${existing.data.cgId} (${phoneNorm})`);
      return { docId: existing.docId, cgId: existing.data.cgId, created: false };
    }

    // Generate cgId
    const cgId = await getNextCgId();
    const now = new Date().toISOString();
    
    // Extract country info
    const countryInfo = extractCountryInfo(phone);

    const doc = {
      // Identity
      cgId:            cgId,
      phone:           phone,
      phoneNormalized: phoneNorm,
      countryISO:      countryInfo.iso,
      countryCode:     countryInfo.countryCode,
      localNumber:     countryInfo.localNumber,
      
      name:            (leadData.name || leadData.senderName || '').trim(),
      email:           (leadData.email || '').trim(),

      // Pipeline
      stage:    leadData.team || config.STAGES.NOT_ASSIGNED,
      status:   leadData.status || 'Lead',
      agent:    leadData.team || config.STAGES.NOT_ASSIGNED,

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

    // Create with auto-generated ID
    const docRef = await firestore.collection(COLLECTION).add(doc);
    
    console.log(`[Firestore] Lead created: ${cgId} (docId: ${docRef.id}, phone: ${phoneNorm})`);
    return { docId: docRef.id, cgId: cgId, created: true };

  } catch (error) {
    console.error(`[Firestore] createLead error: ${error.message}`);
    return null;
  }
}


// ─────────────────────────────────────────────────────────────
//  UPDATE LEAD — Partial update + history entry
//  Looks up document by phone number
// ─────────────────────────────────────────────────────────────
async function updateLead(phone, updates, historyEntry) {
  try {
    const firestore = getDb();
    
    // Find document by phone
    const existing = await findLeadByPhone(phone);
    
    if (!existing) {
      console.log(`[Firestore] updateLead: ${normalizePhone(phone)} not found`);
      return null;
    }

    const docRef = firestore.collection(COLLECTION).doc(existing.docId);
    
    const payload = {
      ...updates,
      updatedAt: new Date().toISOString()
    };

    // Append history entry if provided
    if (historyEntry) {
      payload.history = FieldValue.arrayUnion({
        action:  historyEntry.action,
        by:      historyEntry.by || 'system',
        at:      new Date().toISOString(),
        details: historyEntry.details || {}
      });
    }

    await docRef.update(payload);
    console.log(`[Firestore] Lead updated: ${existing.data.cgId}`);
    return { docId: existing.docId, cgId: existing.data.cgId, updated: true };

  } catch (error) {
    console.error(`[Firestore] updateLead error: ${error.message}`);
    return null;
  }
}


// ─────────────────────────────────────────────────────────────
//  GET LEAD BY PHONE — Public wrapper
// ─────────────────────────────────────────────────────────────
async function getLeadByPhone(phone) {
  return await findLeadByPhone(phone);
}


// ─────────────────────────────────────────────────────────────
//  GET LEAD BY CGID — Lookup by business ID
// ─────────────────────────────────────────────────────────────
async function getLeadByCgId(cgId) {
  try {
    const firestore = getDb();
    
    const snapshot = await firestore
      .collection(COLLECTION)
      .where('cgId', '==', cgId)
      .limit(1)
      .get();
    
    if (snapshot.empty) return null;
    
    const doc = snapshot.docs[0];
    return { docId: doc.id, data: doc.data() };
    
  } catch (error) {
    console.error(`[Firestore] getLeadByCgId error: ${error.message}`);
    return null;
  }
}


// ─────────────────────────────────────────────────────────────
//  ADD HISTORY — Append a single history entry
// ─────────────────────────────────────────────────────────────
async function addHistory(phone, action, by, details = {}) {
  try {
    const existing = await findLeadByPhone(phone);
    
    if (!existing) {
      console.log(`[Firestore] addHistory: ${normalizePhone(phone)} not found`);
      return null;
    }

    const firestore = getDb();
    const docRef = firestore.collection(COLLECTION).doc(existing.docId);

    await docRef.update({
      updatedAt: new Date().toISOString(),
      history: FieldValue.arrayUnion({
        action,
        by:      by || 'system',
        at:      new Date().toISOString(),
        details
      })
    });

    console.log(`[Firestore] History added: ${existing.data.cgId} → ${action}`);
    return { docId: existing.docId, cgId: existing.data.cgId, action };

  } catch (error) {
    console.error(`[Firestore] addHistory error: ${error.message}`);
    return null;
  }
}


// ─────────────────────────────────────────────────────────────
//  CREATE OR UPDATE — Upsert logic
// ─────────────────────────────────────────────────────────────
async function createOrUpdateLead(leadData, historyEntry) {
  try {
    const phone = leadData.phone || leadData.waId || '';
    const existing = await findLeadByPhone(phone);

    if (existing) {
      // Existing lead — merge non-empty fields
      const updates = {};
      if (leadData.name)     updates.name     = leadData.name;
      if (leadData.location) updates.location = leadData.location;
      if (leadData.email)    updates.email    = leadData.email;

      // Append message/remark
      if (leadData.message) {
        const current = existing.data.message || '';
        updates.message = current ? `${current} | ${leadData.message}` : leadData.message;
      }
      if (leadData.remark) {
        const current = existing.data.remark || '';
        updates.remark = current ? `${current} | ${leadData.remark}` : leadData.remark;
      }

      return await updateLead(phone, updates, historyEntry || {
        action: 'contact_updated',
        by: 'system',
        details: { source: leadData.source || '' }
      });

    } else {
      // New lead
      return await createLead(leadData);
    }

  } catch (error) {
    console.error(`[Firestore] createOrUpdateLead error: ${error.message}`);
    return null;
  }
}


// ─────────────────────────────────────────────────────────────
//  STORE SYNC FAILURE — For retry tracking
// ─────────────────────────────────────────────────────────────
async function storeSyncFailure(edit, error) {
  try {
    const firestore = getDb();
    
    await firestore.collection(FAILED_SYNCS_COLLECTION).add({
      edit:       edit,
      error:      error.message || error.toString(),
      createdAt:  new Date().toISOString(),
      retryCount: edit.retryCount || 0,
      resolved:   false
    });
    
    console.log(`[Firestore] Sync failure stored for phone ${edit.phone}`);
    
  } catch (err) {
    console.error(`[Firestore] Failed to store sync failure: ${err.message}`);
  }
}


// ─────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────
module.exports = {
  // Core CRUD
  createLead,
  updateLead,
  getLeadByPhone,
  getLeadByCgId,
  addHistory,
  createOrUpdateLead,
  
  // Utilities
  findLeadByPhone,
  getNextCgId,
  normalizePhone,
  extractCountryInfo,
  storeSyncFailure,
  
  // For advanced queries
  getDb
};