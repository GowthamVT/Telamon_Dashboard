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
  /*
   * The status transitions, as nodesInScope projects them. Two IN PROGRESS entries so
   * the EARLIEST must win, and the earliest carries a bare M/D/YY comment so the
   * comment must beat the timestamp -- on real data those disagree every time, with 25
   * nodes sharing one bulk-edited timestamp.
   */
  statusLog: [
    { status: 'YET TO START', at: 1735689600000, comments: '' },
    { status: 'IN PROGRESS', at: 1772175600000, comments: '10/14/25' },
    { status: 'IN PROGRESS', at: 1780000000000, comments: '1/2/26' },
  ],
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
    if (dailyForms) {
      /*
       * TWO daily-report forms on the node, one named exactly and one not. The exact one
       * must win outright -- DEFUNIAK SPRINGS carries a pair differing only in case, each
       * with 8 answer sets, and the portal counts 8 rather than 16.
       */
      return {
        rows: [
          { nodeId: NODE_ID, formId: 'daily-form', formName: 'DAILY REPORT FORM' },
          { nodeId: NODE_ID, formId: 'daily-form-360', formName: 'INTEGRATION DAILY REPORT FORM-360' },
        ],
        rowCount: 2,
        elapsedMs: 1,
      };
    }
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
    /*
     * 4 media, 1 approved -> approval is 1/4 = 25%, while PHOTOS UPLOADED is 6/10 = 60%.
     * Deliberately different numbers, so a test cannot pass by confusing the two.
     */
    return {
      rows: [{ _id: NODE_ID, photosAll: 4, fieldsCovered: 3, photos: 4, approvedMedia: 1, rejectedMedia: 0, ignoredMedia: 0 }],
      rowCount: 1,
      elapsedMs: 1,
    };
  }

  if (collection === 'FormBuilderAnswers') {
    const byDay = pipeline.some((s) => s.$group && s.$group._id && s.$group._id.day);
    if (!byDay) return { rows: [], rowCount: 0, elapsedMs: 1 };
    /*
     * 5 submissions over 4 days on the exactly-named form, plus 3 on the -360 form that
     * MUST be ignored. If the per-node preference regresses, reports reads 8.
     */
    return {
      rows: [
        { _id: { nodeId: NODE_ID, formId: 'daily-form', day: '2026-07-01' }, subs: ['a', 'b'] },
        { _id: { nodeId: NODE_ID, formId: 'daily-form', day: '2026-07-02' }, subs: ['c'] },
        { _id: { nodeId: NODE_ID, formId: 'daily-form', day: '2026-07-03' }, subs: ['d'] },
        { _id: { nodeId: NODE_ID, formId: 'daily-form', day: '2026-07-10' }, subs: ['e'] },
        { _id: { nodeId: NODE_ID, formId: 'daily-form-360', day: '2026-07-04' }, subs: ['x', 'y', 'z'] },
      ],
      rowCount: 5,
      elapsedMs: 1,
    };
  }

  if (collection === 'S3Document') {
    /*
     * 4 uploaded documents and NO required-document placeholder, which is the real
     * Telamon situation: 220 node-level uploads across 51 nodes, 0 placeholders.
     *
     * UPLOADED % is therefore allowance usage (4/1000 = 0.4%). MISSING reads the
     * portal's "Total Fields without Media" instead, which comes from ProgressStats.
     */
    return {
      rows: [{ _id: NODE_ID, uploaded: 4, required: 0, lastDocument: '2026-07-27T00:00:00.000Z' }],
      rowCount: 1,
      elapsedMs: 1,
    };
  }

  if (collection === 'ProgressStats') {
    /*
     * 10 ProgressStats rows: 2 N/A, so 8 APPLICABLE fields -- the portal's "Total
     * Fields Count", with "Not Applicable" reported beside it. Of those 8: 3 completed,
     * 1 Not Required, 4 without media.
     *
     * PHOTOS UPLOADED is (10 - 4) / 10 = 60%: every row counts in the denominator, and
     * the numerator is everything not waiting on a photo (2 N/A + 3 done + 1 not
     * required).
     *
     * `completedApplicable` and `incomplete` are already N/A-excluded, matching the
     * aggregation, because the portal counts neither an N/A field's completion nor an
     * N/A field's missing media.
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
  /*
   * M1..M4, by request. The portal's dropdown offers Milestone 1..5 and the sandbox
   * tracker tags two tasks "Milestone 5"; those two now resolve to no milestone and
   * show a "--" chip, rather than being folded into M4 -- which would be a mapping we
   * invented rather than one the client gave us.
   */
  assert.equal(body.milestoneDefs.length, 4);
  assert.deepEqual(
    body.milestoneDefs.map((m) => m.label),
    ['M1', 'M2', 'M3', 'M4']
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

test('Route Monitor milestones come from the tracker, not photo stages', async () => {
  /*
   * The MILESTONES column used to map photolist stage names onto M1-M4 with a rule of
   * ours, which painted amber blocks on nodes where nobody had created a milestone --
   * a stage counted as done as soon as ONE photo existed in it. It also disagreed with
   * the Site Monitor for the same node at the same moment.
   *
   * The stub returns no tracker rows, which is the real state on 201 of 202 nodes, so
   * every milestone must be null and the blocks render grey.
   */
  const { body } = await request(`/api/monitor/route?siteId=${SITE_ID}`);
  const m = body.nodes[0].metrics;

  assert.equal(m.trackerTasks, 0);
  assert.equal(m.milestonesMapped, false);
  assert.equal(m.milestones.length, 4, 'M1..M4 from the tracker, not from photo stages');
  for (const ms of m.milestones) {
    assert.equal(ms.pct, null, `${ms.label} must be null, never a stage-derived figure`);
    assert.equal(ms.total, 0);
  }
  assert.ok(
    executed.some((e) => e.label === 'mongo-tracker-forms'),
    'the route endpoint must query the tracker'
  );
});

test('with no logged transition, a live site falls back to when its status was set', async () => {
  /*
   * 107 Telamon sites are currently IN PROGRESS and 59 of them have an EMPTY
   * historyLog, so the first two tiers find nothing. nodeStatus.updateDate is then the
   * only record that the node became IN PROGRESS, and it is used -- gated on the node
   * being in progress NOW, because on a node that has moved on that stamp describes a
   * later status entirely.
   *
   * Worth knowing what the date is: it clusters, because the statuses were set in bulk
   * by a service account. 24 sites share 2026-07-23.
   */
  const original = mongo.aggregate;
  try {
    mongo.aggregate = async (collection, pipeline, opts = {}) => {
      const res = await original(collection, pipeline, opts);
      if (collection === 'SmallCellNode') {
        res.rows = res.rows.map((r) =>
          'statusLog' in r ? { ...r, statusLog: [], statusSetAt: 1784790000000 } : r
        );
      }
      return res;
    };
    cache.invalidateAll('test');
    const { body } = await request(`/api/monitor/route?siteId=${SITE_ID}`);
    // The stub node's workStatus is IN PROGRESS, so the fallback applies.
    assert.equal(body.nodes[0].inProgressSince, '2026-07-23');
  } finally {
    mongo.aggregate = original;
    cache.invalidateAll('test');
  }
});

test('the node row carries when the site moved to In Progress', async () => {
  /*
   * From SmallCellNode.nodeStatus.historyLog. Two things must hold, and both were
   * measured on live data before being encoded:
   *
   *  1. The EARLIEST IN PROGRESS entry wins, not the latest.
   *  2. A bare M/D/YY comment beats the entry's updatedDate. Across the 57 Telamon
   *     nodes that have such an entry, 25 carry a comment date and it disagrees with
   *     the timestamp in ALL 25 cases -- 25 of them share the timestamp 2026-02-27,
   *     which is a bulk edit rather than a transition.
   *
   * The stub's earliest entry says 10/14/25 while its timestamp is 2026-02-27, so a
   * regression to the timestamp, or to the later entry, changes this value.
   */
  const { body } = await request(`/api/monitor/route?siteId=${SITE_ID}`);
  const node = body.nodes[0];

  assert.equal(node.inProgressSince, '2025-10-14');
  assert.equal(node.startDate, '2026-01-15', 'the start date is still reported separately');
  assert.ok(!('statusLog' in node), 'the raw log is resolved server-side, not shipped');
});

test('GET /api/monitor/route attaches metrics to each row', async () => {
  const { status, body } = await request(`/api/monitor/route?siteId=${SITE_ID}`);
  assert.equal(status, 200);
  assert.equal(body.route.name, 'TEST-ROUTE');
  assert.equal(body.route.aggregate, false);
  assert.equal(body.nodes.length, 1);
  assert.ok('metrics' in body.nodes[0]);
});

test('PHOTOS UPLOADED = (all fields - fields without media) / all fields', async () => {
  const { body } = await request(`/api/monitor/site?nodeId=${NODE_ID}`);
  const m = body.metrics;

  /*
   * The client's formula, given against Eureka:
   *
   *     A = Total Fields Count + Not Applicable   150 + 18 = 168
   *     B = Total Fields without Media                      112
   *     pct = (A - B) / A                          56 / 168 = 33%
   *
   * A is every ProgressStats row, so an N/A field sits in the DENOMINATOR and its
   * satisfaction sits in the numerator -- nobody has to photograph it.
   *
   * Stub: 10 fields, 2 N/A, 1 Not Required, 4 without media, 3 completed.
   *   settled = 10 - 4 = 6, which decomposes as 2 N/A + 3 completed + 1 not required
   *   pct     = 6/10 = 60%
   *
   * The retired reading was completed/(applicable - not required) = 3/7 = 43%. Both are
   * defensible; only one is asked for, and it is now the only one shown on either tab.
   */
  assert.equal(m.fieldsAll, 10, 'denominator includes N/A');
  assert.equal(m.incompleteFields, 4, "the portal's Total Fields without Media");
  assert.equal(m.fieldsSettled, 6);
  assert.equal(m.coveragePct, 60);
  assert.equal(
    m.fieldsSettled,
    m.naFields + m.fieldsCovered + m.notRequiredFields,
    'the numerator must account for exactly the fields needing no photo'
  );
  assert.equal(m.photoPctApproximate, false);
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

  /*
   * UPLOADED % is the portal's figure: files against the per-node allowance.
   * The stub holds 4 uploads and the default limit is 1,000 -> 0.4%.
   */
  assert.equal(m.documentsLimit, 1000);
  assert.equal(m.documentsPct, 0.4);
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

test('a Node Document is untagged AND node-level', () => {
  /*
   * Two conditions, each learned from a node where the dashboard disagreed with the
   * portal. Exercised against the expression directly, because the aggregation is
   * stubbed out in these tests.
   */
  const { NOT_A_DOCUMENT_EXPR } = require('../src/config/documents');
  const [tagClause, levelClause, typeClause] = NOT_A_DOCUMENT_EXPR.$and;

  /*
   * NO TAG. A tagged row belongs to another view -- SITE_SUMMARY_JSONS to nothing
   * user-facing, COP to the close-out package area. Matching only the JSON folder let
   * Knolls' two COP files through and reported 7 against the portal's 5 files /
   * 1.60 MB. Must accept a missing key, an explicit null and an empty string.
   */
  assert.deepEqual(tagClause, { $in: [{ $ifNull: ['$tag', null] }, [null, '']] });

  /*
   * documentLevel EXACTLY 'node'. Rows without one are form-field attachments: they
   * carry answerSetId, formId and questionId, and the portal shows them under the
   * form. GBII > Bowling Green holds two and its Documents page reads 0. 'site' is
   * excluded for the same reason -- a site document is not a node document.
   */
  assert.deepEqual(levelClause, { $eq: ['$documentLevel', 'node'] });

  // Folders and placeholders are not files.
  assert.deepEqual(typeClause.$not.$in[1], ['folder', 'required_placeholder']);
});

test('UPLOADED % reproduces the portal, to one decimal place', () => {
  const { documentUsagePct } = require('../src/config/documents');

  /*
   * The portal header for Knolls reads "FILES 5 / 1000  0.5%".
   *
   * One decimal is required, not cosmetic: rounding to whole percent shows 0% for
   * every node under five files and reads as "nothing uploaded".
   */
  assert.equal(documentUsagePct({ uploaded: 5, limit: 1000 }), 0.5);
  assert.equal(documentUsagePct({ uploaded: 9, limit: 1000 }), 0.9);
  assert.equal(documentUsagePct({ uploaded: 0, limit: 1000 }), 0);
  assert.equal(documentUsagePct({ uploaded: 1, limit: 1000 }), 0.1);

  // A pooled scope scales the allowance by node count -- 220 files over 202 nodes.
  assert.equal(documentUsagePct({ uploaded: 220, limit: 202000 }), 0.1);

  // No allowance means no figure, rather than a division by zero.
  assert.equal(documentUsagePct({ uploaded: 5, limit: 0 }), null);
});

test('media approval is still computed, distinct from PHOTOS UPLOADED', async () => {
  /*
   * Upton is the case: its Node Media header reads "Total Approved Media 12" and
   * "Total Media Count 35", and the portal's figure is 12/35 = 34%. The dashboard
   * used to show field coverage there -- 13/159 = 8% -- which is a different
   * question and a very different number.
   *
   * PHOTOS UPLOADED is a different figure again -- see its own test -- and approval
   * lives on in the row tooltip and the Node Media strip.
   */
  const { body } = await request(`/api/monitor/site?nodeId=${NODE_ID}`);
  const m = body.metrics;

  assert.equal(m.approvedMedia, 1);
  assert.equal(m.photos, 4);
  assert.equal(m.mediaApprovedPct, 25, 'approved / total media, still computed');
  assert.equal(m.coveragePct, 60, 'PHOTOS UPLOADED is a different figure -- 6/10, not 1/4');
});

test('media approval is null, not 0, when a node has no media', async () => {
  /*
   * Nothing submitted is not the same as nothing approved. 88% of Telamon nodes that
   * have photos have zero approved media, so this distinction decides whether the
   * dashboard reads "--" or a red 0% across most of the estate.
   */
  const { documentUsagePct } = require('../src/config/documents');
  assert.equal(typeof documentUsagePct, 'function');

  const original = mongo.aggregate;
  try {
    mongo.aggregate = async (collection, pipeline, opts = {}) => {
      if (collection === 'FieldMedia') {
        const byForm = pipeline.some((s) => s.$group && s.$group._id && s.$group._id.formId);
        if (byForm) return { rows: [], rowCount: 0, elapsedMs: 1 };
        return { rows: [], rowCount: 0, elapsedMs: 1 };
      }
      return original(collection, pipeline, opts);
    };
    cache.invalidateAll('test');
    const { body } = await request(`/api/monitor/site?nodeId=${NODE_ID}`);
    assert.equal(body.metrics.photos, 0);
    assert.equal(body.metrics.mediaApprovedPct, null, 'no media -> "--", never 0%');
  } finally {
    mongo.aggregate = original;
    cache.invalidateAll('test');
  }
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

test('daily reports count ONE form per node, the exactly-named one', async () => {
  /*
   * A /DAILY REPORT/i sweep summed every variant and overstated most nodes. The portal
   * counts the exactly-named form alone:
   *
   *   DEFUNIAK SPRINGS   DAILY REPORT FORM 8 · Daily Report form 8 · INTEGRATION 5 -> 8
   *   PASS CHRISTIAN     DAILY REPORT FORM 16 · INTEGRATION 1                      -> 16
   *
   * Stub: 5 submissions over 4 days on 'DAILY REPORT FORM', plus 3 on the -360 form.
   * A regression to the old sweep reads 8.
   */
  const { body } = await request(`/api/monitor/site?nodeId=${NODE_ID}`);
  const m = body.metrics;

  assert.equal(m.reports, 5, 'the -360 form must not be added in');
  assert.equal(m.reportDays, 4, 'distinct days, so two submissions in one day count once');
  assert.equal(m.lastReport, '2026-07-10');
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
