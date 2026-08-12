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

  if (collection === 'S3Document') {
    /*
     * 4 uploaded documents and NO required-document placeholder, which is the real
     * Telamon situation: 448 uploads across 84 nodes, 0 placeholders.
     * With nothing declaring an expectation, UPLOADED % and MISSING must be null.
     */
    return {
      rows: [{ _id: NODE_ID, uploaded: 4, required: 0, lastDocument: '2026-07-27T00:00:00.000Z' }],
      rowCount: 1,
      elapsedMs: 1,
    };
  }

  if (collection === 'ProgressStats') {
    /*
     * 10 ProgressStats documents: 2 N/A, so 8 APPLICABLE fields -- which is what the
     * portal calls "Total Fields Count". Of those 8: 3 completed, 1 Not Required,
     * 4 without media. Coverage excludes both N/A and Not Required, so 3 of 7.
     *
     * `completedApplicable` and `incomplete` are already N/A-excluded, matching the
     * aggregation, because the portal counts neither an N/A field's completion nor
     * an N/A field's missing media.
     */
    return {
      rows: [
        {
          _id: NODE_ID,
          fields: 10,
          completedApplicable: 3,
          naFields: 2,
          notRequired: 1,
          incomplete: 4,
        },
      ],
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

test('GET /api/monitor/site returns header, metrics, stages, checklist and tracker', async () => {
  const { status, body } = await request(`/api/monitor/site?nodeId=${NODE_ID}`);
  assert.equal(status, 200);
  assert.equal(body.site.name, 'Test Node');
  assert.equal(body.site.aggregate, false);
  assert.ok(body.metrics, 'metrics present');
  assert.ok(Array.isArray(body.stages));
  assert.ok(Array.isArray(body.checklist));
  assert.ok(Array.isArray(body.tracker), 'tracker present -- the table reads from it');
  // Five, not four: TELAMON-ILA-TRACKER carries M1..M5. The retired stage-name
  // model only had four, so this number changing is the point of the switch.
  assert.equal(body.milestoneDefs.length, 5);
  assert.deepEqual(
    body.milestoneDefs.map((m) => m.label),
    ['M1', 'M2', 'M3', 'M4', 'M5']
  );
});

test('milestones with no tracker tasks report pct null, never 0%', async () => {
  const { body } = await request(`/api/monitor/site?nodeId=${NODE_ID}`);
  // The stub returns no tracker rows, which is also the real state on 201 of 202
  // nodes. "No data" must not render as "no progress".
  assert.equal(body.tracker.length, 0);
  assert.equal(body.metrics.milestonesMapped, false);
  for (const m of body.metrics.milestones) {
    assert.equal(m.pct, null, `${m.label} must be null, not 0`);
    assert.equal(m.total, 0);
  }
});

test('tracker is always an array, never null or absent', async () => {
  /*
   * The frontend distinguishes "tracker: []" (the client has not filled it in)
   * from a MISSING tracker field (the server is older than the page). Sending null
   * or omitting it makes the honest-empty case look like a version skew, and it is
   * what let the sample data reach the table once already.
   */
  for (const url of [
    '/api/monitor/site',
    `/api/monitor/site?nodeId=${NODE_ID}`,
    '/api/monitor/site?nodeId=no-such-node',
  ]) {
    const { body } = await request(url);
    assert.ok(Array.isArray(body.tracker), `${url} must send an array, got ${body.tracker}`);
  }
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

test('documents come from S3Document; missing stays null with no required list', async () => {
  const { body } = await request(`/api/monitor/site?nodeId=${NODE_ID}`);
  const m = body.metrics;

  assert.equal(m.documents, 4, 'TOTAL DOCUMENTS counts uploaded files');
  assert.equal(m.lastDocument, '2026-07-27');

  /*
   * The important assertion. Nothing in the source says which documents a Telamon
   * node ought to have -- the required-document feature exists but no template is
   * configured, so there are 0 placeholders across all 202 nodes.
   *
   * 0 would claim "nothing is missing" and 100% would claim "everything is
   * uploaded". Both are inventions. Null renders as "--".
   */
  assert.equal(m.documentsRequired, 0);
  assert.equal(m.documentsPct, null, 'UPLOADED % must be null, never 100%');
  assert.ok(executed.some((e) => e.collection === 'S3Document'));
});

test('document fields are always sent, as a number or null -- never absent', async () => {
  /*
   * The card layer renders `${value}%`. When a field was absent the value was
   * undefined rather than null, a `!== null` guard let it through, and the screen
   * read "undefined%". The UI now treats both alike, and this asserts the server
   * side of that contract: the fields exist on every scope.
   */
  for (const url of ['/api/monitor/site', `/api/monitor/site?nodeId=${NODE_ID}`]) {
    const { body } = await request(url);
    for (const f of ['documents', 'documentsRequired', 'documentsPct']) {
      assert.ok(f in body.metrics, `${url} must send ${f}`);
      const v = body.metrics[f];
      assert.ok(
        v === null || typeof v === 'number',
        `${url}: ${f} must be a number or null, got ${typeof v} ${v}`
      );
    }
  }
});

test('documentPct only reports once something is declared required', () => {
  const { documentPct } = require('../src/config/documents');

  // No expectation declared -> unknown, not complete.
  assert.equal(documentPct({ uploaded: 4, required: 0 }), null);
  assert.equal(documentPct({ uploaded: 0, required: 0 }), null);

  // Once placeholders exist the figure is real: uploaded / (uploaded + outstanding).
  assert.equal(documentPct({ uploaded: 3, required: 1 }), 75);
  assert.equal(documentPct({ uploaded: 0, required: 5 }), 0);
  assert.equal(documentPct({ uploaded: 9, required: 1 }), 90);
});

test('the portal Total Fields Count excludes N/A fields', async () => {
  /*
   * Knolls is the case that proved this: 170 ProgressStats documents, 69 of them
   * N/A, and the portal reports 101 = 170 - 69. It decomposes exactly into the
   * three states the portal also shows -- 59 without media + 38 completed + 4 not
   * required -- so an N/A field is outside the field count entirely.
   *
   * Basile could not have caught it. Its N/A is 0, so both readings gave 165.
   *
   * Stub: 10 documents, 2 N/A -> 8 applicable = 4 without media + 3 done + 1 not
   * required.
   */
  const { body } = await request(`/api/monitor/site?nodeId=${NODE_ID}`);
  const m = body.metrics;
  assert.equal(m.fieldsApplicable, 8, 'Total Fields Count must exclude N/A');
  assert.equal(
    m.incompleteFields + m.fieldsCovered + m.notRequiredFields,
    m.fieldsApplicable,
    'the three states must account for every applicable field'
  );
  assert.equal(m.photoFields, 10, 'the raw photolist count stays available');
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
