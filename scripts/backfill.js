// ============================================================================
//  scripts/backfill.js — One-time migration: Sheet5 → Firestore
//
//  Run locally: node scripts/backfill.js
//
//  Reads all rows from Sheet5, creates/updates Firestore docs
//  with proper stage field based on Team + Status inference
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

function parseSheetDate(dateStr, timeStr) {
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
  console.log('Starting backfill...');

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

    const doc = {
      phone: row[4] || '',
      phoneNormalized: phone,
      phone10: phone,
      name: (row[3] || '').trim(),
      email: '',
      stage: stage,
      status: status || 'Lead',
      agent: team || 'Not Assigned',
      location: (row[6] || '').trim(),
      product: (row[7] || '').trim() || 'CGI',
      source: (row[9] || '').trim(),
      message: (row[8] || '').trim(),
      remark: (row[14] || '').trim(),
      regiNo: (row[5] || '').trim(),
      rating: (row[12] || '').trim(),
      team2: (row[15] || '').trim(),
      status2: (row[16] || '').trim(),
      remark2: (row[17] || '').trim(),
      createdDate: (row[1] || '').trim(),
      createdTime: (row[2] || '').trim(),
      createdAt: parseSheetDate(row[1], row[2]),
      updatedAt: new Date().toISOString(),
      sheetRow: i + 2,
      history: [{
        action: 'backfill_from_sheet',
        by: 'system',
        at: new Date().toISOString(),
        details: { source: 'phase3_migration', originalRow: i + 2 }
      }]
    };

    try {
      const docRef = db.collection('leads').doc(phone);
      const existing = await docRef.get();

      if (existing.exists) {
        // Merge: only update stage if not already set, keep existing history
        const existingData = existing.data();
        const updates = { updatedAt: new Date().toISOString() };

        if (!existingData.stage || existingData.stage === 'Not Assigned') {
          updates.stage = stage;
        }
        // Fill in any missing fields from sheet
        if (!existingData.name && doc.name) updates.name = doc.name;
        if (!existingData.location && doc.location) updates.location = doc.location;
        if (!existingData.source && doc.source) updates.source = doc.source;
        if (!existingData.createdDate && doc.createdDate) updates.createdDate = doc.createdDate;
        if (!existingData.createdTime && doc.createdTime) updates.createdTime = doc.createdTime;

        updates.history = admin.firestore.FieldValue.arrayUnion({
          action: 'backfill_merge',
          by: 'system',
          at: new Date().toISOString(),
          details: { source: 'phase3_migration' }
        });

        await docRef.update(updates);
        updated++;
      } else {
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
