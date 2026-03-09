// ============================================================================
//  handlers/stageHandler.js — Pipeline Stage Transitions
//
//  Handles: claimLead, transitionStage, confirmPayment, getLeadHistory
//  All mutations use Firestore transactions for atomicity
// ============================================================================

const admin = require('firebase-admin');
const FirestoreService = require('../services/firestoreService');
const config = require('../config');
const { normalizePhone } = require('../utils/helpers');

const LOG_PREFIX = '[Stage]';


// ═══════════════════════════════════════════════════════════════════════════
//  CLAIM LEAD
// ═══════════════════════════════════════════════════════════════════════════

async function claimLead(params) {
  const { phone, agentName, agentEmail } = params;
  const phoneNorm = normalizePhone(phone);

  if (!phoneNorm || phoneNorm.length < 10) {
    throw new Error('Invalid phone number');
  }

  const db = FirestoreService.getDb();

  // Find the lead first
  const existing = await FirestoreService.findLeadByPhone(phone);
  if (!existing) {
    throw new Error('Lead not found');
  }

  const docRef = db.collection('leads').doc(existing.docId);

  const result = await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(docRef);
    if (!doc.exists) throw new Error('Lead not found');

    const data = doc.data();
    const currentAgent = data.agent || 'Not Assigned';

    // Already claimed by someone else
    if (currentAgent !== 'Not Assigned' && currentAgent !== agentName) {
      return { claimed: false, claimedBy: currentAgent };
    }

    // Claim it
    const now = new Date().toISOString();
    transaction.update(docRef, {
      agent: agentName,
      stage: config.STAGES.AGENT_WORKING,
      updatedAt: now,
      history: admin.firestore.FieldValue.arrayUnion({
        action: 'claimed',
        by: agentName,
        at: now,
        details: { email: agentEmail || '' }
      })
    });

    return { claimed: true, agent: agentName };
  });

  console.log(`${LOG_PREFIX} Lead claim result: ${JSON.stringify(result)}`);
  return result;
}


// ═══════════════════════════════════════════════════════════════════════════
//  TRANSITION STAGE
// ═══════════════════════════════════════════════════════════════════════════

async function transitionStage(params) {
  const { phone, targetStage, by, reason } = params;
  const phoneNorm = normalizePhone(phone);

  if (!phoneNorm || phoneNorm.length < 10) {
    throw new Error('Invalid phone number');
  }

  const db = FirestoreService.getDb();

  // Find the lead first
  const existing = await FirestoreService.findLeadByPhone(phone);
  if (!existing) {
    throw new Error('Lead not found');
  }

  const docRef = db.collection('leads').doc(existing.docId);

  const result = await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(docRef);
    if (!doc.exists) throw new Error('Lead not found');

    const data = doc.data();
    const currentStage = data.stage || 'unclaimed';

    // Validate transition
    const allowed = config.ALLOWED_TRANSITIONS[currentStage] || [];
    if (!allowed.includes(targetStage)) {
      throw new Error(`Invalid transition: ${currentStage} → ${targetStage}. Allowed: ${allowed.join(', ')}`);
    }

    const now = new Date().toISOString();
    const updates = {
      stage: targetStage,
      updatedAt: now,
      history: admin.firestore.FieldValue.arrayUnion({
        action: 'stage_transition',
        by: by || 'system',
        at: now,
        details: { from: currentStage, to: targetStage, reason: reason || '' }
      })
    };

    // Stage-specific field updates
    if (targetStage === 'sales_review') {
      updates['approval'] = { approvedBy: null, date: null, notes: reason || '' };
    } else if (targetStage === 'payment_pending') {
      updates['approval'] = { approvedBy: by, date: now, notes: reason || '' };
    }

    transaction.update(docRef, updates);
    return { transitioned: true, from: currentStage, to: targetStage };
  });

  console.log(`${LOG_PREFIX} Stage transition: ${result.from} → ${result.to}`);
  return result;
}


// ═══════════════════════════════════════════════════════════════════════════
//  CONFIRM PAYMENT
// ═══════════════════════════════════════════════════════════════════════════

async function confirmPayment(params) {
  const { phone, amount, method, confirmedBy, notes } = params;
  const phoneNorm = normalizePhone(phone);

  if (!phoneNorm || phoneNorm.length < 10) {
    throw new Error('Invalid phone number');
  }

  const db = FirestoreService.getDb();

  // Find the lead first
  const existing = await FirestoreService.findLeadByPhone(phone);
  if (!existing) {
    throw new Error('Lead not found');
  }

  const docRef = db.collection('leads').doc(existing.docId);

  const result = await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(docRef);
    if (!doc.exists) throw new Error('Lead not found');

    const data = doc.data();
    if (data.stage !== 'payment_pending') {
      throw new Error(`Lead is in stage "${data.stage}", not payment_pending`);
    }

    const now = new Date().toISOString();
    transaction.update(docRef, {
      stage: config.STAGES.DELIVERY,
      'payment.confirmed': true,
      'payment.amount': amount || null,
      'payment.method': method || '',
      'payment.confirmedBy': confirmedBy || '',
      'payment.date': now,
      updatedAt: now,
      history: admin.firestore.FieldValue.arrayUnion({
        action: 'payment_confirmed',
        by: confirmedBy || 'system',
        at: now,
        details: { amount, method, notes: notes || '' }
      })
    });

    return { confirmed: true, nextStage: 'delivery' };
  });

  console.log(`${LOG_PREFIX} Payment confirmed for ${phoneNorm}`);
  return result;
}


// ═══════════════════════════════════════════════════════════════════════════
//  GET LEAD HISTORY
// ═══════════════════════════════════════════════════════════════════════════

async function getLeadHistory(params) {
  const { phone } = params;
  const lead = await FirestoreService.findLeadByPhone(phone);

  if (!lead) {
    return { found: false, history: [] };
  }

  return {
    found: true,
    phone: lead.data.phoneNormalized || lead.data.phone10 || '',
    name: lead.data.name || '',
    stage: lead.data.stage || 'unknown',
    agent: lead.data.agent || 'Not Assigned',
    history: lead.data.history || []
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  claimLead,
  transitionStage,
  confirmPayment,
  getLeadHistory,
};
