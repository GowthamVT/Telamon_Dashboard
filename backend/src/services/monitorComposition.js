/**
 * Shared composition for the two monitor endpoints.
 *
 * getRouteMonitor and getSiteMonitor do not query anything themselves -- they
 * assemble what the per-query functions return, decide whether the selection is
 * aggregate, and shape the header.
 *
 * Kept separate from the data layer so the header logic is testable on its own
 * and has exactly one definition. The aggregate/`name: null` handling in
 * particular was a bug fix -- without it the header named an arbitrary route
 * while the picker said "All sites" -- and it should never exist in two places.
 */
const { MILESTONES } = require('../config/milestones');

/**
 * Route Monitor payload.
 *
 * @param {object} scope
 * @param {object} deps  listRoutes, getStatusCounts, listNodes, getNodeMetrics
 */
async function composeRouteMonitor(scope, deps) {
  const [routes, statusCounts] = await Promise.all([
    deps.listRoutes(scope),
    deps.getStatusCounts(scope),
  ]);

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
  const [nodes, metrics] = await Promise.all([deps.listNodes(scope), deps.getNodeMetrics(scope)]);

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
 * Site Monitor payload.
 *
 * @param {object} scope
 * @param {object} deps  listNodes, getStatusCounts, getNodeMetrics,
 *                       getNodeStages, getNodeChecklist, companyScopeOf
 */
async function composeSiteMonitor(scope, deps) {
  const [nodes, statusCounts] = await Promise.all([
    deps.listNodes(scope),
    deps.getStatusCounts(scope),
  ]);

  /*
   * AGGREGATE vs SINGLE NODE.
   *
   * With a nodeId the cards describe that node. WITHOUT one they describe every
   * node in scope, POOLED -- not the first node in scope, which is what this used
   * to do. That made "All sites" look empty purely because ARGONNE-CAMPUS sorts
   * first alphabetically and is a DAS node with no M1-M4 stages, while selecting a
   * route showed values. All therefore appeared to contain less than its own
   * subsets, which cannot be true of a rollup.
   *
   * Now: All >= route >= node, always.
   */
  const aggregate = !scope.nodeId;
  const selected = aggregate
    ? nodes.nodes[0]
    : nodes.nodes.find((n) => n.nodeId === scope.nodeId);

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

  if (selected && !aggregate) {
    // One node: unchanged.
    const nodeScope = { ...deps.companyScopeOf(scope), nodeId: selected.nodeId };
    const [m, st, c] = await Promise.all([
      deps.getNodeMetrics(nodeScope),
      deps.getNodeStages(nodeScope),
      deps.getNodeChecklist(nodeScope),
    ]);
    metrics = m.byNode[selected.nodeId] || null;
    stages = st.byNode[selected.nodeId] || [];
    checklist = c.byNode[selected.nodeId] || [];
  } else if (selected) {
    // Whole scope, pooled.
    const [m, st, c] = await Promise.all([
      deps.getNodeMetrics(scope),
      deps.getNodeStages(scope),
      deps.getNodeChecklist(scope),
    ]);
    metrics = poolMetrics(m.byNode);
    stages = poolStages(st.byNode);
    checklist = poolChecklist(c.byNode);
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


/* ---------------------------------------------------------------------------
 * Rollups for the aggregate case.
 *
 * Everything here POOLS -- sums numerators and denominators -- rather than
 * averaging per-node percentages. Averaging would weight a node with 3 photo
 * fields the same as one with 166.
 * ------------------------------------------------------------------------- */

/** Milestones and figures pooled across every node in scope. */
function poolMetrics(byNode) {
  const nodes = Object.values(byNode);
  if (!nodes.length) return null;

  const sum = (f) => nodes.reduce((t, n) => t + (Number(n[f]) || 0), 0);

  /*
   * A milestone is measurable in aggregate if ANY node in scope can measure it.
   * Nodes on templates with no M1-M4 stages contribute 0/0, so they neither help
   * nor penalise -- which is why All is no longer dragged to "--" by the 139
   * nodes that have no milestone stages.
   */
  const order = [];
  const byKey = new Map();
  for (const n of nodes) {
    for (const ms of n.milestones || []) {
      if (!byKey.has(ms.key)) {
        order.push(ms.key);
        byKey.set(ms.key, {
          key: ms.key, label: ms.label, name: ms.name, reason: ms.reason,
          done: 0, total: 0, nodes: 0,
        });
      }
      const acc = byKey.get(ms.key);
      if (ms.total > 0) {
        acc.done += Number(ms.done) || 0;
        acc.total += Number(ms.total) || 0;
        acc.nodes += 1;
      }
    }
  }

  const milestones = order.map((k) => {
    const a = byKey.get(k);
    const measurable = a.total > 0;
    return {
      key: a.key,
      label: a.label,
      name: a.name,
      measurable,
      reason: measurable ? undefined : a.reason,
      done: a.done,
      total: a.total,
      pct: measurable ? Math.round((a.done / a.total) * 100) : null,
      /** How many nodes contributed, so the UI can say what the bar covers. */
      nodes: a.nodes,
    };
  });

  const photoFields = sum('photoFields');
  const fieldsCovered = sum('fieldsCovered');
  const denominator =
    nodes.reduce((t, n) => t + (Number(n.coverageDenominator) || 0), 0) || photoFields;

  // Nodes that never reported have missedDays null; they contribute nothing
  // rather than a fabricated zero.
  const withWindow = nodes.filter((n) => n.missedDays !== null && n.missedDays !== undefined);
  const lastReports = nodes.map((n) => n.lastReport).filter(Boolean).sort();

  return {
    aggregated: true,
    nodeCount: nodes.length,
    milestonesMapped: nodes.some((n) => n.milestonesMapped),
    mappedStages: sum('mappedStages'),
    totalStages: sum('totalStages'),
    stagePhotos: sum('stagePhotos'),
    milestones,
    reports: sum('reports'),
    reportDays: sum('reportDays'),
    lastReport: lastReports.length ? lastReports[lastReports.length - 1] : null,
    missedDays: withWindow.length ? withWindow.reduce((t, n) => t + n.missedDays, 0) : null,
    photoFields,
    photos: sum('photos'),
    photosAllMedia: sum('photosAllMedia'),
    fieldsCovered,
    naFields: sum('naFields'),
    notRequiredFields: sum('notRequiredFields'),
    incompleteFields: sum('incompleteFields'),
    coverageDenominator: denominator,
    photoPct: denominator > 0 ? Math.min(100, Math.round((fieldsCovered / denominator) * 100)) : null,
    photoPctApproximate: nodes.some((n) => n.photoPctApproximate),
  };
}

/** Stages pooled by stage name: one row per distinct stage across the scope. */
function poolStages(byNode) {
  const acc = new Map();
  for (const list of Object.values(byNode)) {
    for (const st of list) {
      if (!acc.has(st.stage)) {
        acc.set(st.stage, {
          stage: st.stage, milestone: st.milestone, photoFields: 0, photos: 0,
          fieldsCovered: 0, lastPhoto: null, nodes: 0, startedNodes: 0,
        });
      }
      const a = acc.get(st.stage);
      a.photoFields += st.photoFields;
      a.photos += st.photos;
      a.fieldsCovered += st.fieldsCovered;
      a.nodes += 1;
      if (st.started) a.startedNodes += 1;
      if (st.lastPhoto && (!a.lastPhoto || st.lastPhoto > a.lastPhoto)) a.lastPhoto = st.lastPhoto;
    }
  }
  return [...acc.values()]
    .map((a) => ({ ...a, started: a.photos > 0, aggregated: true }))
    .sort((x, y) => y.photos - x.photos || String(x.stage).localeCompare(String(y.stage)));
}

/**
 * Checklist pooled by document name: one row per distinct item across the scope,
 * carrying how many nodes are complete / missing / n-a.
 *
 * `status` is still set so the existing renderer works, using the majority state,
 * but nodeCount and completeCount are what the UI should show when aggregating --
 * a single word cannot describe 63 nodes at once.
 */
function poolChecklist(byNode) {
  const acc = new Map();
  for (const list of Object.values(byNode)) {
    for (const it of list) {
      if (!acc.has(it.name)) {
        acc.set(it.name, {
          name: it.name, kind: it.kind, milestone: it.milestone, section: it.section,
          stage: it.stage, position: it.position, sequence: it.sequence,
          formId: null, statusReason: null, inChecklist: true,
          photoFields: 0, photos: 0, submissions: 0, lastPhoto: null, lastSubmission: null,
          nodeCount: 0, completeCount: 0, missingCount: 0, naCount: 0,
        });
      }
      const a = acc.get(it.name);
      a.nodeCount += 1;
      if (it.status === 'complete') a.completeCount += 1;
      else if (it.status === 'missing') a.missingCount += 1;
      else a.naCount += 1;
      a.photoFields += it.photoFields || 0;
      a.photos += it.photos || 0;
      a.submissions += it.submissions || 0;
      if (it.lastPhoto && (!a.lastPhoto || it.lastPhoto > a.lastPhoto)) a.lastPhoto = it.lastPhoto;
      if (it.lastSubmission && (!a.lastSubmission || it.lastSubmission > a.lastSubmission)) {
        a.lastSubmission = it.lastSubmission;
      }
      if (!a.milestone && it.milestone) a.milestone = it.milestone;
    }
  }
  return [...acc.values()]
    .map((a) => ({
      ...a,
      aggregated: true,
      done: a.completeCount > 0,
      status:
        a.completeCount >= a.missingCount && a.completeCount >= a.naCount
          ? 'complete'
          : a.missingCount >= a.naCount
            ? 'missing'
            : 'na',
    }))
    .sort(
      (x, y) =>
        (x.sequence ?? 9999) - (y.sequence ?? 9999) || String(x.name).localeCompare(String(y.name))
    );
}

module.exports = { composeRouteMonitor, composeSiteMonitor };
