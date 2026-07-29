#!/usr/bin/env node
/**
 * Discovers the real shape of the configured Snowflake schema and writes a
 * dashboard descriptor to backend/dashboard.config.json.
 *
 * Why this exists: the API and UI are driven by a descriptor (which columns are
 * measures, which are drillable dimensions, which is the time axis) rather than
 * hardcoded column names. That keeps one codebase working against whatever
 * ECSITE.ANALYTICS actually contains, and keeps every identifier that reaches
 * SQL sourced from INFORMATION_SCHEMA instead of from an HTTP request.
 *
 * Run:  cd backend && npm run introspect
 *       cd backend && npm run introspect -- --object ORDERS_SUMMARY
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config/env');
const sf = require('../src/db/snowflake');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const { database, schema } = config.snowflake;
const OUT_PATH = path.join(config.paths.backendRoot, 'dashboard.config.json');

/** Cardinality at or below this makes a text column a usable filter/drill dimension. */
const MAX_DIMENSION_CARDINALITY = 1000;

const NUMERIC_TYPES = new Set([
  'NUMBER', 'DECIMAL', 'NUMERIC', 'INT', 'INTEGER', 'BIGINT', 'SMALLINT',
  'TINYINT', 'BYTEINT', 'FLOAT', 'FLOAT4', 'FLOAT8', 'DOUBLE',
  'DOUBLE PRECISION', 'REAL',
]);
const TIME_TYPES = new Set([
  'DATE', 'DATETIME', 'TIMESTAMP', 'TIMESTAMP_LTZ', 'TIMESTAMP_NTZ', 'TIMESTAMP_TZ',
]);
const TEXT_TYPES = new Set(['TEXT', 'STRING', 'VARCHAR', 'CHAR', 'CHARACTER', 'BOOLEAN']);

/** Columns that are identifiers, not things worth aggregating. */
const ID_LIKE = /(^|_)(ID|KEY|GUID|UUID|SK|PK|HASH)$/i;

const snake = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const titleize = (s) =>
  s.toLowerCase().replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

function guessFormat(name, type) {
  const n = name.toUpperCase();
  if (/(AMOUNT|REVENUE|SALES|PRICE|COST|TOTAL|SPEND|PROFIT|MARGIN|VALUE)/.test(n)) return 'currency';
  if (/(RATE|PCT|PERCENT|RATIO|SHARE)/.test(n)) return 'percent';
  return NUMERIC_TYPES.has(type) ? 'number' : 'text';
}

async function main() {
  console.log(`Introspecting ${database}.${schema} ...\n`);

  // 1. What can this role actually see?
  const { rows: objects } = await sf.query(
    `SELECT TABLE_NAME, TABLE_TYPE, ROW_COUNT
       FROM IDENTIFIER(?).INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY COALESCE(ROW_COUNT, 0) DESC, TABLE_NAME`,
    [database, schema],
    { label: 'introspect-tables' }
  );

  if (objects.length === 0) {
    throw new Error(
      `No tables or views visible in ${database}.${schema} for role ${config.snowflake.role}.`
    );
  }

  console.log('Visible objects:');
  for (const o of objects) {
    console.log(`  ${String(o.TABLE_TYPE).padEnd(12)} ${String(o.TABLE_NAME).padEnd(40)} rows=${o.ROW_COUNT ?? '-'}`);
  }

  const requested = flag('object');
  const target = requested
    ? objects.find((o) => o.TABLE_NAME.toUpperCase() === requested.toUpperCase())
    : objects[0];

  if (!target) {
    throw new Error(
      `Object "${requested}" not found in ${database}.${schema}. ` +
        `Available: ${objects.map((o) => o.TABLE_NAME).join(', ')}`
    );
  }

  console.log(`\nUsing object: ${target.TABLE_NAME}\n`);

  // 2. Column types.
  const { rows: cols } = await sf.query(
    `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
       FROM IDENTIFIER(?).INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [database, schema, target.TABLE_NAME],
    { label: 'introspect-columns' }
  );

  console.log('Columns:');
  for (const c of cols) console.log(`  ${String(c.COLUMN_NAME).padEnd(36)} ${c.DATA_TYPE}`);

  const fqn = `"${database}"."${schema}"."${target.TABLE_NAME}"`;

  const timeCols = cols.filter((c) => TIME_TYPES.has(c.DATA_TYPE.toUpperCase()));
  const numericCols = cols.filter(
    (c) => NUMERIC_TYPES.has(c.DATA_TYPE.toUpperCase()) && !ID_LIKE.test(c.COLUMN_NAME)
  );
  const textCols = cols.filter((c) => TEXT_TYPES.has(c.DATA_TYPE.toUpperCase()));

  // 3. Cardinality probe -- one pass, so a wide table costs a single query.
  let cardinality = {};
  if (textCols.length > 0) {
    console.log('\nProbing distinct counts for candidate dimensions...');
    const selects = textCols
      .map((c) => `APPROX_COUNT_DISTINCT("${c.COLUMN_NAME}") AS "${c.COLUMN_NAME}"`)
      .join(',\n       ');
    const { rows } = await sf.query(
      `SELECT ${selects} FROM ${fqn}`,
      [],
      { label: 'introspect-cardinality' }
    );
    cardinality = rows[0] || {};
    for (const c of textCols) {
      console.log(`  ${String(c.COLUMN_NAME).padEnd(36)} ~${cardinality[c.COLUMN_NAME]} distinct`);
    }
  }

  // 4. Build the descriptor.
  const dimensions = textCols
    .filter((c) => {
      const n = Number(cardinality[c.COLUMN_NAME]);
      return Number.isFinite(n) && n > 1 && n <= MAX_DIMENSION_CARDINALITY;
    })
    .map((c) => ({
      key: snake(c.COLUMN_NAME),
      label: titleize(c.COLUMN_NAME),
      column: c.COLUMN_NAME,
      approxDistinct: Number(cardinality[c.COLUMN_NAME]),
    }))
    .sort((a, b) => a.approxDistinct - b.approxDistinct);

  const measures = numericCols.map((c) => ({
    key: snake(c.COLUMN_NAME),
    label: titleize(c.COLUMN_NAME),
    column: c.COLUMN_NAME,
    agg: 'SUM',
    format: guessFormat(c.COLUMN_NAME, c.DATA_TYPE.toUpperCase()),
  }));

  // Always available, and the only measure guaranteed to work on any table.
  measures.unshift({
    key: 'record_count',
    label: 'Records',
    column: '*',
    agg: 'COUNT',
    format: 'integer',
  });

  const descriptor = {
    $comment:
      'Generated by scripts/introspect-schema.js. Safe to hand-edit: reorder ' +
      'drillPath, relabel, drop noisy dimensions, or change measure aggregations.',
    generatedFrom: { database, schema, object: target.TABLE_NAME, type: target.TABLE_TYPE },
    source: { database, schema, object: target.TABLE_NAME },
    timeColumns: timeCols.map((c) => ({
      key: snake(c.COLUMN_NAME),
      label: titleize(c.COLUMN_NAME),
      column: c.COLUMN_NAME,
      type: c.DATA_TYPE,
    })),
    defaultTimeColumn: timeCols.length > 0 ? snake(timeCols[0].COLUMN_NAME) : null,
    measures,
    dimensions,
    // Coarsest -> finest. Cardinality order is a decent first guess for a
    // drill hierarchy; reorder by hand to match real business meaning.
    drillPath: dimensions.slice(0, 4).map((d) => d.key),
    detailColumns: cols.map((c) => c.COLUMN_NAME).slice(0, 25),
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(descriptor, null, 2) + '\n');

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Descriptor written: ${OUT_PATH}`);
  console.log(`${'='.repeat(72)}`);
  console.log(`  time columns : ${descriptor.timeColumns.map((t) => t.column).join(', ') || '(none)'}`);
  console.log(`  measures     : ${descriptor.measures.map((m) => m.key).join(', ')}`);
  console.log(`  dimensions   : ${descriptor.dimensions.map((d) => d.key).join(', ') || '(none)'}`);
  console.log(`  drill path   : ${descriptor.drillPath.join(' > ') || '(none)'}`);
  console.log(`\nReview/edit that file, then restart the API.\n`);
}

main()
  .then(() => sf.close())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`\nIntrospection failed: ${err.message}\n`);
    await sf.close().catch(() => {});
    process.exit(1);
  });
