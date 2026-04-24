// ============================================================================
//  scripts/migrate-3a-rename.js — One-time Firestore migration for Part 3A
//
//  What this script does:
//    1. Renames stage values in 'leads' collection:
//         'payment_pending' → 'payment'
//         'delivery'        → 'fulfillment'
//       (In both the 'stage' and 'pipelineStage' fields.)
//    2. Renames Firestore fields in every lead doc:
//         deliveryStatus → fulfillmentStatus
//         deliveryDate   → fulfillmentDate
//         deliveryRemark → fulfillmentRemark
//       (Copies value, deletes old field.)
//
//  Run AFTER Part 3A code is deployed via Cloud Build.
//  Run BEFORE triggering any new sheet edits that would write with new names.
//
//  Usage:
//    1. Ensure GOOGLE_APPLICATION_CREDENTIALS env var points to a service account
//       JSON with Firestore admin permissions.
//    2. From repo root: node scripts/migrate-3a-rename.js
//    3. Verify output summary matches expected counts.
//    4. Spot-check 2-3 lead docs in Firestore console.
//
//  Safe to re-run: migrated docs are skipped (checked via presence of old
//  field names and old stage values).
// ============================================================================

const admin = require('firebase-admin');

// ── Initialize Firebase Admin ──────────────────────────────────────────────
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('ERROR: GOOGLE_APPLICATION_CREDENTIALS env var is not set.');
  console.error('Set it to the path of a service account JSON with Firestore admin access.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const COLLECTION = 'leads';


// ── Stage renames ──────────────────────────────────────────────────────────
const STAGE_RENAMES = {
  'payment_pending': 'payment',
  'delivery':        'fulfillment',
};

// ── Field renames ──────────────────────────────────────────────────────────
const FIELD_RENAMES = {
  deliveryStatus: 'fulfillmentStatus',
  deliveryDate:   'fulfillmentDate',
  deliveryRemark: 'fulfillmentRemark',
};


async function migrate() {
  console.log(`[migrate-3a] Starting migration on collection '${COLLECTION}'...`);
  console.log('[migrate-3a] Fetching all lead documents...');

  const snapshot = await db.collection(COLLECTION).get();
  console.log(`[migrate-3a] Found ${snapshot.size} lead documents.`);

  let stageRenameCount = 0;
  let fieldRenameCount = 0;
  let docsUpdated = 0;
  let docsSkipped = 0;
  const errors = [];

  // Process in batches of 450 (Firestore batch limit is 500; keep headroom)
  const BATCH_SIZE = 450;
  let batch = db.batch();
  let batchOps = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const updates = {};
    let docNeedsUpdate = false;

    // Stage renames (check both 'stage' and 'pipelineStage')
    for (const field of ['stage', 'pipelineStage']) {
      const current = data[field];
      if (current && STAGE_RENAMES[current]) {
        updates[field] = STAGE_RENAMES[current];
        stageRenameCount++;
        docNeedsUpdate = true;
      }
    }

    // Field renames
    for (const [oldName, newName] of Object.entries(FIELD_RENAMES)) {
      if (data[oldName] !== undefined) {
        updates[newName] = data[oldName];
        updates[oldName] = FieldValue.delete();
        fieldRenameCount++;
        docNeedsUpdate = true;
      }
    }

    if (docNeedsUpdate) {
      batch.update(doc.ref, updates);
      batchOps++;
      docsUpdated++;

      if (batchOps >= BATCH_SIZE) {
        try {
          await batch.commit();
          console.log(`[migrate-3a] Committed batch of ${batchOps} updates.`);
        } catch (err) {
          console.error(`[migrate-3a] Batch commit failed: ${err.message}`);
          errors.push({ batchSize: batchOps, error: err.message });
        }
        batch = db.batch();
        batchOps = 0;
      }
    } else {
      docsSkipped++;
    }
  }

  // Commit final partial batch
  if (batchOps > 0) {
    try {
      await batch.commit();
      console.log(`[migrate-3a] Committed final batch of ${batchOps} updates.`);
    } catch (err) {
      console.error(`[migrate-3a] Final batch commit failed: ${err.message}`);
      errors.push({ batchSize: batchOps, error: err.message });
    }
  }

  console.log('');
  console.log('── Migration summary ─────────────────────────────────────────');
  console.log(`Total docs scanned:     ${snapshot.size}`);
  console.log(`Docs updated:           ${docsUpdated}`);
  console.log(`Docs skipped (no-op):   ${docsSkipped}`);
  console.log(`Stage values renamed:   ${stageRenameCount}`);
  console.log(`Field names renamed:    ${fieldRenameCount} (per field, across all docs)`);
  console.log(`Batch errors:           ${errors.length}`);
  if (errors.length > 0) {
    console.log('Errors:');
    errors.forEach(e => console.log(`  - ${JSON.stringify(e)}`));
  }
  console.log('──────────────────────────────────────────────────────────────');

  if (errors.length > 0) {
    console.error('[migrate-3a] Migration completed WITH ERRORS. Review above and re-run if needed.');
    process.exit(1);
  }
  console.log('[migrate-3a] Migration complete.');
}


migrate().catch(err => {
  console.error('[migrate-3a] FATAL:', err);
  process.exit(1);
});
