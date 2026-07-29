/**
 * Analytics REST surface.
 *
 * GET /api/meta                dashboard descriptor: measures, dimensions, drill path
 * GET /api/summary             KPI tiles
 * GET /api/timeseries          trend chart
 * GET /api/breakdown           grouped table/chart -- also the drill-DOWN query
 * GET /api/filter-options      distinct values for one dimension's dropdown
 * GET /api/detail              drill-THROUGH: raw rows behind an aggregate
 *
 * Drill mechanics are intentionally stateless: the client holds the drill path
 * as a list of {dimension, value} crumbs and sends them as ordinary filters,
 * plus the next dimension to group by. That means drill-down, drill-up, and
 * deep-linking are all the same request shape, and nothing about the drill
 * state lives on the server -- which is what keeps this safe to embed and
 * cache. Each level is a normal cached query.
 */
const express = require('express');
const analytics = require('../services/analyticsService');
const { parseRequest } = require('./parseRequest');

const router = express.Router();

/** Surface cache status on the response so the UI can show freshness. */
function withCacheHeaders(res, result) {
  if (result && result.cache) {
    res.set('X-Cache', result.cache.hit ? 'HIT' : 'MISS');
    res.set('X-Cache-Generation', String(result.cache.generation));
  }
  return result;
}

/** Async route wrapper so rejections reach the error middleware. */
const handle = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res))
    .then((result) => res.json(withCacheHeaders(res, result)))
    .catch(next);

router.get('/meta', handle(() => analytics.getMeta()));

router.get('/summary', handle((req) => analytics.getSummary(parseRequest(req))));

router.get('/timeseries', handle((req) => analytics.getTimeseries(parseRequest(req))));

router.get(
  '/breakdown',
  handle((req) => {
    const request = parseRequest(req);
    if (!request.dimension) {
      const err = new Error('Query parameter "dimension" is required for /breakdown.');
      err.status = 400;
      err.name = 'RequestError';
      throw err;
    }
    return analytics.getBreakdown(request);
  })
);

router.get(
  '/filter-options',
  handle((req) => {
    const request = parseRequest(req);
    if (!request.dimension) {
      const err = new Error('Query parameter "dimension" is required for /filter-options.');
      err.status = 400;
      err.name = 'RequestError';
      throw err;
    }
    return analytics.getFilterOptions(request);
  })
);

router.get('/detail', handle((req) => analytics.getDetail(parseRequest(req))));

module.exports = router;
