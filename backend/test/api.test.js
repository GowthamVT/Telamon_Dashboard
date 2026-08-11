/**
 * End-to-end API tests against the real Express app with the MongoDB driver
 * stubbed out.
 *
 * These cover what unit tests cannot: routing, scope parsing, cache hit/miss and
 * its invalidation, response shape, and that the read-only guard is enforced on
 * the path the routes actually take.
 *
 * The stub asserts on the PIPELINES the service builds, so a change that would
 * query the wrong collection or drop the scope filter fails here rather than
 * silently returning different numbers.
 *
 * Run:  cd backend && npm test
 */
process.env.MONGO_URI = 'mongodb://stub-user:stub-pass@stub-host/stubdb?readPreference=secondaryPreferred';
process.env.MONGO_DATABASE = 'stubdb';
process.env.SYNC_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.APP_LOG_LEVEL = 'error';
process.env.CACHE_TTL_SECONDS = '300';
// A tiny rate limit would make these tests flaky.
process.env.RATE_LIMIT_MAX_REQUESTS = '10000';

const test = require('node:test');
const assert = require('node:assert/strict');

const mongo = require('../src/db/mongo');
const cache = require('../src/cache/queryCache');
const { assertReadOnlyPipeline } = require('../src/db/mongoReadOnly');

// ---------------------------------------------------------------------------
// Stub the driver. Every call is recorded so tests can assert which collection
// was queried and with what $match, and every pipeline is passed through the
// real read-only guard so the tests exercise it too.
// ---------------------------------------------------------------------------
const executed = [];

const NODE_ID = 'node-1';
const SITE_ID = 'site-1';
const COMPANY_ID = 'company-1';

/** One flat node row, shaped exactly like nodesInScope() projects. */
const NODE_ROW = {
  nodeId: NODE_ID,
  siteId: SITE_ID,
  companyId: COMPANY_ID,
  nodeName: 'Test Node',
  nodeCode: 'TEST-NODE',
  routeName: 'TEST-ROUTE',
  companyName: 'Telamon OSP',
  workStatus: 'IN PROGRESS',
  recordStatus: 'Active',
  siteStatus: 'In-progress',
  startDate: '2026-01-15',
};

mongo.aggregate = async (collection, pipeline, opts = {}) => {
  // Exercise the real guard, not a mock of it.
  assertReadOnlyPipeline(pipeline);
  executed.push({ collection, pipeline, label: opts.label });

  if (collection === 'Company') {
    return { rows: [{ _id: COMPANY_ID, companyIdList: [COMPANY_ID], companyName: 'Telamon OSP' }], rowCount: 1, elapsedMs: 1 };
  }

  if (collection === 'SmallCellNode') {
    const grouped = pipeline.some((s) => s.$group && s.$group._id && s.$group._id.siteId);
    if (grouped) {
      // listRoutes
      return { rows: [{ siteId: SITE_ID, companyId: COMPANY_ID, routeName: 'TEST-ROUTE', companyName: 'Telamon OSP', nodeCount: 1 }], rowCount: 1, elapsedMs: 1 };
    }
    const statusGroup = pipeline.some((s) => s.$group && String(s.$group._id?.$ifNull?.[0]).includes('nodeStatus'));
    if (statusGroup) {
      return { rows: [{ _id: 'IN PROGRESS', sites: 1, companyIds: [COMPANY_ID] }], rowCount: 1, elapsedMs: 1 };
    }
    const idOnly = pipeline.some((s) => s.$project && Object.keys(s.$project).join() === '_id,nodeId');
    if (idOnly) return { rows: [{ nodeId: NODE_ID }], rowCount: 1, elapsedMs: 1 };
    return { rows: [NODE_ROW], rowCount: 1, elapsedMs: 1 };
  }

  if (collection === 'FormBuilderQuestions') {
    const dailyForms = pipeline.some((s) => s.$match && s.$match.formName);
    if (dailyForms) return { rows: [{ _id: null, ids: ['daily-form'] }], rowCount: 1, elapsedMs: 1 };
    const grouped = pipeline.some((s) => s.$group && s.$group.photoFields);
    if (grouped) return { rows: [{ _id: NODE_ID, photoFields: 10, formIds: ['form-1'] }], rowCount: 1, elapsedMs: 1 };
    return {
      rows: [{ nodeId: NODE_ID, formId: 'form-1', formName: 'Permitting', typeOfForm: 'photolist', photoFields: 10, docFields: 0 }],
      rowCount: 1,
      elapsedMs: 1,
    };
  }

  if (collection === 'FormGroup') {
    return {
      rows: [{ nodeId: NODE_ID, sequence: 1, name: 'Permitting', kind: 'photolist', formId: 'form-1', customTags: [
        { tagType: 'level 0', tagValues: ['COP MEDIA'] },
        { tagType: 'level 1', tagValues: ['Permitting'] },
        { tagType: 'position', tagValues: ['1'] },
      ] }],
      rowCount: 1,
      elapsedMs: 1,
    };
  }

  if (collection === 'FieldMedia') {
    const byForm = pipeline.some((s) => s.$group && s.$group._id && s.$group._id.formId);
    if (byForm) return { rows: [{ _id: { nodeId: NODE_ID, formId: 'form-1' }, photos: 4, fieldsCovered: 3, lastPhoto: '2026-08-01' }], rowCount: 1, elapsedMs: 1 };
    return { rows: [{ _id: NODE_ID, photosAll: 4, fieldsCovered: 3, photos: 4 }], rowCount: 1, elapsedMs: 1 };
  }

  if (collection === 'FormBuilderAnswers') {
    const byForm = pipeline.some((s) => s.$group && s.$group._id && s.$group._id.formId);
    if (byForm) return { rows: [], rowCount: 0, elapsedMs: 1 };
    return { rows: [{ _id: NODE_ID, reports: 5, reportDays: 4, firstDay: '2026-07-01', lastDay: '2026-07-10' }], rowCount: 1, elapsedMs: 1 };
  }

  if (collection === 'ProgressStats') {
    /*
     * 10 fields: 3 done, 2 N/A, 1 Not Required, 4 outstanding.
     * Both N/A and Not Required must leave the denominator, so coverage is
     * 3 of 7, not 3 of 10 -- see the portal-parity test below.
     */
    return {
      rows: [{ _id: NODE_ID, fields: 10, completed: 3, naFields: 2, notRequired: 1, incomplete: 4 }],
      rowCount: 1,
      elapsedMs: 1,
    };
  }

  return { rows: [], rowCount: 0, elapsedMs: 1 };
};

mongo.find = async (collection, filter, opts = {}) => {
  executed.push({ collection, filter, label: opts.label });
  return { rows: [], rowCount: 0, elapsedMs: 1 };
};

mongo.ping = async () => ({ ok: true, database: 'stubdb', serverVersion: 'stub', elapsedMs: 1 });
mongo.close = async () => {};

const { createApp } = require('../src/app');
const app = createApp();

/** Start the app on an ephemeral port for the duration of one call. */
async function request(path) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, body, headers: res.headers };
  } finally {
    server.close();
  }
}

test.beforeEach(() => {
  executed.length = 0;
  cache.invalidateAll('test');
});

// ---------------------------------------------------------------------------

test('GET /api/health reports MongoDB as the source without touching it', async () => {
  const { status, body } = await request('/api/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.source, 'mongodb');
  // The cheap probe must not query -- a load balancer hitting it should add no
  // load to the production cluster.
  assert.equal(executed.length, 0);
});

test('GET /api/health/mongo does a real round trip', async () => {
  const { status, body } = await request('/api/health/mongo');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.session.database, 'stubdb');
});

test('GET /api/status exposes pool, cache and sync state but no credentials', async () => {
  const { status, body } = await request('/api/status');
  assert.equal(status, 200);
  assert.equal(body.source, 'mongodb');
  assert.equal(body.mongo.database, 'stubdb');
  assert.ok(body.cache);
  assert.ok(body.sync);
  // The URI embeds the password; only the host may ever be exposed.
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes('stub-pass'), 'password must never appear in /status');
  assert.ok(!serialised.includes('mongodb://'), 'the URI must never appear in /status');
});

test('GET /api/monitor/nodes returns the flat node rows', async () => {
  const { status, body } = await request('/api/monitor/nodes');
  assert.equal(status, 200);
  assert.equal(body.nodes.length, 1);
  assert.equal(body.nodes[0].nodeName, 'Test Node');
  assert.equal(body.nodes[0].routeName, 'TEST-ROUTE');
  assert.ok(executed.some((e) => e.collection === 'SmallCellNode'));
});

test('GET /api/monitor/status-counts maps the status vocabulary', async () => {
  const { status, body } = await request('/api/monitor/status-counts');
  assert.equal(status, 200);
  // IN PROGRESS -> inProgress, and the total is the sum of the three buckets.
  assert.equal(body.inProgress, 1);
  assert.equal(body.complete, 0);
  assert.equal(body.total, 1);
  assert.equal(body.scopeLevel, 'company');
  assert.equal(body.grain, 'node');
});

test('scope params reach the $match -- the RLS chokepoint', async () => {
  await request(`/api/monitor/nodes?nodeId=${NODE_ID}&siteId=${SITE_ID}`);
  const nodeQuery = executed.find((e) => e.collection === 'SmallCellNode');
  const match = nodeQuery.pipeline.find((s) => s.$match).$match;
  assert.equal(match.nodeIdList, NODE_ID);
  assert.equal(match.siteIdList, SITE_ID);
});

test('an unknown company pattern matches nothing rather than everything', async () => {
  // The Company stub returns a row, so force the empty path by stubbing it out.
  const original = mongo.aggregate;
  mongo.aggregate = async (collection, pipeline, opts) => {
    if (collection === 'Company') return { rows: [], rowCount: 0, elapsedMs: 1 };
    return original(collection, pipeline, opts);
  };
  try {
    await request('/api/monitor/nodes?company=NoSuchCompany');
    const nodeQuery = executed.find((e) => e.collection === 'SmallCellNode');
    const match = nodeQuery.pipeline.find((s) => s.$match).$match;
    assert.deepEqual(match.companyIdList, { $in: ['__no_company_matched__'] });
  } finally {
    mongo.aggregate = original;
  }
});

test('GET /api/monitor/site returns header, metrics, stages and checklist', async () => {
  const { status, body } = await request(`/api/monitor/site?nodeId=${NODE_ID}`);
  assert.equal(status, 200);
  assert.equal(body.site.name, 'Test Node');
  assert.equal(body.site.aggregate, false);
  assert.ok(body.metrics, 'metrics present');
  assert.ok(Array.isArray(body.stages));
  assert.ok(Array.isArray(body.checklist));
  assert.equal(body.milestoneDefs.length, 4);
});

test('aggregate scope yields name:null so the header cannot claim one node', async () => {
  const { body } = await request('/api/monitor/site');
  assert.equal(body.site.aggregate, true);
  assert.equal(body.site.name, null, 'name must be null when aggregating');
  assert.equal(body.site.detailName, 'Test Node', 'detailName still says which node');
});

test('GET /api/monitor/route attaches metrics to each row', async () => {
  const { status, body } = await request(`/api/monitor/route?siteId=${SITE_ID}`);
  assert.equal(status, 200);
  assert.equal(body.route.name, 'TEST-ROUTE');
  assert.equal(body.route.aggregate, false);
  assert.equal(body.nodes.length, 1);
  assert.ok('metrics' in body.nodes[0]);
});

test('coverage excludes BOTH N/A and Not Required from the denominator', async () => {
  const { body } = await request(`/api/monitor/site?nodeId=${NODE_ID}`);
  const m = body.metrics;

  /*
   * This mirrors the portal's own arithmetic, which is where the rule came from:
   * on Basile it reports 165 fields and 149 "without media", and 165 - 149 = 16
   * = Completed (11) + Not Required (5). Neither an N/A nor a Not Required field
   * is outstanding work, so neither belongs in the denominator.
   *
   * Stub: 10 fields, 3 done, 2 N/A, 1 Not Required -> 3 of 7 = 43%.
   * Excluding only N/A would give 3 of 8 = 38%; excluding neither, 3 of 10 = 30%.
   */
  assert.equal(m.fieldsCovered, 3);
  assert.equal(m.naFields, 2);
  assert.equal(m.notRequiredFields, 1);
  assert.equal(m.coverageDenominator, 7, 'both N/A and Not Required must be excluded');
  assert.equal(m.photoPct, 43);
  assert.equal(m.photoPctApproximate, false);
  // incompleteFields is the portal's "Total Fields without Media".
  assert.equal(m.incompleteFields, 4);
  assert.ok(executed.some((e) => e.collection === 'ProgressStats'));
});

test('item-level N/A is not inferred from wording', async () => {
  /*
   * A rule used to mark items N/A when their NAME contained "if applicable" or
   * "If Required". The portal reports Not Applicable 0 for Basile while that rule
   * produced 2, so it was removed. Only a genuinely not-required item -- one
   * absent from the node's checklist -- may be N/A.
   */
  const { classifyItemStatus } = require('../src/config/statusVocabulary');

  assert.deepEqual(
    classifyItemStatus({ name: 'Fencing & Gates - if applicable', done: false, inChecklist: true }),
    { status: 'missing', statusReason: null },
    'wording must not produce N/A'
  );
  assert.deepEqual(
    classifyItemStatus({ name: 'Utility Construction (If Required)', done: false, inChecklist: true }),
    { status: 'missing', statusReason: null }
  );
  assert.equal(
    classifyItemStatus({ name: 'Some Extra Form', done: false, inChecklist: false }).status,
    'na',
    'not being in the checklist is a fact, and still yields N/A'
  );
  assert.equal(
    classifyItemStatus({ name: 'Anything - if applicable', done: true, inChecklist: true }).status,
    'complete',
    'evidence always wins'
  );
});

test('missed days come from weekdays in the observed window', async () => {
  const { body } = await request(`/api/monitor/site?nodeId=${NODE_ID}`);
  // 2026-07-01 .. 2026-07-10 is 8 weekdays; 4 days reported -> 4 missed.
  assert.equal(body.metrics.reports, 5);
  assert.equal(body.metrics.reportDays, 4);
  assert.equal(body.metrics.missedDays, 4);
});

test('repeat requests are served from cache', async () => {
  const first = await request('/api/monitor/nodes');
  assert.equal(first.headers.get('x-cache'), 'MISS');
  const countAfterFirst = executed.length;

  const second = await request('/api/monitor/nodes');
  assert.equal(second.headers.get('x-cache'), 'HIT');
  assert.equal(executed.length, countAfterFirst, 'a cache hit must not query again');
});

test('cache invalidation forces a refetch', async () => {
  await request('/api/monitor/nodes');
  const before = executed.length;
  cache.invalidateAll('test');
  const again = await request('/api/monitor/nodes');
  assert.equal(again.headers.get('x-cache'), 'MISS');
  assert.ok(executed.length > before, 'invalidation must cause a new query');
});

test('unknown routes 404 with JSON', async () => {
  const { status, body } = await request('/api/does-not-exist');
  assert.equal(status, 404);
  assert.ok(body.error);
});

test('the retired Snowflake analytics endpoints are gone', async () => {
  for (const path of ['/api/summary', '/api/timeseries', '/api/breakdown', '/api/detail']) {
    const { status } = await request(path);
    assert.equal(status, 404, `${path} should no longer exist`);
  }
});
