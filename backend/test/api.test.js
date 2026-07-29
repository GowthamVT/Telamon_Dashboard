/**
 * End-to-end API tests against the real Express app with the Snowflake driver
 * stubbed out.
 *
 * These cover what unit tests on the query builder cannot: routing, request
 * parsing, cache hit/miss behaviour and its invalidation, response shape, and
 * the full drill-down -> drill-through request sequence the UI issues.
 *
 * Run:  cd backend && npm test
 */
process.env.DASHBOARD_CONFIG_PATH = 'test/fixtures/dashboard.fixture.json';
process.env.SYNC_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.APP_LOG_LEVEL = 'error';
process.env.CACHE_TTL_SECONDS = '300';
// A tiny rate limit would make these tests flaky.
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';

const test = require('node:test');
const assert = require('node:assert/strict');

const sf = require('../src/db/snowflake');
const cache = require('../src/cache/queryCache');

// ---------------------------------------------------------------------------
// Stub the driver. Each stub returns rows shaped like the real thing, and we
// record the SQL so tests can assert what would have been sent to Snowflake.
// ---------------------------------------------------------------------------
const executed = [];

sf.query = async (sqlText, binds = [], opts = {}) => {
  executed.push({ sql: sqlText, binds, label: opts.label });

  if (/COUNT\(\*\) AS "total"/.test(sqlText)) {
    return { rows: [{ total: 1234 }], rowCount: 1, columns: [], elapsedMs: 1 };
  }
  if (/DATE_TRUNC/.test(sqlText)) {
    return {
      rows: [
        { bucket: '2024-01-01T00:00:00.000Z', record_count: 10, amount: 100.5 },
        { bucket: '2024-02-01T00:00:00.000Z', record_count: 20, amount: 250.25 },
      ],
      rowCount: 2,
      columns: [],
      elapsedMs: 2,
    };
  }
  if (/GROUP BY "REGION"|GROUP BY "CATEGORY"/.test(sqlText)) {
    // Filter-options queries select value/count; breakdowns select the dim key.
    if (/AS "value"/.test(sqlText)) {
      return {
        rows: [
          { value: 'West', count: 500 },
          { value: 'East', count: 400 },
        ],
        rowCount: 2,
        columns: [],
        elapsedMs: 2,
      };
    }
    const key = /GROUP BY "REGION"/.test(sqlText) ? 'region' : 'category';
    return {
      rows: [
        { [key]: 'West', record_count: 60, amount: 600.75 },
        { [key]: 'East', record_count: 40, amount: 400.25 },
      ],
      rowCount: 2,
      columns: [],
      elapsedMs: 3,
    };
  }
  if (/^SELECT "ORDER_ID"/m.test(sqlText)) {
    return {
      rows: [
        { ORDER_ID: 1, REGION: 'West', CATEGORY: 'Toys', AMOUNT: 9.99, ORDER_DATE: '2024-01-05' },
      ],
      rowCount: 1,
      columns: [],
      elapsedMs: 4,
    };
  }
  // Summary.
  return { rows: [{ record_count: 100, amount: 1001.0 }], rowCount: 1, columns: [], elapsedMs: 5 };
};

const { createApp } = require('../src/app');

let server;
let baseUrl;

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
});

/** Fresh cache + SQL log before each test so assertions are independent. */
test.beforeEach(() => {
  cache.clear();
  cache.invalidateAll('test-reset');
  executed.length = 0;
});

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json();
  return { status: response.status, body, headers: response.headers };
}

// ---------------------------------------------------------------------------

test('GET /api/health does not touch Snowflake', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.configured, true);
  assert.equal(executed.length, 0);
});

test('GET /api/meta exposes the descriptor the UI renders controls from', async () => {
  const { status, body } = await get('/api/meta');
  assert.equal(status, 200);
  assert.deepEqual(body.drillPath, ['region', 'category']);
  assert.deepEqual(
    body.measures.map((m) => m.key),
    ['record_count', 'amount']
  );
  assert.equal(body.defaultTimeColumn, 'order_date');
  // Physical column names are an internal detail; keys are the public contract.
  assert.ok(!JSON.stringify(body.measures).includes('AMOUNT'));
});

test('GET /api/summary returns measure values and reports a cache MISS then HIT', async () => {
  const first = await get('/api/summary?measures=amount,record_count');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-cache'), 'MISS');
  assert.equal(first.body.values.amount, 1001);
  assert.equal(first.body.cache.hit, false);
  assert.equal(executed.length, 1);

  const second = await get('/api/summary?measures=amount,record_count');
  assert.equal(second.headers.get('x-cache'), 'HIT');
  assert.equal(second.body.cache.hit, true);
  // The point of the cache: no second warehouse query.
  assert.equal(executed.length, 1);
});

test('a different filter is a different cache key, so it re-queries', async () => {
  await get('/api/summary?measures=amount');
  await get('/api/summary?measures=amount&f.region=West');
  assert.equal(executed.length, 2);
  assert.deepEqual(executed[1].binds, ['West']);
});

test('cache key is insensitive to parameter order', async () => {
  await get('/api/summary?measures=amount&f.region=West');
  await get('/api/summary?f.region=West&measures=amount');
  assert.equal(executed.length, 1);
});

test('POST /api/cache/invalidate forces the next read to re-query', async () => {
  await get('/api/summary?measures=amount');
  assert.equal(executed.length, 1);

  const invalidate = await fetch(`${baseUrl}/api/cache/invalidate`, { method: 'POST' });
  assert.equal(invalidate.status, 200);

  await get('/api/summary?measures=amount');
  assert.equal(executed.length, 2);
});

test('GET /api/breakdown groups, and comma filters become an IN clause', async () => {
  const { status, body } = await get('/api/breakdown?dimension=region&measures=amount&f.category=Toys,Games');
  assert.equal(status, 200);
  assert.equal(body.dimension.key, 'region');
  assert.equal(body.rows.length, 2);
  assert.match(executed[0].sql, /GROUP BY "REGION"/);
  assert.match(executed[0].sql, /"CATEGORY" IN \(\?, \?\)/);
  assert.deepEqual(executed[0].binds.slice(0, 2), ['Toys', 'Games']);
});

test('GET /api/breakdown without a dimension is a 400, not a 500', async () => {
  const { status, body } = await get('/api/breakdown');
  assert.equal(status, 400);
  assert.match(body.message, /dimension/);
  assert.equal(executed.length, 0);
});

test('an unknown dimension is rejected with the allowed list', async () => {
  const { status, body } = await get('/api/breakdown?dimension=DROP_TABLE');
  assert.equal(status, 400);
  assert.equal(body.error, 'bad_request');
  assert.deepEqual(body.details.allowed, ['region', 'category']);
  // Nothing was sent to Snowflake.
  assert.equal(executed.length, 0);
});

test('sort parameters reach ORDER BY and are echoed back', async () => {
  const { body } = await get('/api/breakdown?dimension=region&measures=amount&sortBy=amount&sortDir=asc');
  assert.deepEqual(body.sort, { by: 'amount', dir: 'asc' });
  assert.match(executed[0].sql, /ORDER BY "amount" ASC NULLS LAST/);
});

test('an invalid sort direction cannot reach SQL', async () => {
  const { status } = await get('/api/breakdown?dimension=region&sortDir=asc;DROP');
  assert.equal(status, 400);
  assert.equal(executed.length, 0);
});

test('GET /api/timeseries buckets by grain and binds the date range', async () => {
  const { status, body } = await get(
    '/api/timeseries?measures=amount&grain=month&from=2024-01-01&to=2024-06-30'
  );
  assert.equal(status, 200);
  assert.equal(body.grain, 'month');
  assert.equal(body.rows.length, 2);
  assert.match(executed[0].sql, /DATE_TRUNC\('MONTH', "ORDER_DATE"\)/);
  assert.deepEqual(executed[0].binds.slice(0, 2), ['2024-01-01', '2024-06-30']);
});

test('an invalid grain is rejected', async () => {
  const { status } = await get('/api/timeseries?grain=SECOND');
  assert.equal(status, 400);
  assert.equal(executed.length, 0);
});

test('GET /api/filter-options omits the listed dimension from its own filters', async () => {
  const { status, body } = await get('/api/filter-options?dimension=region&f.region=West&f.category=Toys');
  assert.equal(status, 200);
  assert.equal(body.options.length, 2);
  assert.match(executed[0].sql, /"CATEGORY" = \?/);
  assert.ok(!executed[0].sql.includes('"REGION" = ?'));
});

test('GET /api/detail returns declared columns and a total for "N of M"', async () => {
  const { status, body } = await get('/api/detail?f.region=West&limit=50');
  assert.equal(status, 200);
  assert.deepEqual(body.columns, ['ORDER_ID', 'REGION', 'CATEGORY', 'AMOUNT', 'ORDER_DATE']);
  assert.equal(body.total, 1234);
  assert.equal(body.page.limit, 50);
  assert.ok(!executed.some((e) => /SELECT \*/.test(e.sql)));
});

test('the UI drill sequence produces progressively narrower queries', async () => {
  // Level 1: top-level breakdown by region.
  await get('/api/breakdown?dimension=region&measures=amount');
  // Level 2: user clicked "West" -> group by category, region as a filter.
  await get('/api/breakdown?dimension=category&measures=amount&f.region=West');
  // Drill-through: same crumbs, raw rows.
  await get('/api/detail?f.region=West&f.category=Toys');

  const [level1, level2, detail] = [executed[0], executed[1], executed[2]];

  assert.ok(!level1.sql.includes('WHERE'));
  assert.match(level2.sql, /GROUP BY "CATEGORY"/);
  assert.match(level2.sql, /"REGION" = \?/);
  assert.deepEqual(level2.binds.slice(0, 1), ['West']);
  assert.match(detail.sql, /"REGION" = \?/);
  assert.match(detail.sql, /"CATEGORY" = \?/);
  assert.deepEqual(detail.binds.slice(0, 2), ['West', 'Toys']);
});

test('drilling up reuses the cached parent level', async () => {
  await get('/api/breakdown?dimension=region&measures=amount');
  const afterLevel1 = executed.length;
  await get('/api/breakdown?dimension=category&measures=amount&f.region=West');
  // Breadcrumb click back to level 1 -> served from cache.
  await get('/api/breakdown?dimension=region&measures=amount');
  assert.equal(executed.length, afterLevel1 + 1);
});

test('GET /api/status reports cache and pool telemetry without leaking secrets', async () => {
  const { status, body } = await get('/api/status');
  assert.equal(status, 200);
  assert.equal(body.snowflake.auth, 'key-pair (SNOWFLAKE_JWT)');
  assert.ok(body.cache);
  assert.ok(body.sync);
  const serialised = JSON.stringify(body);
  assert.ok(!/PRIVATE KEY/i.test(serialised));
  assert.ok(!/password/i.test(serialised));
});

test('unknown routes return a 404 JSON body', async () => {
  const { status, body } = await get('/api/does-not-exist');
  assert.equal(status, 404);
  assert.equal(body.error, 'not_found');
});

test('security headers allow iframe embedding and omit X-Frame-Options', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors/);
  // X-Frame-Options has no allowlist syntax and would block embedding outright.
  assert.equal(response.headers.get('x-frame-options'), null);
});
