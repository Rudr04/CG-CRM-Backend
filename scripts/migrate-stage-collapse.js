// ============================================================================
//  scripts/migrate-stage-collapse.js — One-time Firestore migration
//
//  What this script does:
//    Collapses the duplicated 'stage' and 'pipelineStage' fields in every
//    lead document. After this migration, only 'pipelineStage' remains.
//
//    Per-doc rules:
//      a. Has 'stage' but no 'pipelineStage' → copy stage value to
//         pipelineStage, then delete the 'stage' field.
//      b. Has both 'stage' and 'pipelineStage' → delete the 'stage' field.
//         pipelineStage is canonical; its value is preserved as-is.
//      c. Has only 'pipelineStage' → already migrated, skip.
//      d. Has neither → log a warning with cgId, skip.
//
//  Run AFTER the stage→pipelineStage collapse code is deployed via Cloud
//  Build, and BEFORE any new stage transition fires on a pre-existing lead.
//
//  Usage:
//    1. Ensure GOOGLE_APPLICATION_CREDENTIALS env var points to a service
//       account JSON with Firestore admin permissions.
//    2. From repo root: node scripts/migrate-stage-collapse.js
//    3. Verify output summary matches expected counts.
//    4. Spot-check 2-3 lead docs in Firestore console — confirm 'stage'
//       field is gone and 'pipelineStage' holds the expected value.
//
//  Safe to re-run: docs without a 'stage' field are skipped.
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


async function migrate() {
  console.log(`[migrate-stage-collapse] Starting migration on collection '${COLLECTION}'...`);
  console.log('[migrate-stage-collapse] Fetching all lead documents...');

  const snapshot = await db.collection(COLLECTION).get();
  console.log(`[migrate-stage-collapse] Found ${snapshot.size} lead documents.`);

  let docsUpdated = 0;
  let docsAlreadyMigrated = 0;
  let docsCopiedAndDeleted = 0;  // case (a)
  let docsBothPresent = 0;       // case (b)
  let docsNeitherPresent = 0;    // case (d)
  let batchesCommitted = 0;
  const warnings = [];
  const errors = [];

  // Process in batches of 450 (Firestore batch limit is 500; keep headroom)
  const BATCH_SIZE = 450;
  let batch = db.batch();
  let batchOps = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const hasStage         = data.stage !== undefined;
    const hasPipelineStage = data.pipelineStage !== undefined;

    // (c) Already migrated.
    if (!hasStage && hasPipelineStage) {
      docsAlreadyMigrated++;
      continue;
    }

    // (d) Has neither — log a warning and skip.
    if (!hasStage && !hasPipelineStage) {
      docsNeitherPresent++;
      const cgId = data.cgId || '(no cgId)';
      warnings.push(`Doc ${doc.id} (cgId: ${cgId}) has neither 'stage' nor 'pipelineStage'.`);
      continue;
    }

    // (a) and (b): 'stage' present. Build the update.
    const updates = { stage: FieldValue.delete() };
    if (!hasPipelineStage) {
      updates.pipelineStage = data.stage;
      docsCopiedAndDeleted++;
    } else {
      docsBothPresent++;
    }

    batch.update(doc.ref, updates);
    batchOps++;
    docsUpdated++;

    if (batchOps >= BATCH_SIZE) {
      try {
        await batch.commit();
        batchesCommitted++;
        console.log(`[migrate-stage-collapse] Committed batch of ${batchOps} updates.`);
      } catch (err) {
        console.error(`[migrate-stage-collapse] Batch commit failed: ${err.message}`);
        errors.push({ batchSize: batchOps, error: err.message });
      }
      batch = db.batch();
      batchOps = 0;
    }
  }

  // Commit final partial batch
  if (batchOps > 0) {
    try {
      await batch.commit();
      batchesCommitted++;
      console.log(`[migrate-stage-collapse] Committed final batch of ${batchOps} updates.`);
    } catch (err) {
      console.error(`[migrate-stage-collapse] Final batch commit failed: ${err.message}`);
      errors.push({ batchSize: batchOps, error: err.message });
    }
  }

  console.log('');
  console.log('── Migration summary ─────────────────────────────────────────');
  console.log(`Total docs scanned:              ${snapshot.size}`);
  console.log(`Docs updated:                    ${docsUpdated}`);
  console.log(`  - copied stage → pipelineStage: ${docsCopiedAndDeleted}`);
  console.log(`  - both present (deleted stage): ${docsBothPresent}`);
  console.log(`Docs skipped (already migrated): ${docsAlreadyMigrated}`);
  console.log(`Docs with neither field:         ${docsNeitherPresent}`);
  console.log(`Batches committed:               ${batchesCommitted}`);
  console.log(`Batch errors:                    ${errors.length}`);
  if (warnings.length > 0) {
    console.log('Warnings:');
    warnings.forEach(w => console.log(`  - ${w}`));
  }
  if (errors.length > 0) {
    console.log('Errors:');
    errors.forEach(e => console.log(`  - ${JSON.stringify(e)}`));
  }
  console.log('──────────────────────────────────────────────────────────────');

  if (errors.length > 0) {
    console.error('[migrate-stage-collapse] Migration completed WITH ERRORS. Review above and re-run if needed.');
    process.exit(1);
  }
  console.log('[migrate-stage-collapse] Migration complete.');
}


migrate().catch(err => {
  console.error('[migrate-stage-collapse] FATAL:', err);
  process.exit(1);
});
