/**
 * Completion Monitor data service -- MongoDB source.
 *
 * The MongoDB counterpart to monitorService.js. Same function names, same return
 * shapes, so routes/monitors.js can swap between them and the frontend never
 * knows. MONGO_ENABLED picks which one serves.
 *
 * -------------------------------------------------------------------------
 * WHAT SNOWFLAKE DID FOR US THAT THIS FILE HAS TO DO ITSELF
 *
 * ECSITE.ANALYTICS.CLOUD_NODE is a *modelled* table: dbt joined node, site and
 * company into one flat row with "Company Name", "Site Name", "Node Name",
 * "Node Status" and "Node Start Date". In MongoDB those live in three
 * collections with different shapes, so nodesInScope() below rebuilds that row.
 * Every query starts from it, exactly as every SQL query started from CLOUD_NODE.
 *
 * VERIFIED FIELD MAPPING (checked against the live cluster, not assumed):
 *   "nodeId"              SmallCellNode.nodeId
 *   "Node Name"           SmallCellNode.nodeName
 *   "Node Code"           SmallCellNode.nodeCode
 *   "siteId"              SmallCellNode.siteId
 *   "Site Name" (=route)  Site.siteName          -- NOT SmallCellNode.siteCode,
 *                                                   which uses underscores
 *   "companyId"           SmallCellNode.companyId
 *   "Company Name"        Company.companyName
 *   "Node Status"         SmallCellNode.nodeStatus.status   (nested object)
 *   "Node Current Status" SmallCellNode.currentStatus
 *   "Site Status"         Site.siteStatus.status
 *   "Node Start Date"     SmallCellNode.nodeStartDate       (epoch ms)
 *
 * TRAPS, all of which cost real debugging time:
 *   - `_id` is an ObjectId; the scalar id FIELDS (nodeId, siteId, companyId) are
 *     strings. Joining a string field to `_id` silently returns nothing.
 *   - Site joins on `siteIdList`. `Site.siteId` holds the CODE
 *     (LUMEN_ILA_HOUSTON_ATLANTA), not an id.
 *   - Filter SmallCellNode on the *List fields (nodeIdList / companyIdList):
 *     those are indexed, the scalar equivalents are not.
 *   - nodeStartDate is mixed double/long/null, so it needs a null guard before
 *     $toDate or the whole pipeline errors on the nodes that lack one.
 *   - Do NOT filter isDeleted on SmallCellNode: CLOUD_NODE does not either, and
 *     3 soft-deleted Telamon OSP nodes are inside today's counts. Excluding them
 *     would change 202 to 199 -- a data fix, but not part of a source swap.
 * -------------------------------------------------------------------------
 */
const mongo = require('../db/mongo');
const cache = require('../cache/queryCache');

/**
 * Status classification is imported from the Snowflake service on purpose.
 *
 * Both adapters MUST bucket statuses identically or the KPI card changes when
 * the flag flips. Re-implementing STATUS_MAP here would let the two drift; one
 * shared implementation cannot. Requiring the module does not open a Snowflake
 * connection -- its pool is created lazily on first query.
 */
const { classifyStatus, DEFAULT_COMPANY_PATTERN } = require('./monitorService');

/**
 * Milestone definitions, shared with the Snowflake service for the same reason:
 * this is a business-rule mapping, not source data, so both adapters must read
 * the one copy or the milestone bars would differ when the flag flips.
 */
const { MILESTONES, MAPPED_STAGES, MIN_MAPPED_STAGES } = require('../config/milestones');

const NODES = 'SmallCellNode';
const SITES = 'Site';
const COMPANIES = 'Company';

/** Bucket for nodes with no status at all, mirroring the Snowflake service. */
const NO_STATUS = '(no status history)';

/**
 * -------------------------------------------------------------------------
 * THE RLS CHOKEPOINT.
 *
 * The MongoDB equivalent of buildScope(). Every query filters through here, so
 * a per-user predicate added in this one function is inherited by all of them.
 *
 * Today companyPattern defaults to Telamon -- an explicit single-tenant scope
 * rather than "no filter", so the unrestricted case never becomes the default by
 * accident. When auth lands, derive companyId/siteId/nodeId from the
 * authenticated principal and pass them in; the name-pattern fallback should
 * then be removed so a missing principal fails closed.
 *
 * Returns a $match stage. companyPattern needs the Company collection resolved
 * first (names live there, not on the node), which resolveCompanyIds() does.
 * -------------------------------------------------------------------------
 */
async function buildMatch({ companyPattern = DEFAULT_COMPANY_PATTERN, companyId, siteId, nodeId } = {}) {
  const match = {};

  if (companyId) {
    match.companyIdList = companyId;
  } else if (companyPattern) {
    const ids = await resolveCompanyIds(companyPattern);
    // No match must return nothing, never everything.
    match.companyIdList = { $in: ids.length ? ids : ['__no_company_matched__'] };
  }

  if (siteId) match.siteIdList = siteId;
  if (nodeId) match.nodeIdList = nodeId;

  return match;
}

/**
 * Company ids whose name matches an ILIKE-style pattern.
 *
 * Snowflake could say `"Company Name" ILIKE '%Telamon%'` because the name was on
 * every node row. Here the name lives only on Company, so the pattern is
 * resolved to ids first and the nodes are filtered by id.
 *
 * Cached because it is a tiny collection (428 docs) hit by every query.
 */
async function resolveCompanyIds(pattern) {
  /*
   * Returns { ids }, NOT a bare array. cache.wrap() attaches its metadata with
   * `{ ...result, cache }`, which turns an array into a plain object -- so a
   * cached array comes back as {0:'..',1:'..'} with no .length, and every
   * length check silently reads undefined. Wrapping in an object avoids that.
   */
  const cached = await cache.wrap('mongo-company-ids', { pattern }, async () => {
    // Translate SQL LIKE wildcards into a regex, escaping everything else.
    const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp('^' + escaped.replace(/%/g, '.*') + '$', 'i');

    const { rows } = await mongo.aggregate(
      COMPANIES,
      [
        { $match: { companyName: rx, isDeleted: { $ne: true } } },
        { $project: { companyIdList: 1, companyName: 1 } },
      ],
      { label: 'mongo-company-ids' }
    );

    // companyIdList holds the string id every other collection joins on; _id is
    // an ObjectId and will not match, so prefer the list.
    const ids = [];
    for (const r of rows) {
      const fromList = Array.isArray(r.companyIdList) ? r.companyIdList : [];
      if (fromList.length) ids.push(...fromList.map(String));
      else ids.push(String(r._id));
    }
    return { ids: [...new Set(ids)] };
  });

  return Array.isArray(cached.ids) ? cached.ids : [];
}

/**
 * Reduce any scope to its COMPANY level only.
 *
 * Identical intent to companyScopeOf() in the Snowflake service: the status KPI
 * is a company-level figure by design, so drilling into one site must not shrink
 * it. This WIDENS scope, so it must never be applied to a per-user RLS predicate
 * -- companyId/companyPattern are preserved precisely because they are the
 * tenant boundary.
 */
function companyScopeOf(scope = {}) {
  const { companyId, companyPattern } = scope;
  return {
    ...(companyId ? { companyId } : {}),
    ...(companyPattern ? { companyPattern } : {}),
  };
}

/**
 * THE CLOUD_NODE EQUIVALENT: one flat row per node in scope.
 *
 * $lookup + $unwind rather than two round trips, so the join happens on the
 * server and only the projected fields cross the wire.
 */
async function nodesInScope(scope = {}, { label = 'mongo-nodes' } = {}) {
  const match = await buildMatch(scope);

  const pipeline = [
    { $match: match },
    {
      // Site.siteIdList, NOT Site.siteId -- the latter holds the site CODE.
      $lookup: {
        from: SITES,
        localField: 'siteId',
        foreignField: 'siteIdList',
        as: 'site',
        pipeline: [{ $project: { siteName: 1, siteStatus: 1, currentStatus: 1 } }],
      },
    },
    {
      $lookup: {
        from: COMPANIES,
        localField: 'companyId',
        foreignField: 'companyIdList',
        as: 'company',
        pipeline: [{ $project: { companyName: 1 } }],
      },
    },
    {
      $project: {
        _id: 0,
        nodeId: '$nodeId',
        siteId: '$siteId',
        companyId: '$companyId',
        nodeName: '$nodeName',
        nodeCode: '$nodeCode',
        routeName: { $ifNull: [{ $first: '$site.siteName' }, null] },
        companyName: { $ifNull: [{ $first: '$company.companyName' }, null] },
        // nodeStatus is an object here; Snowflake flattened it to a string.
        workStatus: { $ifNull: ['$nodeStatus.status', null] },
        recordStatus: { $ifNull: ['$currentStatus', null] },
        siteStatus: { $ifNull: [{ $first: '$site.siteStatus.status' }, null] },
        // Mixed double/long/null -- guard before converting, or nodes without a
        // start date abort the pipeline instead of returning null.
        startDate: {
          $cond: [
            { $in: [{ $type: '$nodeStartDate' }, ['double', 'long', 'int', 'decimal', 'date']] },
            { $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$nodeStartDate' } } },
            null,
          ],
        },
      },
    },
    { $sort: { nodeName: 1 } },
  ];

  const { rows, elapsedMs } = await mongo.aggregate(NODES, pipeline, { label });
  return { nodes: rows, elapsedMs };
}

/** Nodes in scope. Mirrors listNodes() in the Snowflake service. */
async function listNodes(scope = {}) {
  return cache.wrap('mongo-monitor-nodes', scope, async () => {
    const { nodes, elapsedMs } = await nodesInScope(scope, { label: 'mongo-monitor-nodes' });
    return { nodes, elapsedMs };
  });
}

/** Routes ("Site Name") in scope, with their node counts. */
async function listRoutes(scope = {}) {
  return cache.wrap('mongo-monitor-routes', scope, async () => {
    const match = await buildMatch(scope);

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: { siteId: '$siteId', companyId: '$companyId' },
          nodeIds: { $addToSet: '$nodeId' },
        },
      },
      {
        $lookup: {
          from: SITES,
          localField: '_id.siteId',
          foreignField: 'siteIdList',
          as: 'site',
          pipeline: [{ $project: { siteName: 1 } }],
        },
      },
      {
        $lookup: {
          from: COMPANIES,
          localField: '_id.companyId',
          foreignField: 'companyIdList',
          as: 'company',
          pipeline: [{ $project: { companyName: 1 } }],
        },
      },
      {
        $project: {
          _id: 0,
          siteId: '$_id.siteId',
          companyId: '$_id.companyId',
          routeName: { $ifNull: [{ $first: '$site.siteName' }, null] },
          companyName: { $ifNull: [{ $first: '$company.companyName' }, null] },
          nodeCount: { $size: '$nodeIds' },
        },
      },
      { $sort: { nodeCount: -1, routeName: 1 } },
    ];

    const { rows, elapsedMs } = await mongo.aggregate(NODES, pipeline, {
      label: 'mongo-monitor-routes',
    });
    return { routes: rows, elapsedMs };
  });
}

/**
 * KPI card counts: NODES per status, following the current selection.
 *
 * Source is SmallCellNode.nodeStatus.status -- the equivalent of CLOUD_NODE's
 * "Node Status", and for the same reasons: complete coverage, and it agrees with
 * the table rows beneath the card.
 */
async function getStatusCounts(scope = {}) {
  return cache.wrap('mongo-monitor-status-counts', scope, async () => {
    const match = await buildMatch(scope);

    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ['$nodeStatus.status', NO_STATUS] },
          sites: { $sum: 1 },
          companyIds: { $addToSet: '$companyId' },
        },
      },
      { $sort: { sites: -1 } },
    ];

    const { rows, elapsedMs } = await mongo.aggregate(NODES, pipeline, {
      label: 'mongo-monitor-status-counts',
    });

    const counts = { complete: 0, inProgress: 0, yetToStart: 0 };
    const unmapped = [];
    const companyIds = new Set();

    for (const row of rows) {
      const bucket = classifyStatus(row._id);
      const n = Number(row.sites) || 0;
      if (bucket) counts[bucket] += n;
      else unmapped.push({ status: row._id, sites: n });
      for (const id of row.companyIds || []) if (id) companyIds.add(String(id));
    }

    // Company NAMES for the card label; ids alone would be meaningless on screen.
    let names = [];
    if (companyIds.size) {
      const { rows: cos } = await mongo.aggregate(
        COMPANIES,
        [
          { $match: { companyIdList: { $in: [...companyIds] } } },
          { $project: { companyName: 1 } },
        ],
        { label: 'mongo-company-names' }
      );
      names = [...new Set(cos.map((c) => c.companyName).filter(Boolean))].sort();
    }

    /** One company -> its name; several -> shared prefix, else a count. */
    const label =
      names.length === 1
        ? names[0]
        : names.length > 1
          ? names.every((n) => n.startsWith(names[0].split(' ')[0]))
            ? names[0].split(' ')[0]
            : `${names.length} companies`
          : (scope.companyPattern || DEFAULT_COMPANY_PATTERN).replace(/%/g, '');

    return {
      ...counts,
      total: counts.complete + counts.inProgress + counts.yetToStart,
      scopeLevel: scope.nodeId ? 'node' : scope.siteId ? 'site' : 'company',
      grain: 'node',
      scopeLabel: label,
      companies: names,
      raw: rows.map((r) => ({ status: r._id, sites: Number(r.sites) || 0 })),
      unmapped,
      elapsedMs,
    };
  });
}

/** The Company > Site > Node tree that drives the scope picker. */
async function getHierarchy(scope = {}) {
  return cache.wrap('mongo-monitor-hierarchy', scope, async () => {
    const { nodes, elapsedMs } = await nodesInScope(scope, { label: 'mongo-monitor-hierarchy' });

    // Sorted the same way the SQL ORDER BY did, so the picker lists identically.
    const sorted = [...nodes].sort(
      (a, b) =>
        String(a.companyName).localeCompare(String(b.companyName)) ||
        String(a.routeName).localeCompare(String(b.routeName)) ||
        String(a.nodeName).localeCompare(String(b.nodeName))
    );

    const companies = new Map();
    for (const r of sorted) {
      if (!companies.has(r.companyId)) {
        companies.set(r.companyId, {
          companyId: r.companyId,
          companyName: r.companyName,
          sites: new Map(),
        });
      }
      const company = companies.get(r.companyId);

      if (!company.sites.has(r.siteId)) {
        company.sites.set(r.siteId, {
          siteId: r.siteId,
          siteName: r.routeName,
          siteStatus: r.siteStatus,
          nodes: [],
        });
      }
      company.sites.get(r.siteId).nodes.push({
        nodeId: r.nodeId,
        nodeName: r.nodeName,
        startDate: r.startDate,
      });
    }

    const tree = [...companies.values()].map((c) => {
      const sites = [...c.sites.values()];
      return {
        ...c,
        sites,
        siteCount: sites.length,
        nodeCount: sites.reduce((sum, s) => sum + s.nodes.length, 0),
      };
    });

    return {
      companies: tree,
      totals: {
        companies: tree.length,
        sites: tree.reduce((sum, c) => sum + c.siteCount, 0),
        nodes: tree.reduce((sum, c) => sum + c.nodeCount, 0),
      },
      elapsedMs,
    };
  });
}

/* ---------------------------------------------------------------------------
 * getNodeMetrics support
 * ------------------------------------------------------------------------- */

/**
 * Normalise a stage name for milestone lookup.
 *
 * Must match the Snowflake expression exactly --
 * LOWER(REGEXP_REPLACE(text, '[^a-zA-Z0-9]', '')) -- or the same stage would
 * classify differently between the two adapters.
 */
function normaliseStage(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Working days (Mon-Fri) between two dates inclusive.
 *
 * Replaces ANALYTICS.CALENDAR, which the SQL joined for "Day of Week" NOT IN
 * (1,7). Like CALENDAR, this has no holiday list, so public holidays still count
 * as missed -- the same known limitation, not a new one.
 */
function workingDaysBetween(firstIso, lastIso) {
  if (!firstIso || !lastIso) return 0;
  const start = new Date(firstIso + 'T00:00:00Z');
  const end = new Date(lastIso + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;

  let count = 0;
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

/**
 * Attribute a per-node aggregation back to the nodes we asked for.
 *
 * The id collections carry nodeIdList (an array), so a document can belong to
 * several nodes. $unwind then re-matching against the requested ids is what
 * keeps a shared form from being counted against nodes outside the scope.
 */
function unwindToNodes(nodeIds) {
  return [
    { $match: { nodeIdList: { $in: nodeIds } } },
    { $unwind: '$nodeIdList' },
    { $match: { nodeIdList: { $in: nodeIds } } },
  ];
}

/**
 * Per-node metrics: photos, photo fields, daily reports, missed days, milestones.
 *
 * The Snowflake version is one 150-line statement of CTEs. Here it is several
 * batched aggregations assembled in JS -- same inputs, same outputs, and each
 * piece can be checked on its own.
 *
 * SOURCE CHOICES, both tested rather than assumed:
 *
 *  - Photos come from FieldMedia. Verified exact: Wadley's photolist forms sum
 *    to 686, matching Snowflake. This also replaces
 *    CLOUD_PHOTOCOUNT_PHOTOLIST_AGG.PHOTOLISTENTRIES, which is the same figure
 *    pre-aggregated.
 *
 *  - Daily reports come from FormBuilderAnswers, NOT FieldMedia. FieldMedia only
 *    has a row when a report carries a photo, and across the 193 Telamon nodes
 *    with a daily-report form it undercounts on 48 of them -- 376 against 501,
 *    so 125 reports have no photo. Walnut-MS alone reads 7 instead of 24. Using
 *    it would also inflate missed days, since fewer report days means more days
 *    counted as missed.
 */
async function getNodeMetrics(scope = {}) {
  return cache.wrap('mongo-monitor-node-metrics', scope, async () => {
    const started = Date.now();
    const match = await buildMatch(scope);

    // The nodes in scope. Everything below is keyed on these ids.
    const { rows: scoped } = await mongo.aggregate(
      NODES,
      [{ $match: match }, { $project: { _id: 0, nodeId: 1 } }],
      { label: 'mongo-metrics-scope' }
    );
    const nodeIds = scoped.map((n) => n.nodeId).filter(Boolean);
    if (!nodeIds.length) return { byNode: {}, nodeCount: 0, elapsedMs: Date.now() - started };

    /* ---- 1. checklist photolist stages per node (for the milestone rollup) ---- */
    const { rows: stageRows } = await mongo.aggregate(
      'FormGroup',
      [
        ...unwindToNodes(nodeIds),
        { $match: { isDeleted: { $ne: true } } },
        { $unwind: '$list' },
        { $match: { 'list.typeOfForm': 'photolist', 'list.isDeleted': { $ne: true } } },
        {
          $project: {
            _id: 0,
            nodeId: '$nodeIdList',
            text: '$list.text',
            formId: '$list.formId',
          },
        },
      ],
      { label: 'mongo-metrics-stages' }
    );

    /* ---- 2. photo media per (node, form), for per-stage photo counts ---- */
    const { rows: mediaByForm } = await mongo.aggregate(
      'FieldMedia',
      [
        ...unwindToNodes(nodeIds),
        // mime is 'photo' on some rows and 'image' on others -- both are photos.
        { $match: { isDeleted: { $ne: true }, mime: { $in: ['photo', 'image'] } } },
        { $group: { _id: { nodeId: '$nodeIdList', formId: '$formId' }, photos: { $sum: 1 } } },
      ],
      { label: 'mongo-metrics-stage-media' }
    );
    const photosByNodeForm = new Map();
    for (const r of mediaByForm) {
      photosByNodeForm.set(`${r._id.nodeId}::${r._id.formId}`, r.photos);
    }

    /* ---- 3. photo FIELDS defined, and the photolist form ids ----
     * Enumerated from FormBuilderQuestions by the node's own keys, NOT from the
     * checklist -- the checklist omits forms that still hold data. Same reason
     * the SQL version does it this way. */
    const { rows: fieldRows } = await mongo.aggregate(
      'FormBuilderQuestions',
      [
        ...unwindToNodes(nodeIds),
        { $match: { isDeleted: { $ne: true }, typeOfForm: 'photolist' } },
        {
          $project: {
            nodeId: '$nodeIdList',
            formId: { $toString: '$_id' },
            photoFields: {
              $size: {
                $filter: {
                  input: { $ifNull: ['$list', []] },
                  as: 'f',
                  // element='Photo' only -- Section_Header rows are layout.
                  cond: { $eq: ['$$f.element', 'Photo'] },
                },
              },
            },
          },
        },
        {
          $group: {
            _id: '$nodeId',
            photoFields: { $sum: '$photoFields' },
            formIds: { $addToSet: '$formId' },
          },
        },
      ],
      { label: 'mongo-metrics-photo-fields' }
    );
    const fieldsByNode = new Map(fieldRows.map((r) => [r._id, r]));

    /* ---- 4. all media per node: total, and distinct fields covered ---- */
    const { rows: allMedia } = await mongo.aggregate(
      'FieldMedia',
      [
        ...unwindToNodes(nodeIds),
        { $match: { isDeleted: { $ne: true } } },
        {
          $group: {
            _id: '$nodeIdList',
            photosAll: { $sum: 1 },
            questionIds: { $addToSet: '$questionId' },
            photolistIds: { $addToSet: { formId: '$formId', mime: '$mime' } },
          },
        },
        {
          $project: {
            photosAll: 1,
            fieldsCovered: { $size: '$questionIds' },
          },
        },
      ],
      { label: 'mongo-metrics-media' }
    );
    const mediaByNode = new Map(allMedia.map((r) => [r._id, r]));

    /* ---- 5. photolist-only media: the headline photo figure ---- */
    const photolistFormIds = [...new Set(fieldRows.flatMap((r) => r.formIds || []))];
    const photosByNode = new Map();
    if (photolistFormIds.length) {
      const { rows } = await mongo.aggregate(
        'FieldMedia',
        [
          { $match: { nodeIdList: { $in: nodeIds }, formId: { $in: photolistFormIds } } },
          { $unwind: '$nodeIdList' },
          { $match: { nodeIdList: { $in: nodeIds }, isDeleted: { $ne: true } } },
          { $group: { _id: '$nodeIdList', photos: { $sum: 1 } } },
        ],
        { label: 'mongo-metrics-photolist-media' }
      );
      rows.forEach((r) => photosByNode.set(r._id, r.photos));
    }

    /* ---- 6. daily reports ----
     * Forms identified by NAME in the definitions, deliberately not via the
     * node's checklist: the DAILY REPORT FORM is frequently absent from it.
     * Alexander City has 19 submissions but a checklist containing only
     * COP-Documents and the tracker, so the checklist route reported 0. */
    const { rows: dailyForms } = await mongo.aggregate(
      'FormBuilderQuestions',
      [
        { $match: { formName: { $regex: 'DAILY REPORT', $options: 'i' }, isDeleted: { $ne: true } } },
        { $group: { _id: null, ids: { $addToSet: { $toString: '$_id' } } } },
      ],
      { label: 'mongo-metrics-daily-forms' }
    );
    const dailyFormIds = dailyForms.length ? dailyForms[0].ids : [];

    const reportsByNode = new Map();
    if (dailyFormIds.length) {
      const { rows } = await mongo.aggregate(
        'FormBuilderAnswers',
        [
          { $match: { nodeIdList: { $in: nodeIds }, formId: { $in: dailyFormIds } } },
          { $unwind: '$nodeIdList' },
          { $match: { nodeIdList: { $in: nodeIds }, isDeleted: { $ne: true } } },
          {
            // Per node per DAY, so submissions and distinct days both come out.
            $group: {
              _id: {
                nodeId: '$nodeIdList',
                day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              },
              subs: { $addToSet: '$answerSetId' },
            },
          },
          {
            $group: {
              _id: '$_id.nodeId',
              reports: { $sum: { $size: '$subs' } },
              reportDays: { $sum: 1 },
              firstDay: { $min: '$_id.day' },
              lastDay: { $max: '$_id.day' },
            },
          },
        ],
        { label: 'mongo-metrics-reports' }
      );
      rows.forEach((r) => reportsByNode.set(r._id, r));
    }

    /* ---- 7. assemble ---- */
    const stagesByNode = new Map();
    for (const s of stageRows) {
      if (!stagesByNode.has(s.nodeId)) stagesByNode.set(s.nodeId, []);
      stagesByNode.get(s.nodeId).push({
        norm: normaliseStage(s.text),
        photos: photosByNodeForm.get(`${s.nodeId}::${s.formId}`) || 0,
      });
    }

    const byNode = {};
    for (const nodeId of nodeIds) {
      const stages = stagesByNode.get(nodeId) || [];
      const mappedTotal = stages.filter((s) => MAPPED_STAGES.includes(s.norm)).length;
      // A node whose checklist matches no known stage is on a different template
      // (0MH PHOTOS, WBS codes, in-building levels). Not measurable, which is
      // different from being at 0%.
      const mapped = mappedTotal >= MIN_MAPPED_STAGES;

      const f = fieldsByNode.get(nodeId) || { photoFields: 0 };
      const m = mediaByNode.get(nodeId) || { photosAll: 0, fieldsCovered: 0 };
      const r = reportsByNode.get(nodeId) || null;
      const photoFields = Number(f.photoFields) || 0;
      const fieldsCovered = Number(m.fieldsCovered) || 0;

      // NULL, not 0, when the node never reported: there is no window to measure,
      // which is different from having missed zero days.
      let missedDays = null;
      if (r) {
        const workDays = workingDaysBetween(r.firstDay, r.lastDay);
        missedDays = Math.max(workDays - Number(r.reportDays || 0), 0);
      }

      byNode[nodeId] = {
        milestonesMapped: mapped,
        mappedStages: mappedTotal,
        totalStages: stages.length,
        stagePhotos: stages.reduce((sum, s) => sum + s.photos, 0),
        milestones: MILESTONES.map((ms) => {
          if (ms.stages.length === 0) {
            return {
              key: ms.key, label: ms.label, name: ms.name,
              measurable: false, reason: ms.unmeasurableReason,
              pct: null, done: 0, total: 0,
            };
          }
          const inMs = stages.filter((s) => ms.stages.includes(s.norm));
          const total = inMs.length;
          const done = inMs.filter((s) => s.photos > 0).length;
          return {
            key: ms.key, label: ms.label, name: ms.name,
            measurable: mapped && total > 0,
            done, total,
            pct: mapped && total > 0 ? Math.round((done / total) * 100) : null,
          };
        }),
        reports: r ? Number(r.reports) || 0 : 0,
        reportDays: r ? Number(r.reportDays) || 0 : 0,
        lastReport: r ? r.lastDay || null : null,
        missedDays,

        photoFields,
        photos: photosByNode.get(nodeId) || 0,
        photosAllMedia: Number(m.photosAll) || 0,
        fieldsCovered,
        photoPct: photoFields > 0 ? Math.min(100, Math.round((fieldsCovered / photoFields) * 100)) : null,
        photoPctApproximate: true,
      };
    }

    return { byNode, nodeCount: nodeIds.length, elapsedMs: Date.now() - started };
  });
}

module.exports = {
  DEFAULT_COMPANY_PATTERN,
  buildMatch,
  companyScopeOf,
  classifyStatus,
  resolveCompanyIds,
  nodesInScope,
  normaliseStage,
  workingDaysBetween,
  listNodes,
  listRoutes,
  getStatusCounts,
  getHierarchy,
  getNodeMetrics,
};
