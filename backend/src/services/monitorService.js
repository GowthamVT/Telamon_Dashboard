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
const { MILESTONES, MAPPED_STAGES, MIN_MAPPED_STAGES } = require('../config/milestones');

const NODE = '"ECSITE"."ANALYTICS"."CLOUD_NODE"';
const SITE_HISTORY = '"ECSITE"."ANALYTICS"."CLOUD_SITE_STATUS_HISTORY_WITH_COUNTS"';
const NODE_HISTORY = '"ECSITE"."ANALYTICS"."CLOUD_NODE_STATUS_HISTORY_WITH_COUNTS"';
/** Per-node checklist definition (SCD2 -- always filter DBT_VALID_TO IS NULL). */
const FORMGROUP = '"ECSITE"."ANALYTICS"."CLOUD_FORMGOUP_SS"';
/** Raw uploaded media. Match on NODEIDLIST, not the scalar NODEID -- see getNodeMetrics. */
const FIELD_MEDIA = '"ECSITE"."RAW_HEVO"."CLOUD_ECSITE_FIELDMEDIA"';
/** Form submissions, including the DAILY REPORT FORM. */
const FORM_ANSWERS = '"ECSITE"."RAW_HEVO"."CLOUD_ECSITE_FORMBUILDERANSWERS"';

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
 * Reduce any scope to its COMPANY level only.
 *
 * The hierarchy is Company > Site > Node. The status KPI card is a
 * company-level figure by design: it answers "how do all of Telamon's sites
 * stand?", so drilling into one site must NOT shrink it. Previously the card
 * inherited siteId and collapsed to a single row (0/1/0) while the header still
 * named one route -- two different scopes on one screen, which reads wrong.
 *
 * Dropping siteId/nodeId here keeps the card stable while the rest of the page
 * drills. Note this is a *widening* of scope, so it must never be applied to
 * a per-user RLS predicate: companyId/companyPattern are preserved precisely
 * because those are the tenant boundary.
 */
function companyScopeOf(scope = {}) {
  const { companyId, companyPattern } = scope;
  return {
    ...(companyId ? { companyId } : {}),
    ...(companyPattern ? { companyPattern } : {}),
  };
}

/** Bucket for nodes that exist in CLOUD_NODE but have no status-history row. */
const NO_HISTORY = '(no status history)';

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
  // Work under way.
  'in-progress': 'inProgress',
  'in progress': 'inProgress',
  inprogress: 'inProgress',
  // COP = Certificate of Provisioning. "Sent" means submitted but not yet
  // signed off, so it is still in flight; "approved"/"completed" is the finish
  // line -- CLOUD_NODE carries matching "COP Approved Date"/"COP Completed Date"
  // columns, which is the evidence for treating approval as complete.
  'cop sent': 'inProgress',
  'cop rejected': 'inProgress',
  'cop approved': 'complete',
  'cop completed': 'complete',
  // Not started.
  'yet to start': 'yetToStart',
  yettostart: 'yetToStart',
  inactive: 'yetToStart',
  // A node with no status history has never been worked.
  [NO_HISTORY]: 'yetToStart',
  // Generic spellings, kept so a renamed status still lands somewhere sensible.
  complete: 'complete',
  completed: 'complete',
  closed: 'complete',
};

function classifyStatus(raw) {
  if (!raw) return null;
  return STATUS_MAP[String(raw).trim().toLowerCase()] || null;
}

/**
 * KPI card counts: NODES per status, following the current selection.
 *
 * Source is CLOUD_NODE."Node Status" -- deliberately NOT the status-history
 * views, for three reasons:
 *   - Coverage is complete: all 198 Telamon nodes carry a Node Status, whereas
 *     only 95 have a history row. The history route needed a LEFT JOIN and a
 *     synthetic "no history" bucket for the other 103, which then dominated the
 *     chart.
 *   - It agrees with the table. The rows show each node's "Node Status", so
 *     counting anything else lets the KPI contradict the list beneath it -- on
 *     LUMEN_ILA_SALT_LAKE_CITY_SACRAMENTO the history view called all 16 nodes
 *     "yet to start" while every row read IN PROGRESS.
 *   - No window function needed: this is current state, not a transition log.
 *
 * ("Node Status" is the work state -- IN PROGRESS / YET TO START / COP SENT /
 * COP APPROVED / INACTIVE. Do not confuse it with "Node Current Status", which
 * is the record's lifecycle flag and reads 'Active' for every Telamon node.)
 */
async function getStatusCounts(scope = {}) {
  return cache.wrap('monitor-status-counts', scope, async () => {
    const where = buildScope(scope, { withNode: true });

    const sql = `
      SELECT COALESCE("Node Status", '${NO_HISTORY}') AS status,
             COUNT(*) AS sites,
             -- Company names in scope, so the UI can label the card with a name
             -- rather than echoing back an opaque companyId.
             ARRAY_AGG(DISTINCT "Company Name") AS companies
        FROM ${NODE}
        ${where.sql}
       GROUP BY 1
       ORDER BY sites DESC`;

    const { rows, elapsedMs } = await sf.query(sql, where.binds, {
      label: 'monitor-status-counts',
    });

    const counts = { complete: 0, inProgress: 0, yetToStart: 0 };
    const unmapped = [];
    const companyNames = new Set();

    for (const row of rows) {
      const bucket = classifyStatus(row.STATUS);
      const n = Number(row.SITES) || 0;
      if (bucket) counts[bucket] += n;
      else unmapped.push({ status: row.STATUS, sites: n });

      // Snowflake returns ARRAY_AGG as a JSON string.
      try {
        const names = typeof row.COMPANIES === 'string' ? JSON.parse(row.COMPANIES) : row.COMPANIES;
        for (const name of names || []) if (name) companyNames.add(name);
      } catch {
        /* label is cosmetic -- never fail the KPI over it */
      }
    }

    const names = [...companyNames].sort();
    /**
     * Human label for the card. One company -> its name; several -> the shared
     * prefix ("Telamon") when they agree, else a count. Never the raw id.
     */
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
      // Declared explicitly so the UI can label WHAT the numbers cover, rather
      // than leaving the reader to assume they match the page's heading.
      // Counts follow the selection, so the UI can say what it is showing.
      scopeLevel: scope.nodeId ? 'node' : scope.siteId ? 'site' : 'company',
      grain: 'node',
      scopeLabel: label,
      companies: names,
      // Raw values kept so the mapping above can be checked against reality.
      raw: rows.map((r) => ({ status: r.STATUS, sites: Number(r.SITES) || 0 })),
      unmapped,
      elapsedMs,
    };
  });
}

/**
 * Per-node milestone progress and daily-report counts.
 *
 * Three sources, one query:
 *   CLOUD_FORMGOUP_SS.LIST   the per-node checklist -> which stages exist
 *   CLOUD_ECSITE_FIELDMEDIA  media per stage        -> which stages have started
 *   ...FORMBUILDERANSWERS    submissions of the node's DAILY REPORT FORM
 *
 * Two correctness details, both verified against the data rather than assumed:
 *
 * 1. Media is matched on NODEIDLIST (the array), NOT the scalar NODEID column,
 *    and counts MIME IN ('photo','image'). The scalar is NULL on most rows: for
 *    one node it saw 19 of 86 media rows, reporting "Shelter Placement: 0" when
 *    the true figure was 12. With the array rule, per-stage counts sum to 45 --
 *    exactly matching PHOTOLISTENTRIES in CLOUD_PHOTOCOUNT_PHOTOLIST_AGG.
 *
 * 2. The DAILY REPORT FORM's formId differs per node, so it is read from that
 *    node's own checklist rather than hardcoded.
 */
async function getNodeMetrics(scope = {}) {
  return cache.wrap('monitor-node-metrics', scope, async () => {
    const where = buildScope(scope, { withNode: true });

    // Safe to interpolate: these are validated lowercase-alphanumeric constants
    // from config/milestones.js, never request input. See the guard there.
    const inList = (stages) => stages.map((s) => `'${s}'`).join(', ');
    const milestoneAgg = MILESTONES.filter((m) => m.stages.length > 0)
      .map(
        (m) => `
             COUNT_IF(sm.NORM IN (${inList(m.stages)}))                      AS ${m.key}_total,
             COUNT_IF(sm.NORM IN (${inList(m.stages)}) AND sm.PHOTOS > 0)    AS ${m.key}_done`
      )
      .join(',');

    const sql = `
      WITH scoped AS (
        SELECT "nodeId" AS NODEID FROM ${NODE} ${where.sql}
      ),
      fg AS (
        SELECT nl.value::STRING AS NODEID, f.value AS ITEM
          FROM ${FORMGROUP} g,
               LATERAL FLATTEN(input => g.NODEIDLIST) nl,
               LATERAL FLATTEN(input => g.LIST) f
         WHERE g.DBT_VALID_TO IS NULL                       -- SCD2: current only
           AND NOT COALESCE(f.value:isDeleted::BOOLEAN, FALSE)
      ),
      stages AS (
        SELECT s.NODEID,
               LOWER(REGEXP_REPLACE(fg.ITEM:text::STRING, '[^a-zA-Z0-9]', '')) AS NORM,
               fg.ITEM:formId::STRING AS FORM_ID
          FROM scoped s JOIN fg ON fg.NODEID = s.NODEID
         WHERE fg.ITEM:typeOfForm::STRING = 'photolist'
      ),
      stage_media AS (
        SELECT st.NODEID, st.NORM, COUNT(m._ID) AS PHOTOS
          FROM stages st
          LEFT JOIN ${FIELD_MEDIA} m
                 ON m.FORMID = st.FORM_ID
                AND ARRAY_CONTAINS(st.NODEID::VARIANT, m.NODEIDLIST)
                AND m.MIME IN ('photo', 'image')
                AND NOT COALESCE(m.ISDELETED, FALSE)
                AND NOT COALESCE(m.__HEVO__MARKED_DELETED, FALSE)
         GROUP BY 1, 2
      ),
      milestones AS (
        SELECT sm.NODEID,${milestoneAgg},
               COUNT_IF(sm.NORM IN (${inList(MAPPED_STAGES)}))               AS mapped_total,
               COUNT(*)                                                     AS all_stages,
               SUM(sm.PHOTOS)                                               AS stage_photos
          FROM stage_media sm GROUP BY 1
      ),
      daily_form AS (
        SELECT s.NODEID, fg.ITEM:formId::STRING AS FORM_ID
          FROM scoped s JOIN fg ON fg.NODEID = s.NODEID
         WHERE fg.ITEM:text::STRING ILIKE '%DAILY REPORT%'
      ),
      reports AS (
        SELECT d.NODEID,
               COUNT(DISTINCT a.ANSWERSETID)             AS reports,
               COUNT(DISTINCT TO_DATE(a.CREATEDAT))      AS report_days,
               MAX(TO_VARCHAR(a.CREATEDAT,'YYYY-MM-DD')) AS last_report
          FROM daily_form d
          JOIN ${FORM_ANSWERS} a
                ON a.FORMID = d.FORM_ID AND a.NODEID = d.NODEID
         WHERE NOT COALESCE(a.ISDELETED, FALSE)
         GROUP BY 1
      )
      SELECT s.NODEID,
             COALESCE(ms.mapped_total, 0) AS mapped_total,
             COALESCE(ms.all_stages, 0)   AS all_stages,
             COALESCE(ms.stage_photos, 0) AS stage_photos,
             ${MILESTONES.filter((m) => m.stages.length > 0)
               .map((m) => `COALESCE(ms.${m.key}_total,0) AS ${m.key}_total, COALESCE(ms.${m.key}_done,0) AS ${m.key}_done`)
               .join(', ')},
             COALESCE(r.reports, 0)     AS reports,
             COALESCE(r.report_days, 0) AS report_days,
             r.last_report
        FROM scoped s
        LEFT JOIN milestones ms ON ms.NODEID = s.NODEID
        LEFT JOIN reports    r  ON r.NODEID  = s.NODEID`;

    const { rows, elapsedMs } = await sf.query(sql, where.binds, { label: 'monitor-node-metrics' });

    const byNode = {};
    for (const row of rows) {
      const mappedTotal = Number(row.MAPPED_TOTAL) || 0;
      // A node whose checklist matches no known stage is on a different template
      // (0MH PHOTOS, WBS codes, in-building levels). Its milestones are not
      // measurable, which is different from being at 0%.
      const mapped = mappedTotal >= MIN_MAPPED_STAGES;

      byNode[row.NODEID] = {
        milestonesMapped: mapped,
        mappedStages: mappedTotal,
        totalStages: Number(row.ALL_STAGES) || 0,
        stagePhotos: Number(row.STAGE_PHOTOS) || 0,
        milestones: MILESTONES.map((m) => {
          if (m.stages.length === 0) {
            return { key: m.key, label: m.label, name: m.name, measurable: false, reason: m.unmeasurableReason, pct: null, done: 0, total: 0 };
          }
          const total = Number(row[`${m.key.toUpperCase()}_TOTAL`]) || 0;
          const done = Number(row[`${m.key.toUpperCase()}_DONE`]) || 0;
          return {
            key: m.key,
            label: m.label,
            name: m.name,
            measurable: mapped && total > 0,
            done,
            total,
            pct: mapped && total > 0 ? Math.round((done / total) * 100) : null,
          };
        }),
        reports: Number(row.REPORTS) || 0,
        reportDays: Number(row.REPORT_DAYS) || 0,
        lastReport: row.LAST_REPORT || null,
      };
    }

    return { byNode, nodeCount: rows.length, elapsedMs };
  });
}

/**
 * The Company > Site > Node hierarchy, built from the id keys.
 *
 * One query, nested in JS rather than three round trips: CLOUD_NODE already
 * carries all three levels on every row, so the join is free.
 *
 * "Telamon" is a company *group* -- it resolves to four distinct companyIds
 * (OSP / Outdoor / DAS / Wireline), so the top level is a list, not one entry.
 */
async function getHierarchy(scope = {}) {
  return cache.wrap('monitor-hierarchy', scope, async () => {
    const where = buildScope(scope);
    const sql = `
      SELECT "companyId"    AS company_id,
             "Company Name" AS company_name,
             "siteId"       AS site_id,
             "Site Name"    AS site_name,
             "nodeId"       AS node_id,
             "Node Name"    AS node_name,
             "Site Status"  AS site_status,
             TO_VARCHAR("Node Start Date",'YYYY-MM-DD') AS start_date
        FROM ${NODE}
        ${where.sql}
       ORDER BY "Company Name", "Site Name", "Node Name"`;

    const { rows, elapsedMs } = await sf.query(sql, where.binds, { label: 'monitor-hierarchy' });

    const companies = new Map();
    for (const r of rows) {
      if (!companies.has(r.COMPANY_ID)) {
        companies.set(r.COMPANY_ID, {
          companyId: r.COMPANY_ID,
          companyName: r.COMPANY_NAME,
          sites: new Map(),
        });
      }
      const company = companies.get(r.COMPANY_ID);

      if (!company.sites.has(r.SITE_ID)) {
        company.sites.set(r.SITE_ID, {
          siteId: r.SITE_ID,
          siteName: r.SITE_NAME,
          siteStatus: r.SITE_STATUS,
          nodes: [],
        });
      }
      company.sites.get(r.SITE_ID).nodes.push({
        nodeId: r.NODE_ID,
        nodeName: r.NODE_NAME,
        startDate: r.START_DATE,
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
             "Node Code"                     AS node_code,
             "Site Name"                     AS route_name,
             "Company Name"                  AS company_name,
             -- Work state (IN PROGRESS / YET TO START / COP SENT / COP APPROVED
             -- / INACTIVE) -- this is what the table's STATUS column shows.
             "Node Status"                   AS work_status,
             -- Record lifecycle flag; 'Active' for every Telamon node, so it is
             -- carried for completeness but is not the status users care about.
             "Node Current Status"           AS record_status,
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
        nodeCode: r.NODE_CODE,
        routeName: r.ROUTE_NAME,
        companyName: r.COMPANY_NAME,
        workStatus: r.WORK_STATUS,
        recordStatus: r.RECORD_STATUS,
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

  // Table rows: the nodes in scope, plus their milestone/report metrics. Fetched
  // here rather than by separate client calls so the header, KPI and rows are
  // always the same slice of data.
  const [nodes, metrics] = await Promise.all([listNodes(scope), getNodeMetrics(scope)]);

  return {
    route: selected
      ? { siteId: selected.siteId, name: selected.routeName, companyName: selected.companyName, nodeCount: selected.nodeCount }
      : null,
    routes: routes.routes,
    nodes: nodes.nodes.map((n) => ({ ...n, metrics: metrics.byNode[n.nodeId] || null })),
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
          workStatus: selected.workStatus,
          recordStatus: selected.recordStatus,
        }
      : null,
    nodeCount: nodes.nodes.length,
    statusCounts,
  };
}

module.exports = {
  DEFAULT_COMPANY_PATTERN,
  buildScope,
  companyScopeOf,
  classifyStatus,
  getStatusCounts,
  getHierarchy,
  getNodeMetrics,
  listRoutes,
  listNodes,
  getRouteMonitor,
  getSiteMonitor,
};
