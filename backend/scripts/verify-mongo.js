#!/usr/bin/env node
/**
 * Verify MongoDB connectivity and that the collections the monitors need exist.
 *
 * Run:  npm run verify:mongo
 *
 * READ-ONLY. Nothing is created, altered or deleted. Safe to run against the
 * production cluster at any time.
 */
require('dotenv').config({ quiet: true });
const config = require('../src/config/env');
const mongo = require('../src/db/mongo');

/** Collections the monitor queries depend on, and what each supplies. */
const REQUIRED = [
  ['SmallCellNode', 'nodes -- nodeName, siteId, companyId, nodeStatus, nodeStartDate'],
  ['Site', 'route names (siteName). Join on siteIdList, NOT siteId'],
  ['Company', 'company names (companyName)'],
  ['FormGroup', 'the per-node checklist (list[])'],
  ['FormBuilderQuestions', 'form definitions -- list[].element = Photo / File_Upload'],
  ['FormBuilderAnswers', 'submission counts (daily reports)'],
  ['FieldMedia', 'uploaded photos, approvalStatus'],
  ['FieldResult', 'field-level answer values (the tracker lives here)'],
  ['S3Document', 'uploaded documents'],
];

function mask(uri) {
  return String(uri || '').replace(/\/\/[^@]*@/, '//***:***@');
}

(async () => {
  let failed = false;

  console.log('MongoDB verification');
  console.log('  uri      : ' + (config.mongo.uri ? mask(config.mongo.uri) : '(not set)'));
  console.log('  database : ' + (config.mongo.database || '(not set)'));
  console.log('  enabled  : ' + config.mongo.enabled + (config.mongo.enabled ? '' : '  (Snowflake still serving)'));
  console.log('');

  if (!config.mongo.uri || !config.mongo.database) {
    console.error('MONGO_URI and MONGO_DATABASE must be set in backend/.env.');
    console.error('See backend/.env.example for the expected format.');
    process.exit(1);
  }

  if (!/readPreference=secondary/i.test(config.mongo.uri)) {
    console.warn(
      'WARNING: readPreference=secondaryPreferred is missing from MONGO_URI.\n' +
        '         Dashboard queries may load the primary that the field portal uses.\n'
    );
  }

  try {
    const p = await mongo.ping();
    console.log(`connected: server ${p.serverVersion} in ${p.elapsedMs.toFixed(0)}ms`);
  } catch (err) {
    console.error('CONNECTION FAILED: ' + err.message.split('\n')[0]);
    console.error('');
    console.error('Common causes:');
    console.error('  - this machine\'s IP is not on the Atlas allowlist');
    console.error('  - the password contains characters needing percent-encoding');
    console.error('  - the user lacks read access to the database');
    process.exit(1);
  }

  const db = await mongo.getDb();
  const present = new Set((await db.listCollections().toArray()).map((c) => c.name));

  console.log('');
  console.log('collections:');
  for (const [name, purpose] of REQUIRED) {
    if (!present.has(name)) {
      failed = true;
      console.log(`  MISSING  ${name}  -- needed for ${purpose}`);
      continue;
    }
    const count = await db.collection(name).estimatedDocumentCount();
    console.log(`  ok       ${name.padEnd(22)} ${String(count.toLocaleString()).padStart(12)}  ${purpose}`);
  }

  // Index check: without these the dashboard is unusably slow on a 7M-doc collection.
  console.log('');
  console.log('indexes on nodeIdList (required for per-node queries):');
  for (const name of ['FormGroup', 'FormBuilderQuestions', 'FormBuilderAnswers', 'FieldMedia', 'FieldResult']) {
    if (!present.has(name)) continue;
    const keys = (await db.collection(name).indexes()).map((i) => Object.keys(i.key).join(','));
    const has = keys.some((k) => k.split(',')[0] === 'nodeIdList');
    if (!has) failed = true;
    console.log(`  ${has ? 'ok      ' : 'MISSING '} ${name}`);
  }

  await mongo.close();
  console.log('');
  console.log(failed ? 'FAILED -- see MISSING entries above.' : 'All checks passed.');
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('Unexpected error: ' + err.message);
  await mongo.close().catch(() => {});
  process.exit(1);
});
