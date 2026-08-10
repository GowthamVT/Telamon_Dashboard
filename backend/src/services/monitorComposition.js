/**
 * Shared composition for the two monitor endpoints.
 *
 * getRouteMonitor and getSiteMonitor do not query anything themselves -- they
 * assemble what the per-query functions return, decide whether the selection is
 * aggregate, and shape the header. That logic is identical for Snowflake and
 * MongoDB, so it lives here once and both adapters inject their own data
 * functions.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED: the aggregate/`name: null` handling is
 * subtle and was itself a bug fix -- without it the header named an arbitrary
 * route while the picker said "All sites". Two copies means the next fix lands in
 * one adapter and not the other, and the symptom would be a header that is wrong
 * only when MONGO_ENABLED is flipped. The same reasoning already applies to
 * classifyStatus, classifyItemStatus and normaliseStage.
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
   * AGGREGATE vs SINGLE NODE -- same reasoning as the route view.
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

  const routeNames = new Set(nodes.nodes.map((n) => n.routeName).filter(Boolean));
  /*
   * Count sites by siteId, not by route NAME: two sites share the name
   * LUMEN-ILA-LOUISVILLE_NASHVILLE, so counting names gives 61 where the picker
   * says 62 and the two figures contradict each other on screen.
   */
  const siteIds = new Set(nodes.nodes.map((n) => n.siteId).filter(Boolean));
  const companies = new Set(nodes.nodes.map((n) => n.companyName).filter(Boolean));

  /*
   * Milestone, stage and checklist detail for the ONE node on display.
   *
   * Re-scoped to that node rather than reusing the incoming scope: without a
   * nodeId the scope could span a whole company, and computing stage rows for
   * 200 nodes to render one would be wasteful.
   */
  let metrics = null;
  let stages = null;
  let checklist = null;
  if (selected) {
    const nodeScope = { ...deps.companyScopeOf(scope), nodeId: selected.nodeId };
    const [m, s, c] = await Promise.all([
      deps.getNodeMetrics(nodeScope),
      deps.getNodeStages(nodeScope),
      deps.getNodeChecklist(nodeScope),
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

module.exports = { composeRouteMonitor, composeSiteMonitor };
