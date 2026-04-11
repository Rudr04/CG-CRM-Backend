// ============================================================================
//  services/firestoreService.js — Firestore CRM Database
//
//  Phase 2: Firestore-first (Firestore is source of truth, Sheets gets async backup)
//  Lead storage with history tracking. Uses centralized helpers.
// ============================================================================

const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const config = require('../config');
const { normalizePhone, cleanString, nowISO } = require('../utils/helpers');

const LOG_PREFIX = '[Firestore]';

let db = null;

const COLLECTION = config.FIRESTORE.COLLECTION;
const COUNTERS_DOC = config.FIRESTORE.COUNTERS_DOC;


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

  // Get current YYMM in IST
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const yy = String(ist.getFullYear()).slice(-2);
  const mm = String(ist.getMonth() + 1).padStart(2, '0');
  const period = `${yy}${mm}`;

  const counterRef = firestore.doc(`counters/cgid-${period}`);

  const newId = await firestore.runTransaction(async (transaction) => {
    const counterDoc = await transaction.get(counterRef);
    const nextNum = counterDoc.exists
      ? (counterDoc.data().leadCounter || 0) + 1
      : 1;

    transaction.set(counterRef, {
      leadCounter: nextNum,
      lastUpdated: nowISO()
    }, { merge: true });

    return nextNum;
  });

  return `CG-${period}-${newId}`;
  // No zero padding on the sequence number per spec
  // Transaction failure throws → createLead throws → buildWriteBoth catches → PendingQueue retries
}


// ═══════════════════════════════════════════════════════════════════════════
//  QUERIES
// ═══════════════════════════════════════════════════════════════════════════

async function findLeadByPhone(phone) {
  const firestore = getDb();
  const phoneNorm = normalizePhone(phone);

  if (!phoneNorm || phoneNorm.length < 10) return null;  // expected: bad input

  const snapshot = await firestore
    .collection(COLLECTION)
    .where('phoneNormalized', '==', phoneNorm)
    .limit(1)
    .get();

  if (snapshot.empty) return null;  // expected: lead doesn't exist

  const doc = snapshot.docs[0];
  return { docId: doc.id, data: doc.data() };
  // Firestore network/permission errors throw naturally — no catch
}


// ═══════════════════════════════════════════════════════════════════════════
//  CRUD
// ═══════════════════════════════════════════════════════════════════════════

async function createLead(leadData) {
  const firestore = getDb();
  const phone = leadData.phone || leadData.waId || '';
  const phoneNorm = normalizePhone(phone);

  if (!phoneNorm || phoneNorm.length < 10) {
    console.warn(`${LOG_PREFIX} createLead skipped — invalid phone: ${phone}`);
    return null;  // expected: bad input, can't create a lead without phone
  }

  const existing = await findLeadByPhone(phone);
  if (existing) {
    console.log(`${LOG_PREFIX} Lead exists: ${existing.data.cgId}`);
    return { docId: existing.docId, cgId: existing.data.cgId, created: false };  // expected: already exists
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
    stage: (!leadData.team || leadData.team === config.DEFAULTS.TEAM)
      ? config.STAGES.NOT_ASSIGNED
      : config.STAGES.AGENT_WORKING,
    status: leadData.status || config.DEFAULTS.STATUS,
    agent: leadData.team || config.DEFAULTS.TEAM,
    location: cleanString(leadData.location),
    inquiry: leadData.inquiry || config.DEFAULTS.INQUIRY,
    product: cleanString(leadData.product),
    pipelineStage: leadData.pipelineStage || '',
    source: cleanString(leadData.source),
    message: cleanString(leadData.message),
    remark: cleanString(leadData.remark),
    regiNo: cleanString(leadData.regiNo),
    rating: '',
    cbDate: '',
    salesRemark: '',
    approvalDate: '',
    quantity: '',
    productPrice: '',
    amountPaid: '',
    pendingAmount: '',
    modeOfPay: '',
    paymentRefId: '',
    dateOfPayment: '',
    receivedAccount: '',
    deliveryStatus: '',
    deliveryDate: '',
    deliveryRemark: '',
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
  // Firestore errors throw naturally → caught by buildWriteBoth → PendingQueue retries
}

async function updateLead(phone, updates, historyEntry) {
  const firestore = getDb();
  const existing = await findLeadByPhone(phone);

  if (!existing) {
    console.log(`${LOG_PREFIX} updateLead: not found ${normalizePhone(phone)}`);
    return null;  // expected: lead doesn't exist, nothing to update
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
  // Firestore errors throw naturally → caught by caller
}

async function addHistory(phone, action, by, details = {}) {
  const existing = await findLeadByPhone(phone);
  if (!existing) return null;  // expected: lead not found

  const firestore = getDb();
  await firestore.collection(COLLECTION).doc(existing.docId).update({
    updatedAt: nowISO(),
    history: FieldValue.arrayUnion({
      action, by: by || 'system', at: nowISO(), details
    })
  });

  console.log(`${LOG_PREFIX} History added: ${existing.data.cgId} → ${action}`);
  return { docId: existing.docId, cgId: existing.data.cgId, action };
  // Firestore errors throw naturally
}

async function createOrUpdateLead(leadData, historyEntry) {
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
    if (leadData.inquiry) {
      const currentInquiry = existing.data.inquiry || '';
      if (!currentInquiry.split(', ').includes(leadData.inquiry)) {
        updates.inquiry = currentInquiry ? `${currentInquiry}, ${leadData.inquiry}` : leadData.inquiry;
      }
    }
    if (leadData.product) {
      const currentProduct = existing.data.product || '';
      if (!currentProduct.split(', ').includes(leadData.product)) {
        updates.product = currentProduct ? `${currentProduct}, ${leadData.product}` : leadData.product;
      }
    }
    if (leadData.pipelineStage) updates.pipelineStage = leadData.pipelineStage;

    const overwriteFields = [
      'rating', 'cbDate',
      'salesRemark', 'approvalDate',
      'quantity', 'productPrice', 'amountPaid', 'pendingAmount',
      'modeOfPay', 'paymentRefId', 'dateOfPayment', 'receivedAccount',
      'deliveryStatus', 'deliveryDate', 'deliveryRemark',
    ];

    for (const field of overwriteFields) {
      if (leadData[field] !== undefined && leadData[field] !== '') {
        updates[field] = leadData[field];
      }
    }

    return await updateLead(phone, updates, historyEntry || {
      action: 'contact_updated', by: 'system', details: { source: leadData.source || '' }
    });
  }

  return await createLead(leadData);
  // No try-catch. All errors propagate to buildWriteBoth → tryWriteOrQueue → PendingQueue
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
};