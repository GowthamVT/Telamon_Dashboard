#!/usr/bin/env node
/**
 * Runs the REAL Express app with the Snowflake driver replaced by a synthetic
 * data generator.
 *
 * Why it exists: it decouples frontend work from Snowflake availability. You can
 * build and review the UI before key-pair auth is registered, and demo the
 * dashboard with no warehouse cost. Every route, the cache, and the drill logic
 * are the production code paths -- only the driver is swapped.
 *
 * Run:  cd backend && npm run dev:mock
 *
 * NOT for production. It refuses to start with NODE_ENV=production.
 */
process.env.DASHBOARD_CONFIG_PATH =
  process.env.DASHBOARD_CONFIG_PATH || 'test/fixtures/dashboard.fixture.json';

if (process.env.NODE_ENV === 'production') {
  console.error('mock-server.js must never run in production.');
  process.exit(1);
}

const sf = require('../src/db/snowflake');
const config = require('../src/config/env');

// ---------------------------------------------------------------------------
// Deterministic synthetic dataset (seeded, so charts look the same each run).
// ---------------------------------------------------------------------------
const REGIONS = ['West', 'East', 'North', 'South'];
const CATEGORIES = ['Toys', 'Games', 'Books', 'Apparel', 'Home', 'Electronics'];

let seed = 42;
/** Mulberry32 -- small deterministic PRNG. */
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const ROWS = [];
for (let i = 0; i < 4000; i += 1) {
  const region = REGIONS[Math.floor(random() * REGIONS.length)];
  const category = CATEGORIES[Math.floor(random() * CATEGORIES.length)];
  const month = Math.floor(random() * 12);
  const day = 1 + Math.floor(random() * 28);
  ROWS.push({
    ORDER_ID: 100000 + i,
    REGION: region,
    CATEGORY: category,
    AMOUNT: Math.round((5 + random() * 495) * 100) / 100,
    ORDER_DATE: new Date(Date.UTC(2024, month, day)),
  });
}

/**
 * Apply the WHERE clause by reading the generated SQL's predicates and pairing
 * them with the binds, so filtering mirrors what Snowflake would do.
 */
function applyFilters(sqlText, binds) {
  const predicates = [];
  const bindQueue = [...binds];

  // Order matters: buildWhere emits predicates in this sequence.
  const clauseRe = /"(\w+)"\s*(=|IN|>=|<=)\s*(\((?:\s*\?\s*,?)+\)|\?)/g;
  let match;
  while ((match = clauseRe.exec(sqlText)) !== null) {
    const [, column, operator, placeholder] = match;
    const count = placeholder.startsWith('(') ? (placeholder.match(/\?/g) || []).length : 1;
    const values = bindQueue.splice(0, count);
    predicates.push({ column, operator, values });
  }

  return ROWS.filter((row) =>
    predicates.every(({ column, operator, values }) => {
      const cell = row[column];
      switch (operator) {
        case '=':
          return String(cell) === String(values[0]);
        case 'IN':
          return values.some((v) => String(v) === String(cell));
        case '>=':
          return new Date(cell) >= new Date(values[0]);
        case '<=':
          return new Date(cell) <= new Date(values[0]);
        default:
          return true;
      }
    })
  );
}

const sum = (rows, column) => rows.reduce((acc, r) => acc + (Number(r[column]) || 0), 0);

function truncate(date, grain) {
  const d = new Date(date);
  switch (grain) {
    case 'YEAR':
      return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    case 'QUARTER':
      return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
    case 'WEEK': {
      const copy = new Date(d);
      copy.setUTCDate(copy.getUTCDate() - copy.getUTCDay());
      return new Date(Date.UTC(copy.getUTCFullYear(), copy.getUTCMonth(), copy.getUTCDate()));
    }
    case 'DAY':
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    default:
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }
}

/** Compute the measures the SELECT list asked for. */
function measuresFor(sqlText, rows) {
  const out = {};
  const aliasRe = /(COUNT\(\*\)|SUM\("(\w+)"\)|COUNT\(DISTINCT "(\w+)"\)|AVG\("(\w+)"\)|MIN\("(\w+)"\)|MAX\("(\w+)"\))\s+AS\s+"(\w+)"/g;
  let match;
  while ((match = aliasRe.exec(sqlText)) !== null) {
    const [expression, , sumCol, distinctCol, avgCol, minCol, maxCol] = match;
    const alias = match[match.length - 1];
    if (expression.startsWith('COUNT(*)')) out[alias] = rows.length;
    else if (sumCol) out[alias] = Math.round(sum(rows, sumCol) * 100) / 100;
    else if (distinctCol) out[alias] = new Set(rows.map((r) => r[distinctCol])).size;
    else if (avgCol) out[alias] = rows.length ? Math.round((sum(rows, avgCol) / rows.length) * 100) / 100 : 0;
    else if (minCol) out[alias] = rows.reduce((a, r) => Math.min(a, r[minCol]), Infinity);
    else if (maxCol) out[alias] = rows.reduce((a, r) => Math.max(a, r[maxCol]), -Infinity);
  }
  return out;
}

function sortRows(rows, sqlText) {
  const match = /ORDER BY "(\w+)" (ASC|DESC)/.exec(sqlText);
  if (!match) return rows;
  const [, key, direction] = match;
  const sign = direction === 'ASC' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x === y) return 0;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}

// ---------------------------------------------------------------------------
// Driver replacement.
// ---------------------------------------------------------------------------
sf.query = async (sqlText, binds = [], opts = {}) => {
  const started = Date.now();
  // A little latency so loading/refetching states are visible while developing.
  await new Promise((resolve) => setTimeout(resolve, 40));

  const trailing = [...binds];
  // LIMIT/OFFSET binds are appended last and are not filter values.
  const limitMatch = /LIMIT \?(?: OFFSET \?)?/.exec(sqlText);
  let limit = null;
  let offset = 0;
  if (limitMatch) {
    if (/OFFSET \?/.test(sqlText)) offset = trailing.pop();
    limit = trailing.pop();
  }

  const filtered = applyFilters(sqlText, trailing);
  const finish = (rows) => ({
    rows,
    rowCount: rows.length,
    columns: Object.keys(rows[0] || {}).map((name) => ({ name, type: 'TEXT' })),
    elapsedMs: Date.now() - started,
  });

  // Freshness probe.
  if (/INFORMATION_SCHEMA\.TABLES/.test(sqlText)) {
    return finish([{ LAST_ALTERED: '2024-12-01 00:00:00', ROW_COUNT: ROWS.length, BYTES: 123456 }]);
  }
  // Session context.
  if (/CURRENT_ACCOUNT\(\)/.test(sqlText)) {
    return finish([
      {
        account: 'MOCK',
        user: config.snowflake.username,
        role: config.snowflake.role,
        warehouse: config.snowflake.warehouse,
        database: config.snowflake.database,
        schema: config.snowflake.schema,
        version: 'mock',
      },
    ]);
  }
  // Detail count.
  if (/COUNT\(\*\) AS "total"/.test(sqlText)) return finish([{ total: filtered.length }]);

  // Timeseries.
  const grainMatch = /DATE_TRUNC\('(\w+)', "(\w+)"\)/.exec(sqlText);
  if (grainMatch) {
    const [, grain, column] = grainMatch;
    const buckets = new Map();
    for (const row of filtered) {
      const key = truncate(row[column], grain).toISOString();
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    const rows = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, group]) => ({ bucket, ...measuresFor(sqlText, group) }));
    return finish(limit ? rows.slice(0, limit) : rows);
  }

  // Filter options.
  const optionMatch = /SELECT "(\w+)" AS "value"/.exec(sqlText);
  if (optionMatch) {
    const column = optionMatch[1];
    const counts = new Map();
    for (const row of filtered) counts.set(row[column], (counts.get(row[column]) || 0) + 1);
    const rows = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count);
    return finish(limit ? rows.slice(0, limit) : rows);
  }

  // Grouped breakdown.
  const groupMatch = /SELECT "(\w+)" AS "(\w+)"/.exec(sqlText);
  if (groupMatch && /GROUP BY/.test(sqlText)) {
    const [, column, alias] = groupMatch;
    const groups = new Map();
    for (const row of filtered) {
      if (!groups.has(row[column])) groups.set(row[column], []);
      groups.get(row[column]).push(row);
    }
    let rows = [...groups.entries()].map(([value, group]) => ({
      [alias]: value,
      ...measuresFor(sqlText, group),
    }));
    rows = sortRows(rows, sqlText);
    return finish(rows.slice(offset, limit ? offset + limit : undefined));
  }

  // Detail rows.
  if (/^SELECT "ORDER_ID"/m.test(sqlText)) {
    const rows = sortRows(filtered, sqlText)
      .slice(offset, limit ? offset + limit : undefined)
      .map((row) => ({ ...row, ORDER_DATE: row.ORDER_DATE.toISOString().slice(0, 10) }));
    return finish(rows);
  }

  // Summary.
  return finish([measuresFor(sqlText, filtered)]);
};

sf.ping = async () => ({ account: 'MOCK', user: config.snowflake.username, role: config.snowflake.role });
sf.poolStats = () => ({ initialized: false, mock: true });

const { createApp } = require('../src/app');
const freshness = require('../src/sync/freshnessWatcher');

const port = Number(process.env.PORT) || config.port;
createApp().listen(port, () => {
  console.log(`\n  MOCK API on http://localhost:${port}  (synthetic data -- no Snowflake)`);
  console.log(`  ${ROWS.length} synthetic rows across ${REGIONS.length} regions / ${CATEGORIES.length} categories`);
  console.log(`  Start the UI with:  cd frontend && npm run dev\n`);
  freshness.start();
});
