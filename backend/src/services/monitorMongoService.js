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

module.exports = {
  DEFAULT_COMPANY_PATTERN,
  buildMatch,
  companyScopeOf,
  classifyStatus,
  resolveCompanyIds,
  nodesInScope,
  listNodes,
  listRoutes,
  getStatusCounts,
  getHierarchy,
};
