#!/usr/bin/env node
/**
 * Ad-hoc SQL runner against the configured Snowflake session (same pooled client,
 * role, warehouse, database and schema the API uses).
 *
 * Reads SQL from a file or from stdin, so quoting is never mangled by the shell --
 * important because analytics columns here are quoted identifiers containing
 * spaces (e.g. "Company Name").
 *
 * Usage:
 *   node scripts/query.js path/to/query.sql
 *   echo 'SELECT 1' | node scripts/query.js
 *   node scripts/query.js query.sql --json      # full rows as JSON
 *   node scripts/query.js query.sql --limit 20  # cap printed rows (default 20)
 */
const fs = require('node:fs');
const sf = require('../src/db/snowflake');
const config = require('../src/config/env');
const { assertReadOnly } = require('../src/db/readOnly');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const file = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const printLimit = Number.parseInt(flag('limit') || '20', 10);

function readSql() {
  if (file) return fs.readFileSync(file, 'utf8');
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8');
  throw new Error('No SQL provided. Pass a .sql file path or pipe SQL via stdin.');
}

/** Render rows as an aligned table so wide result sets stay readable. */
function printTable(rows, limit) {
  if (rows.length === 0) {
    console.log('  (no rows)');
    return;
  }
  const columns = Object.keys(rows[0]);
  const shown = rows.slice(0, limit);
  const cell = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
    if (typeof v === 'object') return JSON.stringify(v);
    const s = String(v);
    return s.length > 40 ? `${s.slice(0, 37)}...` : s;
  };
  const widths = columns.map((c) =>
    Math.min(40, Math.max(c.length, ...shown.map((r) => cell(r[c]).length)))
  );
  const line = (chars) => columns.map((_, i) => chars.repeat(widths[i])).join('-+-');

  console.log('  ' + columns.map((c, i) => c.padEnd(widths[i])).join(' | '));
  console.log('  ' + line('-'));
  for (const row of shown) {
    console.log('  ' + columns.map((c, i) => cell(row[c]).padEnd(widths[i])).join(' | '));
  }
  if (rows.length > limit) console.log(`  ... ${rows.length - limit} more row(s) not shown`);
}

async function main() {
  // Read-only guardrail: refuses anything that is not a single read statement,
  // so a write cannot reach the live warehouse from this tool -- see
  // src/db/readOnly.js for why it is a whitelist rather than a blacklist.
  const sqlText = assertReadOnly(readSql());

  console.log(
    `Session: ${config.snowflake.account} | role ${config.snowflake.role} | ` +
      `warehouse ${config.snowflake.warehouse} | ${config.snowflake.database}.${config.snowflake.schema}`
  );
  console.log(`Auth   : ${sf.authMode() === 'password' ? 'password' : 'key-pair'}`);
  console.log('-'.repeat(72));
  console.log(sqlText);
  console.log('-'.repeat(72));

  const { rows, elapsedMs } = await sf.query(sqlText, [], { label: 'adhoc' });

  console.log(`\nRows returned: ${rows.length}  (${elapsedMs.toFixed(0)}ms)\n`);
  if (has('json')) console.log(JSON.stringify(rows, null, 2));
  else printTable(rows, printLimit);
  console.log('');
}

main()
  .then(() => sf.close())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`\nQuery failed: ${err.message}\n`);
    await sf.close().catch(() => {});
    process.exit(1);
  });
