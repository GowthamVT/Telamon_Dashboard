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
const config = require('../config/env');

/**
 * WHICH SOURCE SERVES THE MONITORS.
 *
 * The dashboard is migrating from Snowflake to reading MongoDB directly. Both
 * adapters expose the same functions and return the same JSON, so the frontend
 * is unaffected either way -- MONGO_ENABLED picks between them.
 *
 * Snowflake stays the default. The Mongo adapter has to reproduce the validated
 * figures (Basile 165/122, PASS CHRISTIAN 165/554, Wadley 166/593 + 31 reports,
 * Bowling Green GBII 20) before the flag is flipped, and flipping back is one
 * env var if anything looks wrong.
 */
function resolveMonitorService() {
  if (!config.mongo.enabled) return require('../services/monitorService');
  try {
    return require('../services/monitorMongoService');
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        'MONGO_ENABLED=true but services/monitorMongoService.js does not exist yet. ' +
          'The MongoDB adapter is still being built -- set MONGO_ENABLED=false in ' +
          'backend/.env to keep serving from Snowflake.'
      );
    }
    throw err;
  }
}

const monitors = resolveMonitorService();

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
