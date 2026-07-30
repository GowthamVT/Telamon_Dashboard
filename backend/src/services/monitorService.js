/**
 * Completion Monitor data service.
 *
 * Sources (verified against the live schema, not assumed):
 *   ECSITE.ANALYTICS.CLOUD_NODE
 *     "companyId" "siteId" "nodeId" (join/RLS keys, case-sensitive quoted)
 *     "Company Name" "Site Name" (= route) "Node Name" (= site) "Node Start Date"
 *   ECSITE.ANALYTICS.CLOUD_SITE_STATUS_HISTORY_WITH_COUNTS
 *     "companyId" "siteId" "Status" "Updated Date" "DATE"  -- SITE grain, no nodeId
 *
 * NOTE ON NAMING: the database's "Site Name" is what the dashboards call the
 * ROUTE, and "Node Name" is what they call the SITE. The mapping is consistent
 * (one Site Name contains many Node Names) but inverted from the UI vocabulary,
 * so every query below is explicit about which is which.
 */
const sf = require('../db/snowflake');
const cache = require('../cache/queryCache');

const NODE = '"ECSITE"."ANALYTICS"."CLOUD_NODE"';
const SITE_HISTORY = '"ECSITE"."ANALYTICS"."CLOUD_SITE_STATUS_HISTORY_WITH_COUNTS"';

/** Default tenant scope until RLS is wired. */
const DEFAULT_COMPANY_PATTERN = '%Telamon%';

/**
 * -------------------------------------------------------------------------
 * THE RLS CHOKEPOINT.
 *
 * Every monitor query builds its WHERE clause here, so a per-user predicate
 * added in this one function is inherited by all of them automatically.
 *
 * Today `companyPattern` defaults to '%Telamon%' -- an explicit, single-tenant
 * scope rather than "no filter", so the unrestricted case never silently
 * becomes the default. When auth lands, derive companyId/siteId/nodeId from the
 * authenticated principal and pass them in; the ILIKE fallback should then be
 * removed so a missing principal fails closed instead of returning everything.
 *
 * All values are bind parameters. `alias` lets the same predicate apply to
 * either table, since both carry the id columns.
 * -------------------------------------------------------------------------
 */
function buildScope({ companyPattern = DEFAULT_COMPANY_PATTERN, companyId, siteId, nodeId } = {}, { withNode = true } = {}) {
  const clauses = [];
  const binds = [];

  if (companyId) {
    clauses.push('"companyId" = ?');
    binds.push(companyId);
  } else if (companyPattern) {
    clauses.push('"Company Name" ILIKE ?');
    binds.push(companyPattern);
  }

  if (siteId) {
    clauses.push('"siteId" = ?');
    binds.push(siteId);
  }
  // The site-history view has no nodeId, so node scoping only applies to CLOUD_NODE.
  if (nodeId && withNode) {
    clauses.push('"nodeId" = ?');
    binds.push(nodeId);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join('\n    AND ')}` : '', binds };
}

/**
 * Status vocabulary translation.
 *
 * The dashboards speak Complete / In Progress / Yet to Start. The warehouse's
 * "Status" column for Telamon only ever holds 'In-progress' and 'Inactive' --
 * there is no value meaning "complete" and none meaning "not started".
 *
 * So this map is a documented assumption, NOT a derivation from the data:
 *   In-progress -> In Progress
 *   Inactive    -> Yet to Start   (best available reading of "not being worked")
 *   (nothing)   -> Complete       (no source; will always report 0)
 *
 * Unmapped values are returned under `unmapped` rather than being dropped, so a
 * new status value shows up as a visible gap instead of quietly vanishing from
 * the totals.
 */
const STATUS_MAP = {
  'in-progress': 'inProgress',
  'in progress': 'inProgress',
  inprogress: 'inProgress',
  inactive: 'yetToStart',
  complete: 'complete',
  completed: 'complete',
  closed: 'complete',
};

function classifyStatus(raw) {
  if (!raw) return null;
  return STATUS_MAP[String(raw).trim().toLowerCase()] || null;
}

/**
 * KPI card counts: sites per status.
 *
 * Uses the LATEST row per siteId, because the table is a status *history* -- a
 * plain COUNT would count every past transition and inflate every bucket.
 */
async function getStatusCounts(scope = {}) {
  return cache.wrap('monitor-status-counts', scope, async () => {
    const where = buildScope(scope, { withNode: false });

    const sql = `
      WITH latest AS (
        SELECT "siteId",
               "Site Name"  AS site_name,
               "Status"      AS status,
               ROW_NUMBER() OVER (
                 PARTITION BY "siteId"
                 ORDER BY COALESCE("Updated Date", "DATE") DESC NULLS LAST
               ) AS rn
          FROM ${SITE_HISTORY}
          ${where.sql}
      )
      SELECT status, COUNT(*) AS sites
        FROM latest
       WHERE rn = 1
       GROUP BY status
       ORDER BY sites DESC`;

    const { rows, elapsedMs } = await sf.query(sql, where.binds, { label: 'monitor-status-counts' });

    const counts = { complete: 0, inProgress: 0, yetToStart: 0 };
    const unmapped = [];

    for (const row of rows) {
      const bucket = classifyStatus(row.STATUS);
      const n = Number(row.SITES) || 0;
      if (bucket) counts[bucket] += n;
      else unmapped.push({ status: row.STATUS, sites: n });
    }

    return {
      ...counts,
      total: counts.complete + counts.inProgress + counts.yetToStart,
      // Raw values kept so the mapping above can be checked against reality.
      raw: rows.map((r) => ({ status: r.STATUS, sites: Number(r.SITES) || 0 })),
      unmapped,
      elapsedMs,
    };
  });
}

/** Routes ("Site Name") available in scope, for the route picker. */
async function listRoutes(scope = {}) {
  return cache.wrap('monitor-routes', scope, async () => {
    const where = buildScope(scope);
    const sql = `
      SELECT "siteId"        AS site_id,
             "Site Name"     AS route_name,
             "Company Name"  AS company_name,
             "companyId"     AS company_id,
             COUNT(DISTINCT "nodeId") AS node_count
        FROM ${NODE}
        ${where.sql}
       GROUP BY 1, 2, 3, 4
       ORDER BY node_count DESC, route_name`;

    const { rows, elapsedMs } = await sf.query(sql, where.binds, { label: 'monitor-routes' });
    return {
      routes: rows.map((r) => ({
        siteId: r.SITE_ID,
        routeName: r.ROUTE_NAME,
        companyName: r.COMPANY_NAME,
        companyId: r.COMPANY_ID,
        nodeCount: Number(r.NODE_COUNT) || 0,
      })),
      elapsedMs,
    };
  });
}

/** Nodes ("Node Name") within scope -- the rows of the Route Monitor table. */
async function listNodes(scope = {}) {
  return cache.wrap('monitor-nodes', scope, async () => {
    const where = buildScope(scope);
    const sql = `
      SELECT "nodeId"                        AS node_id,
             "siteId"                        AS site_id,
             "companyId"                     AS company_id,
             "Node Name"                     AS node_name,
             "Site Name"                     AS route_name,
             "Company Name"                  AS company_name,
             "Node Current Status"           AS node_status,
             "Site Status"                   AS site_status,
             TO_VARCHAR("Node Start Date", 'YYYY-MM-DD') AS start_date
        FROM ${NODE}
        ${where.sql}
       ORDER BY "Node Name"`;

    const { rows, elapsedMs } = await sf.query(sql, where.binds, { label: 'monitor-nodes' });
    return {
      nodes: rows.map((r) => ({
        nodeId: r.NODE_ID,
        siteId: r.SITE_ID,
        companyId: r.COMPANY_ID,
        nodeName: r.NODE_NAME,
        routeName: r.ROUTE_NAME,
        companyName: r.COMPANY_NAME,
        nodeStatus: r.NODE_STATUS,
        siteStatus: r.SITE_STATUS,
        startDate: r.START_DATE,
      })),
      elapsedMs,
    };
  });
}

/**
 * Route Monitor header + KPI card.
 * Title comes from "Site Name" per the agreed mapping.
 */
async function getRouteMonitor(scope = {}) {
  const [routes, statusCounts] = await Promise.all([listRoutes(scope), getStatusCounts(scope)]);

  const selected = scope.siteId
    ? routes.routes.find((r) => r.siteId === scope.siteId)
    : routes.routes[0];

  return {
    route: selected
      ? { siteId: selected.siteId, name: selected.routeName, companyName: selected.companyName, nodeCount: selected.nodeCount }
      : null,
    routes: routes.routes,
    statusCounts,
  };
}

/**
 * Site Monitor header + KPI card.
 * Title comes from "Node Name", the ROUTE card from "Site Name".
 */
async function getSiteMonitor(scope = {}) {
  const [nodes, statusCounts] = await Promise.all([listNodes(scope), getStatusCounts(scope)]);

  const selected = scope.nodeId
    ? nodes.nodes.find((n) => n.nodeId === scope.nodeId)
    : nodes.nodes[0];

  return {
    site: selected
      ? {
          nodeId: selected.nodeId,
          siteId: selected.siteId,
          name: selected.nodeName,
          route: selected.routeName,
          companyName: selected.companyName,
          start: selected.startDate,
          nodeStatus: selected.nodeStatus,
        }
      : null,
    nodeCount: nodes.nodes.length,
    statusCounts,
  };
}

module.exports = {
  DEFAULT_COMPANY_PATTERN,
  buildScope,
  classifyStatus,
  getStatusCounts,
  listRoutes,
  listNodes,
  getRouteMonitor,
  getSiteMonitor,
};
