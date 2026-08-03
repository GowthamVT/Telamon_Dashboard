/**
 * Completion Monitor endpoints.
 *
 * GET /api/monitor/routes        routes ("Site Name") in scope
 * GET /api/monitor/nodes         nodes ("Node Name") in scope
 * GET /api/monitor/status-counts KPI card: sites per status
 * GET /api/monitor/route         Route Monitor header + KPI
 * GET /api/monitor/site          Site Monitor header + KPI
 *
 * Scope params (all optional): companyId, siteId, nodeId.
 * Omitting them falls back to the Telamon company scope -- see buildScope(),
 * which is the single place per-user RLS belongs.
 */
const express = require('express');
const monitors = require('../services/monitorService');

const router = express.Router();

/** Only these keys are read from the query string; everything else is ignored. */
function scopeFrom(req) {
  const { companyId, siteId, nodeId, company } = req.query;
  return {
    ...(companyId ? { companyId } : {}),
    ...(siteId ? { siteId } : {}),
    ...(nodeId ? { nodeId } : {}),
    // `company` overrides the default pattern; handy for testing other tenants.
    ...(company ? { companyPattern: `%${company}%` } : {}),
  };
}

const handle = (fn) => (req, res, next) =>
  Promise.resolve(fn(req))
    .then((result) => {
      if (result && result.cache) {
        res.set('X-Cache', result.cache.hit ? 'HIT' : 'MISS');
      }
      res.json(result);
    })
    .catch(next);

router.get('/monitor/node-checklist', handle((req) => monitors.getNodeChecklist(scopeFrom(req))));
router.get('/monitor/node-stages', handle((req) => monitors.getNodeStages(scopeFrom(req))));
router.get('/monitor/node-metrics', handle((req) => monitors.getNodeMetrics(scopeFrom(req))));
router.get('/monitor/hierarchy', handle((req) => monitors.getHierarchy(scopeFrom(req))));
router.get('/monitor/routes', handle((req) => monitors.listRoutes(scopeFrom(req))));
router.get('/monitor/nodes', handle((req) => monitors.listNodes(scopeFrom(req))));
router.get('/monitor/status-counts', handle((req) => monitors.getStatusCounts(scopeFrom(req))));
router.get('/monitor/route', handle((req) => monitors.getRouteMonitor(scopeFrom(req))));
router.get('/monitor/site', handle((req) => monitors.getSiteMonitor(scopeFrom(req))));

module.exports = router;
