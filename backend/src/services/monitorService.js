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
const {
  MILESTONES,
  MAPPED_STAGES,
  MIN_MAPPED_STAGES,
  classifyStage,
} = require('../config/milestones');

const NODE = '"ECSITE"."ANALYTICS"."CLOUD_NODE"';
const SITE_HISTORY = '"ECSITE"."ANALYTICS"."CLOUD_SITE_STATUS_HISTORY_WITH_COUNTS"';
const NODE_HISTORY = '"ECSITE"."ANALYTICS"."CLOUD_NODE_STATUS_HISTORY_WITH_COUNTS"';
/** Per-node checklist definition (SCD2 -- always filter DBT_VALID_TO IS NULL). */
const FORMGROUP = '"ECSITE"."ANALYTICS"."CLOUD_FORMGOUP_SS"';
/** Raw uploaded media. Match on NODEIDLIST, not the scalar NODEID -- see getNodeMetrics. */
const FIELD_MEDIA = '"ECSITE"."RAW_HEVO"."CLOUD_ECSITE_FIELDMEDIA"';
/** Form submissions, including the DAILY REPORT FORM. */
const FORM_ANSWERS = '"ECSITE"."RAW_HEVO"."CLOUD_ECSITE_FORMBUILDERANSWERS"';
/** Form definitions; LIST holds the questions (element='Photo' = a photo field). */
const FORM_QUESTIONS = '"ECSITE"."RAW_HEVO"."CLOUD_ECSITE_FORMBUILDERQUESTIONS"';
/**
 * Date dimension. "Day of Week" is ZERO-indexed: 0=Sunday .. 6=Saturday.
 * Verified against DAYNAME() -- an earlier comment here claimed 1=Sunday/7=Saturday
 * and the query filtered NOT IN (1,7), which excluded Mondays and kept every
 * weekend. No holiday flag exists, so public holidays still count as working days.
 */
const CALENDAR = '"ECSITE"."ANALYTICS"."CALENDAR"';
/**
 * Pre-aggregated photo counts per node/day.
 * Use PHOTOLISTENTRIES (photolist media, matches the portal), NOT PHOTOENTRIES
 * which counts all media and overstates -- 803 vs 593 for Wadley.
 */
const PHOTOCOUNT = '"ECSITE"."ANALYTICS"."CLOUD_PHOTOCOUNT_PHOTOLIST_AGG"';

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
           -- Document-level ISDELETED, not just the item's. Without it, a
           -- DELETED checklist still produces milestone bars: Blue Canyon and
           -- Gaffney-Lumen-GBII-ILA-576932 had theirs deleted (2026-05-27 and
           -- 2026-07-06) yet reported 11 and 12 mapped stages. getNodeChecklist
           -- already filtered this, so the two functions disagreed.
           AND NOT COALESCE(g.ISDELETED, FALSE)
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
      /**
       * Denominator: photo FIELDS defined for the node.
       *
       * Forms are enumerated from the QUESTIONS table via its own node keys, NOT
       * from the checklist. The checklist's current SCD2 version omits forms that
       * still hold data: for Wadley it yielded 161 fields and 530 media where the
       * truth is 166 and 593. Same root cause as the daily-report bug.
       *
       * element='Photo' excludes 'Section_Header' rows, which are layout not
       * fields. Verified exact against the portal on three nodes, where
       * portal Total Fields + Not Applicable equals this count:
       *   Basile 165+0, PASS CHRISTIAN 154+11, Wadley 141+25.
       */
      photo_fields AS (
        SELECT s.NODEID,
               COUNT_IF(qi.value:element::STRING = 'Photo') AS photo_fields
          FROM scoped s
          JOIN ${FORM_QUESTIONS} q
                ON (q.NODEID = s.NODEID OR ARRAY_CONTAINS(s.NODEID::VARIANT, q.NODEIDLIST))
               AND q.TYPEOFFORM = 'photolist'
               AND NOT COALESCE(q.ISDELETED, FALSE),
               LATERAL FLATTEN(input => q.LIST) qi
         GROUP BY 1
      ),
      /**
       * Numerator. Media is matched by node only -- no form restriction -- for the
       * same reason: filtering to checklist forms dropped 63 of Wadley's 593.
       *
       * photos_all counts every media row; the headline photo figure comes from
       * the pre-aggregated PHOTOLISTENTRIES below, verified exact on three nodes.
       * fields_covered counts DISTINCT QUESTIONID and remains approximate.
       */
      photo_media AS (
        SELECT s.NODEID,
               COUNT(m._ID)                 AS photos_all,
               COUNT(DISTINCT m.QUESTIONID) AS fields_covered
          FROM scoped s
          JOIN ${FIELD_MEDIA} m
                ON ARRAY_CONTAINS(s.NODEID::VARIANT, m.NODEIDLIST)
               AND NOT COALESCE(m.ISDELETED, FALSE)
               AND NOT COALESCE(m.__HEVO__MARKED_DELETED, FALSE)
         GROUP BY 1
      ),
      -- Photolist media count, pre-aggregated. Matches the portal's
      -- "Total Media Count" exactly (Basile 122, PASS CHRISTIAN 554, Wadley 593).
      -- NOTE: PHOTOENTRIES on the same table counts ALL media and overstates.
      photo_agg AS (
        SELECT s.NODEID, SUM(a.PHOTOLISTENTRIES) AS photos
          FROM scoped s
          JOIN ${PHOTOCOUNT} a ON a.NODEID = s.NODEID
         GROUP BY 1
      ),
      /**
       * Daily-report forms, identified by FORM NAME in the form definitions.
       *
       * Deliberately NOT looked up via the node's checklist: the DAILY REPORT
       * FORM frequently is not listed there. Alexander City has 19 submissions
       * but its checklist contains only COP-Documents and TELAMON-ILA-TRACKER,
       * so the checklist route reported 0 while the portal showed 20.
       *
       * This also catches variants such as "INTEGRATION DAILY REPORT FORM-360".
       */
      daily_forms AS (
        SELECT DISTINCT q._ID AS FORM_ID
          FROM ${FORM_QUESTIONS} q
         WHERE q.FORMNAME ILIKE '%DAILY REPORT%'
           AND NOT COALESCE(q.ISDELETED, FALSE)
      ),
      report_days AS (
        SELECT s.NODEID, TO_DATE(a.CREATEDAT) AS rpt_day, COUNT(DISTINCT a.ANSWERSETID) AS subs
          FROM scoped s
          JOIN ${FORM_ANSWERS} a ON a.NODEID = s.NODEID
          JOIN daily_forms d     ON d.FORM_ID = a.FORMID
         WHERE NOT COALESCE(a.ISDELETED, FALSE)
         GROUP BY 1, 2
      ),
      reports AS (
        SELECT NODEID,
               SUM(subs)                        AS reports,
               COUNT(*)                         AS report_days,
               MIN(rpt_day)                     AS first_day,
               MAX(rpt_day)                     AS last_day,
               TO_VARCHAR(MAX(rpt_day),'YYYY-MM-DD') AS last_report
          FROM report_days GROUP BY 1
      ),
      -- Missed days = working days inside the OBSERVED reporting window minus the
      -- days actually reported.
      --
      -- Measured from first-to-last submission rather than from the node start
      -- date: reporting on these routes began ~2026-05-28 while nodes started
      -- 2025-11-18, so counting from node start returns ~200 for every node and
      -- measures the pre-reporting era rather than missed work.
      --
      -- Weekends excluded via CALENDAR."Day of Week", which is ZERO-indexed:
      -- 0=Sunday, 6=Saturday. This previously read NOT IN (1,7) on the assumption
      -- of 1=Sunday/7=Saturday; since 7 does not exist that excluded MONDAYS and
      -- counted every Saturday and Sunday as a working day, overstating missed
      -- days by roughly a third (Wadley: 47 working days instead of 40, so 21
      -- missed instead of 14). CALENDAR has no holiday flag, so public holidays
      -- still count as missed.
      working_days AS (
        SELECT r.NODEID, COUNT(*) AS work_days
          FROM reports r
          JOIN ${CALENDAR} c
                ON c."Date" BETWEEN r.first_day AND r.last_day
               AND c."Day of Week" NOT IN (0, 6)   -- 0=Sun, 6=Sat
         GROUP BY 1
      )
      SELECT s.NODEID,
             COALESCE(ms.mapped_total, 0) AS mapped_total,
             COALESCE(ms.all_stages, 0)   AS all_stages,
             COALESCE(ms.stage_photos, 0) AS stage_photos,
             ${MILESTONES.filter((m) => m.stages.length > 0)
               .map((m) => `COALESCE(ms.${m.key}_total,0) AS ${m.key}_total, COALESCE(ms.${m.key}_done,0) AS ${m.key}_done`)
               .join(', ')},
             COALESCE(pf.photo_fields, 0)   AS photo_fields,
             COALESCE(pa.photos, 0)         AS photos,
             COALESCE(pm.photos_all, 0)     AS photos_all,
             COALESCE(pm.fields_covered, 0) AS fields_covered,
             COALESCE(r.reports, 0)     AS reports,
             COALESCE(r.report_days, 0) AS report_days,
             r.last_report,
             -- NULL when the node never reported: there is no window to measure,
             -- which is different from having missed zero days.
             CASE WHEN r.report_days IS NULL THEN NULL
                  ELSE GREATEST(COALESCE(wd.work_days, 0) - r.report_days, 0) END AS missed_days
        FROM scoped s
        LEFT JOIN milestones   ms ON ms.NODEID = s.NODEID
        LEFT JOIN photo_fields pf ON pf.NODEID = s.NODEID
        LEFT JOIN photo_media  pm ON pm.NODEID = s.NODEID
        LEFT JOIN photo_agg    pa ON pa.NODEID = s.NODEID
        LEFT JOIN reports      r  ON r.NODEID  = s.NODEID
        LEFT JOIN working_days wd ON wd.NODEID = s.NODEID`;

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
        // NULL (not 0) when the node has never reported -- nothing to measure.
        missedDays: row.MISSED_DAYS === null || row.MISSED_DAYS === undefined
          ? null
          : Number(row.MISSED_DAYS),

        /**
         * Photo progress = fields covered / photo fields defined.
         *
         * NOT photos/fields: a field accepts many photos, so that ratio exceeds
         * 100% (PASS CHRISTIAN uploads 554 photos across 154 fields = 360%).
         *
         * photoFields and photos are both VERIFIED EXACT against the portal on
         * three nodes (Basile 165/122, PASS CHRISTIAN 165/554, Wadley 166/593).
         *
         * fieldsCovered counts DISTINCT media QUESTIONID and is APPROXIMATE --
         * 105 vs the portal's 103 on Wadley, 108 vs 109 on PASS CHRISTIAN. The
         * exact field<->media link is not reproducible: media.QUESTIONID holds
         * answer-level GUIDs that do not match question _ids. So the percentage
         * is indicative; the two exact counts are exposed alongside it.
         *
         * The percentage also runs LOW because the denominator cannot exclude
         * N/A fields (25 on Wadley, 11 on PASS CHRISTIAN) -- no N/A flag has been
         * found in any table.
         */
        photoFields: Number(row.PHOTO_FIELDS) || 0,
        photos: Number(row.PHOTOS) || 0,
        photosAllMedia: Number(row.PHOTOS_ALL) || 0,
        fieldsCovered: Number(row.FIELDS_COVERED) || 0,
        photoPct:
          Number(row.PHOTO_FIELDS) > 0
            ? Math.min(100, Math.round((Number(row.FIELDS_COVERED) / Number(row.PHOTO_FIELDS)) * 100))
            : null,
        photoPctApproximate: true,
      };
    }

    return { byNode, nodeCount: rows.length, elapsedMs };
  });
}

/**
 * Per-stage detail for the Site Monitor, with each stage's milestone assignment.
 *
 * Separate from getNodeMetrics() on purpose: the Site Monitor shows ONE node and
 * wants stage-level rows, whereas the Route Monitor shows many nodes and only
 * needs the rolled-up percentages. Keeping them apart means this cannot change
 * anything the Route Monitor renders.
 *
 * Forms are read from the QUESTIONS table via its own node keys, not the
 * checklist -- the checklist's current version omits forms that still hold data
 * (it cost Wadley 5 fields and 63 photos).
 */
async function getNodeStages(scope = {}) {
  return cache.wrap('monitor-node-stages', scope, async () => {
    const where = buildScope(scope, { withNode: true });

    const sql = `
      WITH scoped AS (
        SELECT "nodeId" AS NODEID FROM ${NODE} ${where.sql}
      ),
      stage_forms AS (
        SELECT s.NODEID, q._ID AS FORM_ID, q.FORMNAME AS stage_name
          FROM scoped s
          JOIN ${FORM_QUESTIONS} q
                ON (q.NODEID = s.NODEID OR ARRAY_CONTAINS(s.NODEID::VARIANT, q.NODEIDLIST))
               AND q.TYPEOFFORM = 'photolist'
               AND NOT COALESCE(q.ISDELETED, FALSE)
      ),
      fields AS (
        SELECT sf.NODEID, sf.FORM_ID, sf.stage_name,
               COUNT_IF(qi.value:element::STRING = 'Photo') AS photo_fields
          FROM stage_forms sf
          JOIN ${FORM_QUESTIONS} q ON q._ID = sf.FORM_ID,
               LATERAL FLATTEN(input => q.LIST) qi
         GROUP BY 1, 2, 3
      ),
      media AS (
        SELECT sf.NODEID, sf.FORM_ID,
               COUNT(m._ID)                          AS photos,
               COUNT(DISTINCT m.QUESTIONID)          AS fields_covered,
               TO_VARCHAR(MAX(TO_DATE(m.CREATEDAT)), 'YYYY-MM-DD') AS last_photo
          FROM stage_forms sf
          LEFT JOIN ${FIELD_MEDIA} m
                 ON m.FORMID = sf.FORM_ID
                AND ARRAY_CONTAINS(sf.NODEID::VARIANT, m.NODEIDLIST)
                AND NOT COALESCE(m.ISDELETED, FALSE)
                AND NOT COALESCE(m.__HEVO__MARKED_DELETED, FALSE)
         GROUP BY 1, 2
      )
      SELECT f.NODEID, f.stage_name, f.photo_fields,
             COALESCE(md.photos, 0)         AS photos,
             COALESCE(md.fields_covered, 0) AS fields_covered,
             md.last_photo
        FROM fields f
        LEFT JOIN media md ON md.NODEID = f.NODEID AND md.FORM_ID = f.FORM_ID
       ORDER BY f.NODEID, COALESCE(md.photos, 0) DESC, f.stage_name`;

    const { rows, elapsedMs } = await sf.query(sql, where.binds, { label: 'monitor-node-stages' });

    const byNode = {};
    for (const row of rows) {
      if (!byNode[row.NODEID]) byNode[row.NODEID] = [];
      byNode[row.NODEID].push({
        stage: row.STAGE_NAME,
        // null when the stage name is not in the M1-M4 mapping (other templates).
        milestone: classifyStage(row.STAGE_NAME),
        photoFields: Number(row.PHOTO_FIELDS) || 0,
        photos: Number(row.PHOTOS) || 0,
        fieldsCovered: Number(row.FIELDS_COVERED) || 0,
        lastPhoto: row.LAST_PHOTO || null,
        started: (Number(row.PHOTOS) || 0) > 0,
      });
    }

    return { byNode, elapsedMs };
  });
}

/**
 * Items the checklist itself marks as conditional. This is the client's own
 * wording -- "Fencing & Gates - if applicable", "Utility Construction (If
 * Required)" -- so it is read from real data, not invented.
 */
const OPTIONAL_ITEM = /\b(if\s+applicable|if\s+required|optional)\b/i;

/**
 * Collapse a checklist item to the three statuses the dashboard reports:
 * Complete / Missing / N/A.
 *
 * IMPORTANT CAVEAT: there is no N/A flag anywhere in the warehouse. We looked
 * for one and it does not exist -- not on the checklist element, not on the form
 * definition, not on the media rows. So N/A here is INFERRED from two signals,
 * both defensible but neither authoritative:
 *
 *   1. The item is not part of this node's checklist at all. It was found on the
 *      node as a form but was never required of the crew, so "missing" would be
 *      a false accusation.
 *   2. The item's own name marks it conditional ("if applicable", "If
 *      Required"). The crew is not expected to complete it unless the site calls
 *      for it, so counting it as missing overstates the gap.
 *
 * An item with evidence is Complete regardless of either signal -- work that was
 * actually done is never reported as not-applicable.
 *
 * TODO(source): if the portal exposes a real per-item N/A flag, replace both
 * inferences with it and delete OPTIONAL_ITEM. Until then the UI labels these as
 * inferred so nobody reads them as the client's own sign-off.
 */
function classifyItemStatus({ name, done, inChecklist }) {
  if (done) return { status: 'complete', statusReason: null };
  if (!inChecklist) {
    return { status: 'na', statusReason: 'not required by this node’s checklist' };
  }
  if (OPTIONAL_ITEM.test(name || '')) {
    return { status: 'na', statusReason: 'the checklist marks this item conditional' };
  }
  return { status: 'missing', statusReason: null };
}

/**
 * The node's CHECKLIST -- what the Site Monitor's table is meant to show.
 *
 * Source is CLOUD_FORMGOUP_SS.LIST, the per-node checklist definition. Each
 * element is one required item, carrying:
 *   text        -> the item name shown to the crew ("Permitting", "COP-Documents")
 *   typeOfForm  -> photolist | ondemand | installTracker (drives how it completes)
 *   formId      -> joins to FORMBUILDERQUESTIONS._ID, FIELDMEDIA.FORMID, ANSWERS.FORMID
 *   customTags  -> "level 0" (e.g. COP MEDIA), "level 1" (the stage), "position"
 *
 * SCD2: three versions exist per node with LIST lengths 14/15/18, so
 * DBT_VALID_TO IS NULL is mandatory or items appear two or three times.
 *
 * customTags must be flattened as a SECOND lateral, not a correlated subquery --
 * Snowflake rejects a correlated LATERAL FLATTEN ("Unsupported subquery type").
 * OUTER => TRUE keeps the untagged items (COP-Documents, the tracker), which
 * would otherwise vanish from the checklist entirely.
 *
 * The checklist is NOT the full picture: Wadley's has 14 items but the node also
 * carries a Concrete Foundation photolist and a DAILY REPORT FORM that are absent
 * from it -- the same omission that made daily reports read 0 before. So forms
 * that exist on the node but are missing from the checklist are unioned in and
 * flagged `inChecklist: false`, rather than being silently dropped.
 *
 * Kept separate from getNodeStages so the milestone card keeps its validated
 * numbers and the Route Monitor's code path is untouched.
 */
async function getNodeChecklist(scope = {}) {
  return cache.wrap('monitor-node-checklist', scope, async () => {
    const where = buildScope(scope, { withNode: true });
    const sql = `
      WITH scoped AS (
        SELECT "nodeId" AS NODEID FROM ${NODE} ${where.sql}
      ),
      checklist AS (
        SELECT s.NODEID,
               li.value:sequence::NUMBER AS SEQ,
               li.value:text::STRING AS ITEM_NAME,
               li.value:typeOfForm::STRING AS TYPE_OF_FORM,
               li.value:formId::STRING AS FORM_ID,
               MAX(IFF(ct.value:tagType::STRING = 'level 0',
                       ct.value:tagValues[0]::STRING, NULL)) AS LEVEL_0,
               MAX(IFF(ct.value:tagType::STRING = 'level 1',
                       ct.value:tagValues[0]::STRING, NULL)) AS LEVEL_1,
               MAX(IFF(ct.value:tagType::STRING = 'position',
                       ct.value:tagValues[0]::STRING, NULL)) AS POSITION
          FROM scoped s
          JOIN ${FORMGROUP} fg
                ON ARRAY_CONTAINS(s.NODEID::VARIANT, fg.NODEIDLIST)
               AND fg.DBT_VALID_TO IS NULL
               AND NOT COALESCE(fg.ISDELETED, FALSE),
               LATERAL FLATTEN(input => fg.LIST) li,
               LATERAL FLATTEN(input => li.value:customTags, OUTER => TRUE) ct
         WHERE NOT COALESCE(li.value:isDeleted::BOOLEAN, FALSE)
         GROUP BY 1, 2, 3, 4, 5
      ),
      /* Forms present on the node but absent from its checklist. */
      extra AS (
        SELECT s.NODEID, NULL AS SEQ, q.FORMNAME AS ITEM_NAME,
               q.TYPEOFFORM AS TYPE_OF_FORM, q._ID AS FORM_ID,
               NULL AS LEVEL_0, NULL AS LEVEL_1, NULL AS POSITION
          FROM scoped s
          JOIN ${FORM_QUESTIONS} q
                ON (q.NODEID = s.NODEID OR ARRAY_CONTAINS(s.NODEID::VARIANT, q.NODEIDLIST))
               AND NOT COALESCE(q.ISDELETED, FALSE)
          LEFT JOIN checklist c ON c.NODEID = s.NODEID AND c.FORM_ID = q._ID
         WHERE c.FORM_ID IS NULL
      ),
      items AS (
        SELECT *, TRUE AS IN_CHECKLIST FROM checklist
        UNION ALL
        SELECT *, FALSE AS IN_CHECKLIST FROM extra
      ),
      /* How many photo fields the form defines (element='Photo' in its LIST). */
      fields AS (
        SELECT i.NODEID, i.FORM_ID,
               COUNT_IF(qi.value:element::STRING = 'Photo') AS PHOTO_FIELDS
          FROM items i
          JOIN ${FORM_QUESTIONS} q ON q._ID = i.FORM_ID,
               LATERAL FLATTEN(input => q.LIST) qi
         GROUP BY 1, 2
      ),
      /* Photos. Match the node on NODEIDLIST -- the scalar NODEID is mostly NULL. */
      media AS (
        SELECT i.NODEID, i.FORM_ID,
               COUNT(m._ID) AS PHOTOS,
               TO_VARCHAR(MAX(TO_DATE(m.CREATEDAT)), 'YYYY-MM-DD') AS LAST_PHOTO
          FROM items i
          JOIN ${FIELD_MEDIA} m
                ON m.FORMID = i.FORM_ID
               AND ARRAY_CONTAINS(i.NODEID::VARIANT, m.NODEIDLIST)
               AND NOT COALESCE(m.ISDELETED, FALSE)
               AND NOT COALESCE(m.__HEVO__MARKED_DELETED, FALSE)
         GROUP BY 1, 2
      ),
      /* Submissions, for the ondemand / installTracker items. */
      answers AS (
        SELECT i.NODEID, i.FORM_ID,
               COUNT(a._ID) AS SUBMISSIONS,
               TO_VARCHAR(MAX(TO_DATE(a.CREATEDAT)), 'YYYY-MM-DD') AS LAST_SUBMISSION
          FROM items i
          JOIN ${FORM_ANSWERS} a
                ON a.FORMID = i.FORM_ID
               AND ARRAY_CONTAINS(i.NODEID::VARIANT, a.NODEIDLIST)
               AND NOT COALESCE(a.ISDELETED, FALSE)
               AND NOT COALESCE(a.__HEVO__MARKED_DELETED, FALSE)
         GROUP BY 1, 2
      )
      SELECT i.NODEID, i.SEQ, i.ITEM_NAME, i.TYPE_OF_FORM, i.FORM_ID,
             i.LEVEL_0, i.LEVEL_1, i.POSITION, i.IN_CHECKLIST,
             COALESCE(f.PHOTO_FIELDS, 0) AS PHOTO_FIELDS,
             COALESCE(md.PHOTOS, 0) AS PHOTOS,
             md.LAST_PHOTO,
             COALESCE(an.SUBMISSIONS, 0) AS SUBMISSIONS,
             an.LAST_SUBMISSION
        FROM items i
        LEFT JOIN fields f ON f.NODEID = i.NODEID AND f.FORM_ID = i.FORM_ID
        LEFT JOIN media md ON md.NODEID = i.NODEID AND md.FORM_ID = i.FORM_ID
        LEFT JOIN answers an ON an.NODEID = i.NODEID AND an.FORM_ID = i.FORM_ID
       ORDER BY i.NODEID, i.IN_CHECKLIST DESC, i.SEQ NULLS LAST, i.ITEM_NAME`;

    const { rows, elapsedMs } = await sf.query(sql, where.binds, {
      label: 'monitor-node-checklist',
    });

    const byNode = {};
    for (const row of rows) {
      if (!byNode[row.NODEID]) byNode[row.NODEID] = [];
      const kind = row.TYPE_OF_FORM || null;
      const photos = Number(row.PHOTOS) || 0;
      const submissions = Number(row.SUBMISSIONS) || 0;
      const inChecklist = row.IN_CHECKLIST === true || row.IN_CHECKLIST === 'true';

      /*
       * Completion signal depends on the item type. There is no sign-off column
       * anywhere, so "done" means evidence exists -- photos for a photolist,
       * submissions for a form -- and nothing stronger is claimed.
       */
      const done = kind === 'photolist' ? photos > 0 : submissions > 0;
      const { status, statusReason } = classifyItemStatus({
        name: row.ITEM_NAME,
        done,
        inChecklist,
      });

      byNode[row.NODEID].push({
        name: row.ITEM_NAME,
        kind,
        status,
        statusReason,
        formId: row.FORM_ID,
        sequence: row.SEQ === null || row.SEQ === undefined ? null : Number(row.SEQ),
        // "position" is the client's own ordering and can differ from sequence
        // (Wadley's Shelter Placement is sequence 6, position 7).
        position: row.POSITION || null,
        section: row.LEVEL_0 || null,
        stage: row.LEVEL_1 || null,
        // Classify from the level-1 tag, falling back to the item name.
        milestone: classifyStage(row.LEVEL_1 || row.ITEM_NAME),
        photoFields: Number(row.PHOTO_FIELDS) || 0,
        photos,
        lastPhoto: row.LAST_PHOTO || null,
        submissions,
        lastSubmission: row.LAST_SUBMISSION || null,
        inChecklist,
        done,
      });
    }

    return { byNode, elapsedMs };
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

  /*
   * AGGREGATE vs SINGLE ROUTE.
   *
   * Without a siteId the scope spans every route, so there is no single route to
   * name. Falling back to routes[0] used to put an arbitrary route's name in the
   * header while the picker said "All sites" -- two different claims on one
   * screen. `name` is therefore null when aggregate, so no code path can display
   * one route's name as if it described the whole selection.
   */
  const aggregate = !scope.siteId;
  const selected = aggregate
    ? routes.routes[0]
    : routes.routes.find((r) => r.siteId === scope.siteId);

  // Table rows: the nodes in scope, plus their milestone/report metrics. Fetched
  // here rather than by separate client calls so the header, KPI and rows are
  // always the same slice of data.
  const [nodes, metrics] = await Promise.all([listNodes(scope), getNodeMetrics(scope)]);

  // Distinct companies actually in scope -- "All Telamon (4)" spans four.
  const companies = new Set(nodes.nodes.map((n) => n.companyName).filter(Boolean));

  return {
    route: selected
      ? {
          siteId: aggregate ? null : selected.siteId,
          name: aggregate ? null : selected.routeName,
          aggregate,
          routeCount: routes.routes.length,
          // Counted from the rows in scope, so the header agrees with the table.
          nodeCount: aggregate ? nodes.nodes.length : selected.nodeCount,
          companyName: companies.size === 1 ? [...companies][0] : null,
          companyCount: companies.size,
        }
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

  /*
   * AGGREGATE vs SINGLE NODE -- same reasoning as getRouteMonitor.
   *
   * The Site Monitor is a node-level view, so the cards below the header always
   * describe ONE node. When no node is picked we still show the first one (that
   * is the existing behaviour), but `name` is null so the header cannot claim to
   * BE that node; `detailName` names it explicitly instead, and the UI attributes
   * the cards to it.
   */
  const aggregate = !scope.nodeId;
  const selected = aggregate
    ? nodes.nodes[0]
    : nodes.nodes.find((n) => n.nodeId === scope.nodeId);

  /**
   * Milestone and stage detail for the ONE node on display.
   *
   * Re-scoped to that node rather than reusing the incoming scope: without a
   * nodeId the scope could span a whole company, and computing stage rows for
   * 200 nodes to render one would be wasteful.
   */
  const routeNames = new Set(nodes.nodes.map((n) => n.routeName).filter(Boolean));
  /*
   * Count sites by siteId, not by route NAME: two sites share the name
   * LUMEN-ILA-LOUISVILLE_NASHVILLE, so counting names gives 61 where the picker
   * says 62 and the two figures contradict each other on screen.
   */
  const siteIds = new Set(nodes.nodes.map((n) => n.siteId).filter(Boolean));
  const companies = new Set(nodes.nodes.map((n) => n.companyName).filter(Boolean));

  let metrics = null;
  let stages = null;
  let checklist = null;
  if (selected) {
    const nodeScope = { ...companyScopeOf(scope), nodeId: selected.nodeId };
    const [m, s, c] = await Promise.all([
      getNodeMetrics(nodeScope),
      getNodeStages(nodeScope),
      getNodeChecklist(nodeScope),
    ]);
    metrics = m.byNode[selected.nodeId] || null;
    stages = s.byNode[selected.nodeId] || [];
    checklist = c.byNode[selected.nodeId] || [];
  }

  return {
    site: selected
      ? {
          nodeId: selected.nodeId,
          siteId: selected.siteId,
          name: aggregate ? null : selected.nodeName,
          /** The node the detail cards describe -- set even when aggregating. */
          detailName: selected.nodeName,
          aggregate,
          // Null when the scope spans more than one route, so the ROUTE card
          // never names one route while showing many.
          route: aggregate && routeNames.size > 1 ? null : selected.routeName,
          routeCount: siteIds.size,
          companyName: companies.size === 1 ? [...companies][0] : null,
          companyCount: companies.size,
          start: selected.startDate,
          workStatus: selected.workStatus,
          recordStatus: selected.recordStatus,
        }
      : null,
    nodeCount: nodes.nodes.length,
    statusCounts,
    metrics,
    stages,
    checklist,
    /** Milestone definitions, so the UI can label bars without duplicating config. */
    milestoneDefs: MILESTONES.map((m) => ({
      key: m.key,
      label: m.label,
      name: m.name,
      stageCount: m.stages.length,
      unmeasurable: m.unmeasurable === true,
      reason: m.unmeasurableReason || null,
    })),
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
  getNodeStages,
  getNodeChecklist,
  listRoutes,
  listNodes,
  getRouteMonitor,
  getSiteMonitor,
};
