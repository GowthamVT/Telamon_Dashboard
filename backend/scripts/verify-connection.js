#!/usr/bin/env node
/**
 * Proves the backend can authenticate to Snowflake with key-pair auth and run a
 * real query against the configured database/schema.
 *
 * Run:  cd backend && npm run verify
 *
 * Exits non-zero with a diagnosis on failure, so this doubles as a smoke test.
 */
const config = require('../src/config/env');
const sf = require('../src/db/snowflake');

/** Map common Snowflake auth/setup failures to an actionable next step. */
function diagnose(err) {
  const msg = String(err && err.message ? err.message : err);

  if (/private key/i.test(msg) && /not found/i.test(msg)) {
    return 'Generate the key pair first:  cd backend && npm run keygen';
  }
  if (/JWT token is invalid|invalid JWT/i.test(msg)) {
    return (
      'Snowflake rejected the JWT. The public key is probably not registered on the user yet.\n' +
      `  Run the SQL in keys/register-public-key.sql as a role that can ALTER USER ${config.snowflake.username}.\n` +
      '  Key registration can take a few seconds to propagate; retry after that.'
    );
  }
  if (/Incorrect username or password|user.*does not exist/i.test(msg)) {
    return `Check SNOWFLAKE_USER (currently "${config.snowflake.username}") and SNOWFLAKE_ACCOUNT ("${config.snowflake.account}").`;
  }
  if (/Role .* does not exist|not authorized/i.test(msg)) {
    return `The role "${config.snowflake.role}" may lack USAGE on ${config.snowflake.database}.${config.snowflake.schema} or on the warehouse.`;
  }
  if (/Object does not exist|Database .* does not exist|Schema .* does not exist/i.test(msg)) {
    return `Confirm ${config.snowflake.database}.${config.snowflake.schema} exists and that role ${config.snowflake.role} has USAGE on it.`;
  }
  if (/Warehouse .* does not exist|No active warehouse/i.test(msg)) {
    return `Confirm warehouse "${config.snowflake.warehouse}" exists and role ${config.snowflake.role} has USAGE on it.`;
  }
  if (/getaddrinfo|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|socket hang up/i.test(msg)) {
    return `Network problem reaching ${config.snowflake.account}.snowflakecomputing.com -- check connectivity/VPN/proxy.`;
  }
  return 'See the raw error above.';
}

async function main() {
  console.log('Snowflake connection check');
  console.log('='.repeat(72));
  console.log(`  account   : ${config.snowflake.account}`);
  console.log(`  user      : ${config.snowflake.username}`);
  console.log(`  role      : ${config.snowflake.role}`);
  console.log(`  warehouse : ${config.snowflake.warehouse}`);
  console.log(`  database  : ${config.snowflake.database}`);
  console.log(`  schema    : ${config.snowflake.schema}`);
  const mode = sf.authMode();
  console.log(
    `  auth      : ${mode === 'password' ? 'PASSWORD (fallback -- key-pair preferred)' : 'key-pair (SNOWFLAKE_JWT)'}`
  );
  if (mode === 'keypair') console.log(`  key file  : ${config.snowflake.resolvedKeyPath}`);
  console.log('='.repeat(72));

  // 1. Authenticate and confirm session context.
  console.log('\n[1/3] Authenticating and reading session context...');
  const session = await sf.ping();
  console.log('  OK -- connected as:');
  for (const [k, v] of Object.entries(session)) {
    console.log(`       ${k.padEnd(10)} = ${v}`);
  }

  // 2. List tables/views visible in the target schema.
  console.log(`\n[2/3] Listing objects in ${config.snowflake.database}.${config.snowflake.schema}...`);
  const { rows: objects } = await sf.query(
    `SELECT TABLE_NAME, TABLE_TYPE, ROW_COUNT
       FROM IDENTIFIER(?).INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_TYPE, TABLE_NAME`,
    [config.snowflake.database, config.snowflake.schema],
    { label: 'list-objects' }
  );

  if (objects.length === 0) {
    console.log(
      `  Connected successfully, but role ${config.snowflake.role} sees no tables or views in ` +
        `${config.snowflake.database}.${config.snowflake.schema}.\n` +
        `  Either the schema is empty or the role lacks SELECT privileges.`
    );
    console.log('\nRESULT: authentication works; no sample table available to query.');
    return;
  }

  console.log(`  OK -- ${objects.length} object(s) visible:`);
  for (const o of objects.slice(0, 40)) {
    const count = o.ROW_COUNT === null || o.ROW_COUNT === undefined ? '-' : o.ROW_COUNT;
    console.log(`       ${String(o.TABLE_TYPE).padEnd(12)} ${String(o.TABLE_NAME).padEnd(40)} rows=${count}`);
  }
  if (objects.length > 40) console.log(`       ... and ${objects.length - 40} more`);

  // 3. Actually SELECT from the first visible object -- the real proof.
  const sample = objects[0];
  const fqn = `"${config.snowflake.database}"."${config.snowflake.schema}"."${sample.TABLE_NAME}"`;
  console.log(`\n[3/3] Sample query against ${sample.TABLE_NAME}...`);

  const { rows, columns, elapsedMs } = await sf.query(
    `SELECT * FROM ${fqn} LIMIT 5`,
    [],
    { label: 'sample-select' }
  );
  console.log(`  OK -- ${rows.length} row(s) in ${elapsedMs.toFixed(0)}ms`);
  console.log(`  columns: ${columns.map((c) => `${c.name}:${c.type}`).join(', ') || '(none)'}`);
  if (rows.length > 0) {
    console.log('  first row:');
    console.log(
      JSON.stringify(rows[0], null, 2)
        .split('\n')
        .map((l) => `       ${l}`)
        .join('\n')
    );
  }

  console.log('\n' + '='.repeat(72));
  console.log('RESULT: SUCCESS -- key-pair auth works and live data is queryable.');
  console.log('='.repeat(72));
}

main()
  .then(() => sf.close())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('\n' + '='.repeat(72));
    console.error('RESULT: FAILED');
    console.error('='.repeat(72));
    console.error(`\n${err && err.message ? err.message : err}\n`);
    console.error('Likely fix:');
    console.error(`  ${diagnose(err)}\n`);
    await sf.close().catch(() => {});
    process.exit(1);
  });
