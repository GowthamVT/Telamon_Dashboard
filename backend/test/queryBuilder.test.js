/**
 * Query builder tests. These need no Snowflake connection -- they assert the
 * generated SQL and, critically, that request input can never reach SQL as an
 * identifier.
 *
 * Run:  cd backend && npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const qb = require('../src/services/queryBuilder');

/** Descriptor shaped exactly like config/dashboard.js produces. */
function makeDescriptor() {
  const dimensions = [
    { key: 'region', label: 'Region', column: 'REGION', approxDistinct: 4 },
    { key: 'category', label: 'Category', column: 'CATEGORY', approxDistinct: 12 },
  ];
  const measures = [
    { key: 'record_count', label: 'Records', column: '*', agg: 'COUNT', format: 'integer' },
    { key: 'revenue', label: 'Revenue', column: 'AMOUNT', agg: 'SUM', format: 'currency' },
    { key: 'customers', label: 'Customers', column: 'CUSTOMER_ID', agg: 'COUNT_DISTINCT', format: 'integer' },
  ];
  const timeColumns = [{ key: 'order_date', label: 'Order Date', column: 'ORDER_DATE', type: 'DATE' }];

  return {
    source: { database: 'ECSITE', schema: 'ANALYTICS', object: 'ORDERS' },
    fqn: '"ECSITE"."ANALYTICS"."ORDERS"',
    dimensions,
    measures,
    timeColumns,
    defaultTimeColumn: 'order_date',
    drillPath: ['region', 'category'],
    detailColumns: ['ORDER_ID', 'REGION', 'AMOUNT'],
    generatedFrom: { type: 'BASE TABLE' },
    dimension: (k) => dimensions.find((d) => d.key === k),
    measure: (k) => measures.find((m) => m.key === k),
    timeColumn: (k) => timeColumns.find((t) => t.key === k),
  };
}

test('summary aggregates each measure with the right function', () => {
  const d = makeDescriptor();
  const { sql, binds } = qb.buildSummary(d, { measures: ['revenue', 'record_count', 'customers'] });

  assert.match(sql, /SUM\("AMOUNT"\) AS "revenue"/);
  assert.match(sql, /COUNT\(\*\) AS "record_count"/);
  assert.match(sql, /COUNT\(DISTINCT "CUSTOMER_ID"\) AS "customers"/);
  assert.match(sql, /FROM "ECSITE"\."ANALYTICS"\."ORDERS"/);
  assert.deepEqual(binds, []);
});

test('summary with no measures requested returns all of them', () => {
  const d = makeDescriptor();
  const { measures } = qb.buildSummary(d, {});
  assert.deepEqual(measures.map((m) => m.key), ['record_count', 'revenue', 'customers']);
});

test('filter values become bind parameters, never inlined', () => {
  const d = makeDescriptor();
  const { sql, binds } = qb.buildSummary(d, { filters: { region: ["West'; DROP TABLE X --"] } });

  assert.match(sql, /WHERE "REGION" = \?/);
  // The payload appears only in binds, never in the SQL text.
  assert.ok(!sql.includes('DROP TABLE'));
  assert.deepEqual(binds, ["West'; DROP TABLE X --"]);
});

test('multi-value filters use IN with one placeholder per value', () => {
  const d = makeDescriptor();
  const { sql, binds } = qb.buildSummary(d, { filters: { region: ['West', 'East', 'North'] } });
  assert.match(sql, /"REGION" IN \(\?, \?, \?\)/);
  assert.deepEqual(binds, ['West', 'East', 'North']);
});

test('empty and null filter values are ignored, not turned into bad SQL', () => {
  const d = makeDescriptor();
  const { sql, binds } = qb.buildSummary(d, {
    filters: { region: [], category: null, },
  });
  assert.ok(!sql.includes('WHERE'));
  assert.deepEqual(binds, []);
});

test('unknown dimension is rejected and reports the allowed keys', () => {
  const d = makeDescriptor();
  assert.throws(
    () => qb.buildBreakdown(d, { dimension: 'REGION"; DROP TABLE X --' }),
    (err) => {
      assert.equal(err.name, 'RequestError');
      assert.equal(err.status, 400);
      assert.deepEqual(err.details.allowed, ['region', 'category']);
      return true;
    }
  );
});

test('unknown measure is rejected', () => {
  const d = makeDescriptor();
  assert.throws(
    () => qb.buildSummary(d, { measures: ['revenue', 'nope'] }),
    /Unknown measure "nope"/
  );
});

test('breakdown groups, sorts by a measure, and pages', () => {
  const d = makeDescriptor();
  const built = qb.buildBreakdown(d, {
    dimension: 'region',
    measures: ['revenue'],
    sortBy: 'revenue',
    sortDir: 'asc',
    limit: 25,
    offset: 50,
  });

  assert.match(built.sql, /SELECT "REGION" AS "region"/);
  assert.match(built.sql, /GROUP BY "REGION"/);
  assert.match(built.sql, /ORDER BY "revenue" ASC NULLS LAST/);
  assert.match(built.sql, /LIMIT \? OFFSET \?/);
  assert.deepEqual(built.binds, [25, 50]);
  assert.deepEqual(built.sort, { by: 'revenue', dir: 'asc' });
});

test('breakdown can sort by the grouped dimension itself', () => {
  const d = makeDescriptor();
  const built = qb.buildBreakdown(d, { dimension: 'region', sortBy: 'region', sortDir: 'desc' });
  assert.match(built.sql, /ORDER BY "region" DESC/);
});

test('breakdown rejects sorting by a measure that was not selected', () => {
  const d = makeDescriptor();
  assert.throws(
    () => qb.buildBreakdown(d, { dimension: 'region', measures: ['revenue'], sortBy: 'customers' }),
    /Cannot sort by "customers"/
  );
});

test('breakdown rejects an invalid sort direction', () => {
  const d = makeDescriptor();
  assert.throws(
    () => qb.buildBreakdown(d, { dimension: 'region', sortDir: 'asc; DROP TABLE X' }),
    /Invalid sortDir/
  );
});

test('limit is clamped to the documented maximum', () => {
  const d = makeDescriptor();
  const built = qb.buildBreakdown(d, { dimension: 'region', limit: 999999 });
  assert.equal(built.page.limit, 1000);
});

test('negative or garbage limit falls back to the default', () => {
  const d = makeDescriptor();
  assert.equal(qb.buildBreakdown(d, { dimension: 'region', limit: -5 }).page.limit, 50);
  assert.equal(qb.buildBreakdown(d, { dimension: 'region', limit: 'abc' }).page.limit, 50);
  assert.equal(qb.buildBreakdown(d, { dimension: 'region', offset: -10 }).page.offset, 0);
});

test('date range binds both bounds against the resolved time column', () => {
  const d = makeDescriptor();
  const { sql, binds } = qb.buildSummary(d, {
    dateRange: { from: '2024-01-01', to: '2024-12-31' },
  });
  assert.match(sql, /"ORDER_DATE" >= \?/);
  assert.match(sql, /"ORDER_DATE" <= \?/);
  assert.deepEqual(binds, ['2024-01-01', '2024-12-31']);
});

test('timeseries only accepts known grains', () => {
  const d = makeDescriptor();
  const built = qb.buildTimeseries(d, { grain: 'month', measures: ['revenue'] });
  assert.match(built.sql, /DATE_TRUNC\('MONTH', "ORDER_DATE"\) AS "bucket"/);

  assert.throws(
    () => qb.buildTimeseries(d, { grain: "MONTH'); DROP TABLE X --" }),
    /Invalid grain/
  );
});

test('timeseries explains itself when the dataset has no time column', () => {
  const d = makeDescriptor();
  d.timeColumns = [];
  d.defaultTimeColumn = null;
  d.timeColumn = () => undefined;
  assert.throws(() => qb.buildTimeseries(d, {}), /no date\/timestamp column/);
});

test('filter options exclude the dimension being listed from its own filters', () => {
  const d = makeDescriptor();
  const { sql, binds } = qb.buildFilterOptions(d, {
    dimension: 'region',
    filters: { region: ['West'], category: ['Toys'] },
  });

  // CATEGORY constrains the list; REGION must not constrain its own options.
  assert.match(sql, /"CATEGORY" = \?/);
  assert.ok(!sql.includes('"REGION" = ?'));
  assert.equal(binds[0], 'Toys');
});

test('detail selects declared columns only, never SELECT *', () => {
  const d = makeDescriptor();
  const built = qb.buildDetail(d, { filters: { region: ['West'] }, limit: 10 });

  assert.ok(!built.sql.includes('SELECT *'));
  assert.match(built.sql, /SELECT "ORDER_ID"/);
  assert.match(built.sql, /"REGION" = \?/);
  assert.deepEqual(built.binds, ['West', 10, 0]);
});

test('detail rejects sorting by an undeclared column', () => {
  const d = makeDescriptor();
  assert.throws(() => qb.buildDetail(d, { sortBy: 'SECRET_COLUMN' }), /Cannot sort detail by/);
  // A declared column is accepted.
  assert.match(qb.buildDetail(d, { sortBy: 'AMOUNT', sortDir: 'desc' }).sql, /ORDER BY "AMOUNT" DESC/);
});

test('drill-down levels share one WHERE contract', () => {
  const d = makeDescriptor();
  // Level 1: group by region, unfiltered.
  const level1 = qb.buildBreakdown(d, { dimension: 'region', measures: ['revenue'] });
  // Level 2: user clicked "West" -> that crumb becomes an ordinary filter.
  const level2 = qb.buildBreakdown(d, {
    dimension: 'category',
    measures: ['revenue'],
    filters: { region: ['West'] },
  });
  // Drill-through: same filters, raw rows.
  const detail = qb.buildDetail(d, { filters: { region: ['West'], category: ['Toys'] } });

  assert.ok(!level1.sql.includes('WHERE'));
  assert.match(level2.sql, /WHERE "REGION" = \?/);
  assert.match(level2.sql, /GROUP BY "CATEGORY"/);
  assert.deepEqual(level2.binds.slice(0, 1), ['West']);
  assert.match(detail.sql, /"REGION" = \?/);
  assert.match(detail.sql, /"CATEGORY" = \?/);
});

test('count query mirrors the detail filters for accurate totals', () => {
  const d = makeDescriptor();
  const request = { filters: { region: ['West'], category: ['Toys'] } };
  const detail = qb.buildDetail(d, request);
  const count = qb.buildCount(d, request);

  assert.match(count.sql, /SELECT COUNT\(\*\) AS "total"/);
  // Same predicates, so "showing N of M" is consistent.
  assert.deepEqual(count.binds, ['West', 'Toys']);
  assert.deepEqual(detail.binds.slice(0, 2), ['West', 'Toys']);
});
