// ============================================================================
//  scripts/backfill.js — One-time migration: Sheet5 → Firestore
//
//  Run locally: node scripts/backfill.js
//
//  Reads all rows from Sheet5, creates/updates Firestore docs
//  with proper stage field, CGID generation, and Phase 3 fields
// ============================================================================

require('dotenv').config();
const admin = require('firebase-admin');
const { google } = require('googleapis');

// Initialize
if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}
const db = admin.firestore();


// ═══════════════════════════════════════════════════════════════════════════
//  CGID GENERATION — same atomic counter as firestoreService
// ═══════════════════════════════════════════════════════════════════════════

async function generateCGID() {
  const now = new Date();
  const monthKey = String(now.getFullYear()).slice(-2)
                 + String(now.getMonth() + 1).padStart(2, '0');

  const counterRef = db.doc('counters/cgid');

  const cgid = await db.runTransaction(async (t) => {
    const doc = await t.get(counterRef);
    const data = doc.exists ? doc.data() : {};
    const current = data[monthKey] || 0;
    const next = current + 1;
    t.set(counterRef, { [monthKey]: next }, { merge: true });
    return `CG-${monthKey}-${next}`;
  });

  return cgid;
}


// ═══════════════════════════════════════════════════════════════════════════
//  STAGE INFERENCE
// ═══════════════════════════════════════════════════════════════════════════

function inferStage(team, status) {
  if (!team || team === 'Not Assigned') return 'unclaimed';
  if (team === 'ROBO') return 'agent_working';

  const s = (status || '').toLowerCase();
  if (s.includes('converted') || s.includes('admission') || s.includes('seat booked') || s.includes('fees received')) {
    return 'sales_review';
  }
  if (s === 'not interested') return 'dead';
  return 'agent_working';
}


// ═══════════════════════════════════════════════════════════════════════════
//  DATE PARSER
// ═══════════════════════════════════════════════════════════════════════════

function parseSheetDate(dateStr) {
  try {
    if (!dateStr) return new Date().toISOString();
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  MAIN BACKFILL
// ═══════════════════════════════════════════════════════════════════════════

async function backfill() {
  console.log('Starting Phase 3 backfill with CGID generation...');

  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'Sheet5!A2:AA'
  });

  const rows = response.data.values || [];
  console.log(`Found ${rows.length} rows`);

  let created = 0, updated = 0, skipped = 0, errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const phone = (row[4] || '').toString().replace(/\D/g, '').slice(-10);

    if (!phone || phone.length < 10) {
      skipped++;
      continue;
    }

    const team = (row[10] || '').trim();
    const status = (row[11] || '').trim();
    const stage = inferStage(team, status);

    try {
      const docRef = db.collection('leads').doc(phone);
      const existing = await docRef.get();

      if (existing.exists) {
        // Merge: only update stage if not already set, keep existing history
        const existingData = existing.data();
        const updates = { updatedAt: new Date().toISOString() };

        // Generate CGID if missing
        if (!existingData.cgid) {
          updates.cgid = await generateCGID();
          updates.cgId = updates.cgid; // backward compat
        }

        if (!existingData.stage || existingData.stage === 'Not Assigned') {
          updates.stage = stage;
        }
        // Fill in any missing fields from sheet
        if (!existingData.name && (row[3] || '').trim()) updates.name = (row[3] || '').trim();
        if (!existingData.location && (row[6] || '').trim()) updates.location = (row[6] || '').trim();
        if (!existingData.source && (row[9] || '').trim()) updates.source = (row[9] || '').trim();
        if (!existingData.date && (row[1] || '').trim()) updates.date = (row[1] || '').trim();
        if (!existingData.time && (row[2] || '').trim()) updates.time = (row[2] || '').trim();

        // Ensure Phase 3 fields exist
        if (!existingData.inq) updates.inq = '';
        if (!existingData.cbDate) updates.cbDate = '';
        if (!existingData.salesRemark) updates.salesRemark = '';
        if (!existingData.approvalDate) updates.approvalDate = '';
        if (!existingData.quantity) updates.quantity = '';
        if (!existingData.productPrice) updates.productPrice = '';
        if (!existingData.amountPaid) updates.amountPaid = '';
        if (!existingData.pendingAmount) updates.pendingAmount = '';
        if (!existingData.modeOfPay) updates.modeOfPay = '';
        if (!existingData.paymentRefId) updates.paymentRefId = '';
        if (!existingData.dateOfPayment) updates.dateOfPayment = '';
        if (!existingData.receivedAccount) updates.receivedAccount = '';
        if (!existingData.deliveryStatus) updates.deliveryStatus = '';
        if (!existingData.deliveryDate) updates.deliveryDate = '';
        if (!existingData.deliveryRemark) updates.deliveryRemark = '';
        if (!existingData.mobile) updates.mobile = row[4] || '';

        updates.history = admin.firestore.FieldValue.arrayUnion({
          action: 'backfill_merge',
          by: 'system',
          at: new Date().toISOString(),
          details: { source: 'phase3_migration' }
        });

        await docRef.update(updates);
        updated++;
      } else {
        // Generate CGID for new doc
        const cgid = await generateCGID();

        const doc = {
          cgid,
          cgId: cgid, // backward compat
          phone: row[4] || '',
          phoneNormalized: phone,
          phone10: phone,
          mobile: row[4] || '',
          name: (row[3] || '').trim(),
          email: '',
          stage,
          status: status || 'Lead',
          agent: team || 'Not Assigned',
          team: team || 'Not Assigned',
          location: (row[6] || '').trim(),
          inq: '',
          product: (row[7] || '').trim() || 'CGI',
          source: (row[9] || '').trim(),
          message: (row[8] || '').trim(),
          remark: (row[14] || '').trim(),
          cbDate: '',
          rating: (row[12] || '').trim(),
          regiNo: (row[5] || '').trim(),

          // Sales fields
          salesRemark: '',
          approvalDate: '',

          // Payment fields
          quantity: '',
          productPrice: '',
          amountPaid: '',
          pendingAmount: '',
          modeOfPay: '',
          paymentRefId: '',
          dateOfPayment: '',
          receivedAccount: '',

          // Delivery fields
          deliveryStatus: '',
          deliveryDate: '',
          deliveryRemark: '',

          // Metadata
          date: (row[1] || '').trim(),
          time: (row[2] || '').trim(),
          createdAt: parseSheetDate(row[1]),
          updatedAt: new Date().toISOString(),
          sheetRow: i + 2,
          history: [{
            action: 'backfill_from_sheet',
            by: 'system',
            at: new Date().toISOString(),
            details: { source: 'phase3_migration', originalRow: i + 2, cgid }
          }]
        };

        await docRef.set(doc);
        created++;
      }

      if ((created + updated) % 100 === 0) {
        console.log(`Progress: ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors`);
      }
    } catch (err) {
      console.error(`Row ${i + 2} (${phone}): ${err.message}`);
      errors++;
    }
  }

  console.log(`\nBackfill complete:`);
  console.log(`  Created: ${created}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors:  ${errors}`);
}

backfill().catch(console.error);
