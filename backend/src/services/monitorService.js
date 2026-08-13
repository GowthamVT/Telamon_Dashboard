/**
 * Completion Monitor data service -- MongoDB source.
 *
 * The single data source for both monitor dashboards. Previously this sat beside
 * a Snowflake implementation behind a feature flag; that has been removed and
 * MongoDB is now the only source.
 *
 * -------------------------------------------------------------------------
 * THE FLAT NODE ROW
 *
 * Node, site and company live in three collections with different shapes, so
 * nodesInScope() joins them into one flat row and every query starts from it.
 * (The retired Snowflake path read a pre-joined CLOUD_NODE table, which is why
 * that join had to be rebuilt here.)
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
/** For documents.fileLimitPerNode -- the portal's "/ 1000" is not in the database. */
const config = require('../config/env');

/**
 * Status and item-status rules live in config, not here: they are business rules
 * rather than source data, and keeping them separate is what let the Snowflake
 * adapter be deleted without touching any of them.
 */
const {
  classifyStatus,
  classifyItemStatus,
  DEFAULT_COMPANY_PATTERN,
} = require('../config/statusVocabulary');

/**
 * Milestone definitions. A business-rule mapping, not source data -- no
 * collection in MongoDB carries a milestone field.
 */
const {
  MILESTONES,
  MAPPED_STAGES,
  MIN_MAPPED_STAGES,
  /**
   * normaliseStage and classifyStage come from the shared config, not a local
   * copy. An identical-looking duplicate is exactly how the two adapters would
   * drift: change the regex in one place and the same stage classifies
   * differently depending on which source is serving.
   */
  normaliseStage,
  classifyStage,
} = require('../config/milestones');

/** What counts as a document, and why "missing" is null -- see config/documents.js. */
const {
  NOT_A_DOCUMENT_EXPR,
  IS_PLACEHOLDER_EXPR,
  documentUsagePct,
} = require('../config/documents');

/** The tracker is the client's own milestone definition -- see config/tracker.js. */
const {
  TRACKER_FORM_NAME,
  TRACKER_MILESTONES,
  milestoneForTask,
  trackerTaskStatus,
  isSectionHeader,
} = require('../config/tracker');

/**
 * Header/payload assembly is shared with monitorService rather than copied. The
 * aggregate and `name: null` handling was itself a bug fix; two copies means the
 * next fix lands in one adapter only, and the symptom would be a wrong header
 * that appears solely when MONGO_ENABLED is flipped.
 */
const { composeRouteMonitor, composeSiteMonitor } = require('./monitorComposition');

const NODES = 'SmallCellNode';
const SITES = 'Site';
const COMPANIES = 'Company';

/** Bucket for nodes with no status at all. */
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
 * The status KPI is a company-level figure by design, so drilling into one site
 * must not shrink it. This WIDENS scope, so it must never be applied to a per-user RLS predicate
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

/** Nodes in scope. */
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
          {
            $group: {
              _id: '$nodeIdList',
              photos: { $sum: 1 },
              /*
               * The reviewer's decision per media row: FieldMedia.approvalStatus.
               *
               * NOT `status`, which is null on every one of Knolls' 106 rows and is
               * why the dashboard reported 0 rejected where the portal says 2.
               *
               * Values in use across the database: Approved 55435, Rejected 1243,
               * Ignore 316, Pending 2. Note "Ignore", singular, while the portal
               * heading reads "Total Ignored Media" -- both spellings are accepted
               * so a later data fix cannot silently zero the figure.
               */
              approvedMedia: { $sum: { $cond: [{ $eq: ['$approvalStatus', 'Approved'] }, 1, 0] } },
              rejectedMedia: { $sum: { $cond: [{ $eq: ['$approvalStatus', 'Rejected'] }, 1, 0] } },
              ignoredMedia: {
                $sum: { $cond: [{ $in: ['$approvalStatus', ['Ignore', 'Ignored']] }, 1, 0] },
              },
            },
          },
        ],
        { label: 'mongo-metrics-photolist-media' }
      );
      rows.forEach((r) => photosByNode.set(r._id, r));
    }

    /* ---- 5b. EXACT photo coverage and the N/A flag, from ProgressStats ----
     *
     * ProgressStats holds one document per photo FIELD per node, with:
     *   status  'Completed' | 'In-Complete' | 'Not Required'  -- app-maintained
     *   n_a     boolean                                        -- the N/A flag
     *   questionId                                             -- the real field id
     *
     * This replaces two long-standing approximations:
     *
     *  1. COVERAGE WAS APPROXIMATE. It counted DISTINCT FieldMedia.questionId,
     *     which holds answer-level GUIDs rather than question ids, so it came out
     *     within a couple of fields of the portal rather than equal to it.
     *     ProgressStats.status is the same per-field flag the portal reads, and
     *     its document count equals photoFields exactly (120/120 on
     *     ARGONNE-CAMPUS, 166/166 on Wadley, 165/165 on Basile).
     *
     *  2. N/A COULD NOT BE EXCLUDED. I previously reported that no N/A flag
     *     existed in any table -- that was wrong. `n_a` is here and populated
     *     (20 on Wadley, 10 on PASS CHRISTIAN, 0 on Basile). Excluding those
     *     fields from the denominator is what the portal's "Total Fields Count"
     *     does, so the percentage stops running low.
     *
     * When a node has no ProgressStats documents the old approximation is kept
     * and photoPctApproximate stays true, so the UI can still say which it is.
     */
    const coverageByNode = new Map();
    {
      const { rows } = await mongo.aggregate(
        'ProgressStats',
        [
          ...unwindToNodes(nodeIds),
          { $match: { isDeleted: { $ne: true } } },
          {
            $group: {
              _id: '$nodeIdList',
              fields: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } },
              naFields: { $sum: { $cond: [{ $eq: ['$n_a', true] }, 1, 0] } },
              notRequired: { $sum: { $cond: [{ $eq: ['$status', 'Not Required'] }, 1, 0] } },
              /*
               * "Total Fields without Media" excludes N/A -- verified on Knolls.
               *
               * An earlier version counted every In-Complete field and reported 128
               * where the portal says 59. Knolls splits In-Complete into 69 with
               * n_a=true and 59 with n_a=false, and the portal counts only the
               * second group. Basile could not have caught this: its n_a is 0, so
               * both readings gave 149.
               */
              incomplete: {
                $sum: {
                  $cond: [
                    { $and: [{ $eq: ['$status', 'In-Complete'] }, { $ne: ['$n_a', true] }] },
                    1,
                    0,
                  ],
                },
              },
              /* Completed and Not Required, N/A excluded, so the three parts sum to
                 the applicable field count: Knolls 59 + 38 + 4 = 101. */
              completedApplicable: {
                $sum: {
                  $cond: [
                    { $and: [{ $eq: ['$status', 'Completed'] }, { $ne: ['$n_a', true] }] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
        { label: 'mongo-metrics-coverage' }
      );
      rows.forEach((r) => coverageByNode.set(r._id, r));
    }

    /* ---- 5c. documents, from S3Document ----
     *
     * Two counts per node: files a person uploaded, and files the app says are
     * required but absent. See config/documents.js for what is excluded and why --
     * 2,686 of Telamon's 3,466 rows are machine-written site-summary JSONs.
     *
     * The required count is 0 across all of Telamon, because no required-document
     * template is configured for it. That is why UPLOADED % and MISSING report
     * null rather than a number.
     */
    const documentsByNode = new Map();
    {
      const { rows } = await mongo.aggregate(
        'S3Document',
        [
          ...unwindToNodes(nodeIds),
          { $match: { isDeleted: { $ne: true } } },
          {
            $group: {
              _id: '$nodeIdList',
              uploaded: { $sum: { $cond: [NOT_A_DOCUMENT_EXPR, 1, 0] } },
              required: { $sum: { $cond: [IS_PLACEHOLDER_EXPR, 1, 0] } },
              lastDocument: { $max: { $cond: [NOT_A_DOCUMENT_EXPR, '$createdAt', null] } },
            },
          },
        ],
        { label: 'mongo-metrics-documents' }
      );
      rows.forEach((r) => documentsByNode.set(r._id, r));
    }

    /* ---- 6. daily reports ----
     *
     * Forms identified by NAME in the definitions, deliberately not via the node's
     * checklist: the DAILY REPORT FORM is frequently absent from it. Alexander City has
     * 23 submissions but a checklist containing only COP-Documents and the tracker, so
     * the checklist route reported 0.
     *
     * ONE FORM PER NODE, chosen per node. A /DAILY REPORT/i sweep summed every variant
     * and overstated most nodes, because a node commonly carries several:
     *
     *   DEFUNIAK SPRINGS   DAILY REPORT FORM 8 · Daily Report form 8 · INTEGRATION 5
     *   PASS CHRISTIAN     DAILY REPORT FORM 16 · INTEGRATION 1
     *
     * The portal reports 8 and 16 -- the exactly-named form alone. Note DEFUNIAK carries
     * two forms differing ONLY in case, each with 8 answer sets, and the portal counts
     * one: case is significant here, however uncomfortable that is.
     *
     * So: prefer forms named exactly 'DAILY REPORT FORM'; if a node has none, fall back
     * to whatever daily-report form it does have. Six Telamon nodes are in that state and
     * would otherwise read 0 while holding real submissions -- VANCLEAVE has 15 on
     * 'Daily Report form', REPUBLIC-SERVICES-HQ 1 on 'Daily Report', two HD nodes use
     * 'DAILY REPORT FORM-360'. Reporting 0 there would be a worse error than the
     * overcount this replaces.
     *
     * Verified against every portal figure supplied: DEFUNIAK 8, PASS CHRISTIAN 16,
     * Basile 13, Wadley 31.
     */
    const DAILY_REPORT_FORM = 'DAILY REPORT FORM';

    const { rows: dailyForms } = await mongo.aggregate(
      'FormBuilderQuestions',
      [
        {
          $match: {
            nodeIdList: { $in: nodeIds },
            formName: { $regex: 'DAILY REPORT', $options: 'i' },
            isDeleted: { $ne: true },
          },
        },
        { $unwind: '$nodeIdList' },
        { $match: { nodeIdList: { $in: nodeIds } } },
        { $project: { _id: 0, nodeId: '$nodeIdList', formId: { $toString: '$_id' }, formName: 1 } },
      ],
      { label: 'mongo-metrics-daily-forms' }
    );

    /* Per node: the exactly-named form's ids, or every daily-report form it has. */
    const dailyFormsByNode = new Map();
    for (const f of dailyForms) {
      if (!dailyFormsByNode.has(f.nodeId)) dailyFormsByNode.set(f.nodeId, { exact: [], other: [] });
      const bucket = dailyFormsByNode.get(f.nodeId);
      if (f.formName === DAILY_REPORT_FORM) bucket.exact.push(f.formId);
      else bucket.other.push(f.formId);
    }
    const chosenByNode = new Map();
    for (const [nodeId, bucket] of dailyFormsByNode) {
      const ids = bucket.exact.length ? bucket.exact : bucket.other;
      if (ids.length) chosenByNode.set(nodeId, new Set(ids));
    }

    const reportsByNode = new Map();
    const allFormIds = [...new Set(dailyForms.map((f) => f.formId))];
    if (allFormIds.length) {
      /*
       * Grouped by node AND form, then filtered in JS against that node's chosen set.
       * A form's nodeIdList can hold several nodes, so a formId chosen for one node is
       * not necessarily chosen for another -- filtering inside the pipeline would have to
       * encode the per-node decision, which is what this avoids.
       */
      const { rows } = await mongo.aggregate(
        'FormBuilderAnswers',
        [
          { $match: { nodeIdList: { $in: nodeIds }, formId: { $in: allFormIds } } },
          { $unwind: '$nodeIdList' },
          { $match: { nodeIdList: { $in: nodeIds }, isDeleted: { $ne: true } } },
          {
            // Per node per form per DAY, so submissions and distinct days both come out.
            $group: {
              _id: {
                nodeId: '$nodeIdList',
                formId: '$formId',
                day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              },
              subs: { $addToSet: '$answerSetId' },
            },
          },
        ],
        { label: 'mongo-metrics-reports' }
      );

      const acc = new Map();
      for (const r of rows) {
        const { nodeId, formId, day } = r._id;
        const chosen = chosenByNode.get(nodeId);
        if (!chosen || !chosen.has(formId)) continue;
        if (!acc.has(nodeId)) {
          acc.set(nodeId, { reports: 0, days: new Set(), first: null, last: null });
        }
        const a = acc.get(nodeId);
        a.reports += (r.subs || []).length;
        if (day) {
          a.days.add(day);
          if (!a.first || day < a.first) a.first = day;
          if (!a.last || day > a.last) a.last = day;
        }
      }
      for (const [nodeId, a] of acc) {
        reportsByNode.set(nodeId, {
          _id: nodeId,
          reports: a.reports,
          reportDays: a.days.size,
          firstDay: a.first,
          lastDay: a.last,
        });
      }
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
      const pm = photosByNode.get(nodeId) || null;
      const d = documentsByNode.get(nodeId) || null;
      const photoFields = Number(f.photoFields) || 0;

      /*
       * Coverage: prefer ProgressStats (exact, app-maintained, N/A-aware) and
       * fall back to the DISTINCT-questionId approximation only when a node has
       * no ProgressStats documents. photoPctApproximate tells the UI which it is,
       * so the caveat under the bar is never shown when the figure is exact.
       */
      const cov = coverageByNode.get(nodeId) || null;
      const exactCoverage = Boolean(cov && Number(cov.fields) > 0);
      const naFields = cov ? Number(cov.naFields) || 0 : 0;
      const notRequiredFields = cov ? Number(cov.notRequired) || 0 : 0;
      const incompleteFields = cov ? Number(cov.incomplete) || 0 : 0;
      const fieldsCovered = exactCoverage
        ? Number(cov.completedApplicable) || 0
        : Number(m.fieldsCovered) || 0;

      /*
       * The portal's "Total Fields Count" EXCLUDES N/A fields.
       *
       * Knolls holds 170 ProgressStats documents, 69 of them N/A, and the portal
       * reports 101 -- which is 170 - 69, and which decomposes exactly into the
       * three states it also reports: 59 without media + 38 completed + 4 not
       * required. So an N/A field is not part of the field count at all, and
       * reporting 170 overstated the work on that node by two thirds.
       */
      const fieldsApplicable = exactCoverage
        ? Math.max(Number(cov.fields) - naFields, 0)
        : photoFields;

      /*
       * Every photo field including N/A -- the portal's "Total Fields Count" plus its
       * "Not Applicable", which is exactly the ProgressStats row count. Falls back to
       * the photolist definition on nodes with no ProgressStats documents.
       */
      const fieldsAll = exactCoverage ? Number(cov.fields) || 0 : photoFields;

      /*
       * Denominator = done + still outstanding, matching the portal's arithmetic.
       *
       * Basile: the portal reports 165 fields and 149 "without media", and
       * 165 - 149 = 16 = Completed (11) + Not Required (5). So a Not Required
       * field is not outstanding work and must not sit in the denominator, for
       * the same reason an N/A field does not. Excluding only N/A left Basile at
       * 11/165 where the portal's own figures imply 11/160.
       */
      const coverageDenominator = exactCoverage
        ? Math.max(Number(cov.fields) - naFields - notRequiredFields, 0)
        : photoFields;

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
        /**
         * Documents a person uploaded. The card's TOTAL DOCUMENTS.
         *
         * Machine-written site-summary JSONs are excluded -- they outnumber real
         * uploads six to one on Telamon.
         */
        documents: d ? Number(d.uploaded) || 0 : 0,
        /**
         * Documents the app says are required but absent. The card's MISSING.
         *
         * 0 across all of Telamon: the required-document feature exists and is used
         * by other companies, but no template is configured here. See
         * config/documents.js -- this is why documentPct is null.
         */
        documentsRequired: d ? Number(d.required) || 0 : 0,
        /**
         * The per-node file allowance -- the portal's "/ 1000".
         *
         * Sent with the figure so a client never has to know the constant, and so a
         * pooled scope can scale it by node count without duplicating the rule.
         */
        documentsLimit: config.documents.fileLimitPerNode,
        documentsPct: documentUsagePct({
          uploaded: d ? d.uploaded : 0,
          limit: config.documents.fileLimitPerNode,
        }),
        lastDocument: d && d.lastDocument ? new Date(d.lastDocument).toISOString().slice(0, 10) : null,

        reports: r ? Number(r.reports) || 0 : 0,
        reportDays: r ? Number(r.reportDays) || 0 : 0,
        lastReport: r ? r.lastDay || null : null,
        missedDays,

        photoFields,
        /**
         * The portal's "Total Fields Count": photo fields excluding N/A.
         *
         * `photoFields` is the raw count from the photolist definition and is kept
         * for the approximate path; this is the figure the portal shows.
         */
        fieldsApplicable,
        photos: pm ? Number(pm.photos) || 0 : 0,
        photosAllMedia: Number(m.photosAll) || 0,
        /**
         * Reviewer decisions, matching the portal's first three headings.
         *
         * Scoped to PHOTOLIST media, the same set as `photos` -- which is the figure
         * the portal calls "Total Media Count" (Basile 122, not the 307 rows across
         * all forms). UNVERIFIED against the portal: both nodes with published
         * figures have zero approvals, so the scoping is inferred from sitting in the
         * same header row rather than confirmed. Wadley would settle it (photolist
         * 686 vs all 1005 media, 440 approved).
         */
        approvedMedia: pm ? Number(pm.approvedMedia) || 0 : 0,
        rejectedMedia: pm ? Number(pm.rejectedMedia) || 0 : 0,
        ignoredMedia: pm ? Number(pm.ignoredMedia) || 0 : 0,
        fieldsCovered,
        /** Fields the app marks N/A. The portal's "Not Applicable". */
        naFields,
        /** Fields the app marks Not Required -- excluded from the denominator. */
        notRequiredFields,
        /** The portal's "Total Fields without Media" -- In-Complete, N/A excluded. */
        incompleteFields,
        coverageDenominator,
        /**
         * PHOTOS UPLOADED -- the client's own formula, given against Eureka:
         *
         *     A = Total Fields Count + Not Applicable   150 + 18 = 168
         *     B = Total Fields without Media                      112
         *     pct = (A - B) / A                          56 / 168 = 33%
         *
         * A is every ProgressStats row for the node, so `fieldsAll` below is simply
         * that raw count -- the portal splits it into "Fields" and "Not Applicable",
         * and adding them back together recovers it.
         *
         * WHAT THE NUMERATOR MEANS: A - B is every field NOT waiting on a photo. It
         * therefore counts an N/A field and a Not Required field as satisfied, which is
         * the point -- nobody has to photograph them. Eureka decomposes as
         * 18 N/A + 34 completed + 4 not required = 56.
         *
         * This replaced completed/(applicable - not required), which read 34/146 = 23%
         * on the same node. That figure answered "how much of the outstanding work has
         * a photo"; this one answers "how much of the photolist needs no further
         * action". Both are defensible; this is the one asked for, and it is the only
         * one now shown, on both tabs.
         */
        fieldsAll,
        fieldsSettled: fieldsAll > 0 ? Math.max(fieldsAll - incompleteFields, 0) : 0,
        coveragePct:
          fieldsAll > 0
            ? Math.min(100, Math.round(((fieldsAll - incompleteFields) / fieldsAll) * 100))
            : null,
        /**
         * MEDIA APPROVED: approved media over total media. The portal's own pair.
         *
         * Upton reproduces exactly: 12 approved of 35 media = 34%.
         *
         * Null rather than 0 when a node has no media at all -- nothing has been
         * submitted, so there is nothing to approve, which is not the same as a
         * reviewer having rejected everything.
         */
        mediaApprovedPct:
          pm && Number(pm.photos) > 0
            ? Math.min(100, Math.round((Number(pm.approvedMedia || 0) / Number(pm.photos)) * 100))
            : null,
        photoPctApproximate: !exactCoverage,
      };
    }

    return { byNode, nodeCount: nodeIds.length, elapsedMs: Date.now() - started };
  });
}

/* ---------------------------------------------------------------------------
 * TELAMON-ILA-TRACKER
 * ------------------------------------------------------------------------- */

/**
 * The node's tracker entries: one row per task, with its milestone and status.
 *
 * This is the client's own milestone definition, so it is the source for both the
 * milestone card and the document table. See config/tracker.js for why, and for
 * the Task ID group mapping.
 *
 * Three collections, in order:
 *   FormBuilderQuestions   the tracker FORM on this node, plus its field labels
 *   FieldResult            the submitted values -- one document per FIELD
 *   answerSetId            groups those fields back into one task row
 *
 * The values live in FieldResult, NOT FormBuilderAnswers. FormBuilderAnswers holds
 * only the submission envelope and has no value column at all, which is why an
 * earlier attempt to read tracker answers from it found nothing.
 *
 * EXPECT EMPTY. The tracker is configured on 63 Telamon nodes and filled in on
 * exactly one -- LUMEN-ILA-SANDBOX. Every production node returns [], and the
 * portal agrees: Basile reads "TELAMON-ILA-TRACKER (0)".
 */
async function getNodeTracker(scope = {}) {
  return cache.wrap('mongo-monitor-node-tracker', scope, async () => {
    const started = Date.now();
    const match = await buildMatch(scope);

    const { rows: scoped } = await mongo.aggregate(
      NODES,
      [{ $match: match }, { $project: { _id: 0, nodeId: 1 } }],
      { label: 'mongo-tracker-scope' }
    );
    const nodeIds = scoped.map((n) => n.nodeId).filter(Boolean);
    if (!nodeIds.length) return { byNode: {}, elapsedMs: Date.now() - started };

    /* ---- 1. the tracker form on each node, and its field labels ---- */
    const { rows: forms } = await mongo.aggregate(
      'FormBuilderQuestions',
      [
        ...unwindToNodes(nodeIds),
        { $match: { formName: TRACKER_FORM_NAME, isDeleted: { $ne: true } } },
        {
          $project: {
            nodeId: '$nodeIdList',
            formId: { $toString: '$_id' },
            fields: {
              $map: {
                input: { $ifNull: ['$list', []] },
                as: 'f',
                in: { id: '$$f.id', label: '$$f.label' },
              },
            },
          },
        },
      ],
      { label: 'mongo-tracker-forms' }
    );
    if (!forms.length) return { byNode: {}, elapsedMs: Date.now() - started };

    const labelByFormField = new Map();
    const formIds = [];
    const nodeByForm = new Map();
    for (const f of forms) {
      formIds.push(f.formId);
      nodeByForm.set(f.formId, f.nodeId);
      for (const fld of f.fields || []) {
        if (fld && fld.id) labelByFormField.set(f.formId + '::' + fld.id, fld.label);
      }
    }

    /* ---- 2. the submitted values ----
     * questionId joins to the LIST element id, NOT its _id: verified on the
     * sandbox, where id matched all 2510 rows and _id matched none. */
    const { rows: values } = await mongo.aggregate(
      'FieldResult',
      [
        { $match: { formId: { $in: formIds }, isDeleted: { $ne: true } } },
        { $project: { _id: 0, formId: 1, answerSetId: 1, questionId: 1, value: 1, createdAt: 1 } },
      ],
      { label: 'mongo-tracker-values' }
    );

    /* ---- 3. regroup fields into task rows ---- */
    const KEY = {
      'Task ID': 'taskId',
      Task: 'task',
      Milestone: 'milestone',
      'Responsible Party': 'responsibleParty',
      'Estimated Complete Date': 'estimatedCompleteDate',
      'Partner Complete Date': 'partnerCompleteDate',
      'Conditional Approved Date': 'conditionalApprovedDate',
      'Final Complete Date': 'finalCompleteDate',
      'Lumen Accept/Reject': 'lumenAcceptReject',
      Notes: 'notes',
    };

    const bySet = new Map();
    for (const v of values) {
      if (v.value === null || v.value === undefined || v.value === '') continue;
      const label = labelByFormField.get(v.formId + '::' + v.questionId);
      const key = KEY[label];
      if (!key) continue;
      if (!bySet.has(v.answerSetId)) {
        bySet.set(v.answerSetId, { answerSetId: v.answerSetId, formId: v.formId, updatedAt: null });
      }
      const row = bySet.get(v.answerSetId);
      row[key] = String(v.value);
      const at = v.createdAt ? new Date(v.createdAt).toISOString().slice(0, 10) : null;
      if (at && (!row.updatedAt || at > row.updatedAt)) row.updatedAt = at;
    }

    const byNode = {};
    for (const row of bySet.values()) {
      const nodeId = nodeByForm.get(row.formId);
      if (!nodeId || !nodeIds.includes(nodeId)) continue;

      const header = isSectionHeader(row);
      const verdict = trackerTaskStatus(row);

      if (!byNode[nodeId]) byNode[nodeId] = [];
      byNode[nodeId].push({
        taskId: row.taskId || null,
        task: row.task || null,
        milestone: milestoneForTask(row),
        /** True when the Milestone column was filled in rather than derived. */
        milestoneExplicit: Boolean(row.milestone),
        responsibleParty: row.responsibleParty || null,
        estimatedCompleteDate: row.estimatedCompleteDate || null,
        partnerCompleteDate: row.partnerCompleteDate || null,
        conditionalApprovedDate: row.conditionalApprovedDate || null,
        finalCompleteDate: row.finalCompleteDate || null,
        lumenAcceptReject: row.lumenAcceptReject || null,
        notes: row.notes || null,
        status: verdict.status,
        statusReason: verdict.reason,
        /** Headings such as ">>> Drawings Completed" -- never counted. */
        isSectionHeader: header,
        answerSetId: row.answerSetId,
      });
    }

    // Task ID order: group then index, numerically.
    const orderKey = (t) => {
      const parts = String(t.taskId || '').split('-');
      return [Number(parts[0]) || 999, Number(parts[1]) || 999];
    };
    for (const list of Object.values(byNode)) {
      list.sort((a, b) => {
        const ka = orderKey(a);
        const kb = orderKey(b);
        return ka[0] - kb[0] || ka[1] - kb[1] || String(a.task).localeCompare(String(b.task));
      });
    }

    return { byNode, elapsedMs: Date.now() - started };
  });
}

/**
 * Milestone rollup from tracker tasks.
 *
 * Section headings are excluded from numerator and denominator alike -- a heading
 * is not work. A milestone with no tasks reports pct null ("--") rather than 0%,
 * for the same reason as elsewhere: no data is not the same as no progress.
 */
function milestonesFromTracker(tasks) {
  const real = (tasks || []).filter((t) => !t.isSectionHeader);
  return TRACKER_MILESTONES.map((ms) => {
    const mine = real.filter((t) => t.milestone === ms.key);
    const done = mine.filter((t) => t.status === 'complete').length;
    const total = mine.length;
    return {
      key: ms.key,
      label: ms.label,
      name: ms.name,
      measurable: total > 0,
      done,
      total,
      pct: total > 0 ? Math.round((done / total) * 100) : null,
      inProgress: mine.filter((t) => t.status === 'inProgress').length,
      rejected: mine.filter((t) => t.status === 'rejected').length,
    };
  });
}

/* ---------------------------------------------------------------------------
 * Shared building blocks for getNodeStages / getNodeChecklist
 * ------------------------------------------------------------------------- */

/** Value of a customTags entry by tagType. The tags are [{tagType, tagValues}]. */
function tagValue(customTags, tagType) {
  if (!Array.isArray(customTags)) return null;
  const hit = customTags.find((t) => t && t.tagType === tagType);
  if (!hit || !Array.isArray(hit.tagValues) || !hit.tagValues.length) return null;
  return hit.tagValues[0] == null ? null : String(hit.tagValues[0]);
}

/**
 * Photo-field counts and last-upload dates per (node, form).
 *
 * One pass used by both getNodeStages and getNodeChecklist, so the two cannot
 * disagree about how many photos a form has.
 */
async function formFactsForNodes(nodeIds) {
  // Photo/document field counts from the form definitions.
  const { rows: defs } = await mongo.aggregate(
    'FormBuilderQuestions',
    [
      ...unwindToNodes(nodeIds),
      { $match: { isDeleted: { $ne: true } } },
      {
        $project: {
          nodeId: '$nodeIdList',
          formId: { $toString: '$_id' },
          formName: 1,
          typeOfForm: 1,
          photoFields: {
            $size: {
              $filter: { input: { $ifNull: ['$list', []] }, as: 'f', cond: { $eq: ['$$f.element', 'Photo'] } },
            },
          },
          docFields: {
            $size: {
              $filter: { input: { $ifNull: ['$list', []] }, as: 'f', cond: { $eq: ['$$f.element', 'File_Upload'] } },
            },
          },
        },
      },
    ],
    { label: 'mongo-form-defs' }
  );

  // Media per (node, form): count, distinct fields touched, last upload.
  const { rows: media } = await mongo.aggregate(
    'FieldMedia',
    [
      ...unwindToNodes(nodeIds),
      { $match: { isDeleted: { $ne: true } } },
      {
        $group: {
          _id: { nodeId: '$nodeIdList', formId: '$formId' },
          photos: { $sum: 1 },
          questionIds: { $addToSet: '$questionId' },
          lastPhoto: { $max: '$createdAt' },
        },
      },
      {
        $project: {
          photos: 1,
          fieldsCovered: { $size: '$questionIds' },
          lastPhoto: { $dateToString: { format: '%Y-%m-%d', date: '$lastPhoto' } },
        },
      },
    ],
    { label: 'mongo-form-media' }
  );

  // Submissions per (node, form), for the non-photolist items.
  const { rows: answers } = await mongo.aggregate(
    'FormBuilderAnswers',
    [
      ...unwindToNodes(nodeIds),
      { $match: { isDeleted: { $ne: true } } },
      {
        $group: {
          _id: { nodeId: '$nodeIdList', formId: '$formId' },
          submissions: { $sum: 1 },
          lastSubmission: { $max: '$createdAt' },
        },
      },
      {
        $project: {
          submissions: 1,
          lastSubmission: { $dateToString: { format: '%Y-%m-%d', date: '$lastSubmission' } },
        },
      },
    ],
    { label: 'mongo-form-answers' }
  );

  const k = (nodeId, formId) => `${nodeId}::${formId}`;
  return {
    defs,
    defByKey: new Map(defs.map((d) => [k(d.nodeId, d.formId), d])),
    mediaByKey: new Map(media.map((m) => [k(m._id.nodeId, m._id.formId), m])),
    answersByKey: new Map(answers.map((a) => [k(a._id.nodeId, a._id.formId), a])),
    key: k,
  };
}

/**
 * Per-stage photo detail for the milestone card.
 *
 * Stages are the node's photolist FORMS, enumerated from FormBuilderQuestions by
 * the node's own keys rather than from the checklist -- the checklist omits forms
 * that still hold data, which is what made Wadley read 161 fields and 530 media
 * where the truth was 166 and 593.
 */
async function getNodeStages(scope = {}) {
  return cache.wrap('mongo-monitor-node-stages', scope, async () => {
    const started = Date.now();
    const match = await buildMatch(scope);

    const { rows: scoped } = await mongo.aggregate(
      NODES,
      [{ $match: match }, { $project: { _id: 0, nodeId: 1 } }],
      { label: 'mongo-stages-scope' }
    );
    const nodeIds = scoped.map((n) => n.nodeId).filter(Boolean);
    if (!nodeIds.length) return { byNode: {}, elapsedMs: Date.now() - started };

    const facts = await formFactsForNodes(nodeIds);

    const byNode = {};
    for (const d of facts.defs) {
      if (d.typeOfForm !== 'photolist') continue;
      const m = facts.mediaByKey.get(facts.key(d.nodeId, d.formId)) || {};
      const photos = Number(m.photos) || 0;

      if (!byNode[d.nodeId]) byNode[d.nodeId] = [];
      byNode[d.nodeId].push({
        stage: d.formName,
        // null when the stage name is not in the M1-M4 mapping (other templates).
        milestone: classifyStage(d.formName),
        photoFields: Number(d.photoFields) || 0,
        photos,
        fieldsCovered: Number(m.fieldsCovered) || 0,
        lastPhoto: m.lastPhoto || null,
        started: photos > 0,
      });
    }

    // Same ordering as the SQL: most photos first, then name.
    for (const list of Object.values(byNode)) {
      list.sort((a, b) => b.photos - a.photos || String(a.stage).localeCompare(String(b.stage)));
    }

    return { byNode, elapsedMs: Date.now() - started };
  });
}

/**
 * The node's CHECKLIST -- what the Site Monitor's table shows.
 *
 * Source is FormGroup.list, the per-node checklist. Each element carries text
 * (the item name), typeOfForm, formId, and customTags with "level 0" (section),
 * "level 1" (stage) and "position".
 *
 * TWO THINGS THIS DOES DIFFERENTLY FROM THE SNOWFLAKE VERSION, both because the
 * source is better here:
 *
 *  - No SCD2 filter is needed. Snowflake keeps three versions per node and
 *    requires DBT_VALID_TO IS NULL to pick the current one; the MongoDB document
 *    IS current. That also removes the staleness: Snowflake's "current" row for
 *    Wadley is eight months old with 14 items where MongoDB has 20.
 *  - Document-level isDeleted is filtered. A deleted checklist should not produce
 *    rows, and MongoDB makes that a one-line $match.
 *
 * The checklist is still not the whole node: forms exist that are absent from it
 * (Wadley's DAILY REPORT FORM among them). Those are unioned in and flagged
 * inChecklist:false rather than dropped, exactly as the SQL version does.
 */
async function getNodeChecklist(scope = {}) {
  return cache.wrap('mongo-monitor-node-checklist', scope, async () => {
    const started = Date.now();
    const match = await buildMatch(scope);

    const { rows: scoped } = await mongo.aggregate(
      NODES,
      [{ $match: match }, { $project: { _id: 0, nodeId: 1 } }],
      { label: 'mongo-checklist-scope' }
    );
    const nodeIds = scoped.map((n) => n.nodeId).filter(Boolean);
    if (!nodeIds.length) return { byNode: {}, elapsedMs: Date.now() - started };

    // The checklist itself. customTags is extracted in JS -- the aggregation
    // equivalent needs a $filter per tag type and is far harder to read.
    const { rows: items } = await mongo.aggregate(
      'FormGroup',
      [
        ...unwindToNodes(nodeIds),
        { $match: { isDeleted: { $ne: true } } },
        { $unwind: '$list' },
        { $match: { 'list.isDeleted': { $ne: true } } },
        {
          $project: {
            _id: 0,
            nodeId: '$nodeIdList',
            sequence: '$list.sequence',
            name: '$list.text',
            kind: '$list.typeOfForm',
            formId: '$list.formId',
            customTags: '$list.customTags',
          },
        },
      ],
      { label: 'mongo-checklist' }
    );

    const facts = await formFactsForNodes(nodeIds);

    const byNode = {};
    const seen = new Set();

    const push = (nodeId, row) => {
      if (!byNode[nodeId]) byNode[nodeId] = [];
      byNode[nodeId].push(row);
    };

    /** Build one row from a form's facts, shared by both branches below. */
    const buildRow = ({ nodeId, name, kind, formId, sequence, section, stage, position, inChecklist }) => {
      const m = facts.mediaByKey.get(facts.key(nodeId, formId)) || {};
      const a = facts.answersByKey.get(facts.key(nodeId, formId)) || {};
      const def = facts.defByKey.get(facts.key(nodeId, formId)) || {};
      const photos = Number(m.photos) || 0;
      const submissions = Number(a.submissions) || 0;

      // Evidence-based: there is no per-item sign-off anywhere, so "done" means
      // photos for a photo list and a submission for a form. Nothing stronger.
      const done = kind === 'photolist' ? photos > 0 : submissions > 0;
      const { status, statusReason } = classifyItemStatus({ name, done, inChecklist });

      return {
        name,
        kind: kind || null,
        status,
        statusReason,
        /*
         * Explicitly null, never undefined: some checklist items have no backing
         * form at all -- "Segment Sweep/PIM" and "System Sweep/PIM" on 10 nodes
         * -- and undefined is dropped by JSON.stringify, so the field would
         * vanish from the payload rather than being reported as absent.
         */
        formId: formId || null,
        sequence: sequence === null || sequence === undefined ? null : Number(sequence),
        position: position || null,
        section: section || null,
        stage: stage || null,
        milestone: classifyStage(stage || name),
        photoFields: Number(def.photoFields) || 0,
        photos,
        lastPhoto: m.lastPhoto || null,
        submissions,
        lastSubmission: a.lastSubmission || null,
        inChecklist,
        done,
      };
    };

    for (const it of items) {
      seen.add(facts.key(it.nodeId, it.formId));
      push(
        it.nodeId,
        buildRow({
          nodeId: it.nodeId,
          name: it.name,
          kind: it.kind,
          formId: it.formId,
          sequence: it.sequence,
          section: tagValue(it.customTags, 'level 0'),
          stage: tagValue(it.customTags, 'level 1'),
          // "position" is the client's own ordering and can differ from sequence
          // (Wadley's Shelter Placement is sequence 6, position 7).
          position: tagValue(it.customTags, 'position'),
          inChecklist: true,
        })
      );
    }

    // Forms present on the node but absent from its checklist.
    for (const d of facts.defs) {
      const k = facts.key(d.nodeId, d.formId);
      if (seen.has(k)) continue;
      if (!nodeIds.includes(d.nodeId)) continue;
      seen.add(k);
      push(
        d.nodeId,
        buildRow({
          nodeId: d.nodeId,
          name: d.formName,
          kind: d.typeOfForm,
          formId: d.formId,
          sequence: null,
          section: null,
          stage: null,
          position: null,
          inChecklist: false,
        })
      );
    }

    // Same ordering as the SQL: checklist items first, then by sequence, then name.
    for (const list of Object.values(byNode)) {
      list.sort(
        (a, b) =>
          Number(b.inChecklist) - Number(a.inChecklist) ||
          (a.sequence ?? 9999) - (b.sequence ?? 9999) ||
          String(a.name).localeCompare(String(b.name))
      );
    }

    return { byNode, elapsedMs: Date.now() - started };
  });
}

/* ---------------------------------------------------------------------------
 * The two endpoint payloads.
 *
 * Pure composition; the assembly lives in monitorComposition.js and this module
 * injects the data functions.
 * ------------------------------------------------------------------------- */

async function getRouteMonitor(scope = {}) {
  return composeRouteMonitor(scope, {
    listRoutes,
    getStatusCounts,
    listNodes,
    getNodeMetrics,
    getNodeTracker,
    milestonesFromTracker,
  });
}

async function getSiteMonitor(scope = {}) {
  return composeSiteMonitor(scope, {
    listNodes,
    getStatusCounts,
    getNodeMetrics,
    getNodeStages,
    getNodeChecklist,
    getNodeTracker,
    milestonesFromTracker,
    companyScopeOf,
  });
}

module.exports = {
  DEFAULT_COMPANY_PATTERN,
  buildMatch,
  companyScopeOf,
  classifyStatus,
  resolveCompanyIds,
  nodesInScope,
  workingDaysBetween,
  tagValue,
  listNodes,
  listRoutes,
  getStatusCounts,
  getHierarchy,
  getNodeMetrics,
  getNodeStages,
  getNodeChecklist,
  getNodeTracker,
  milestonesFromTracker,
  getRouteMonitor,
  getSiteMonitor,
};
