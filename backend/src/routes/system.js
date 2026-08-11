/**
 * Operational endpoints: health, cache and pool visibility, sync status, and a
 * manual cache-invalidation hook.
 *
 * /health is intentionally cheap and touches no database, so a load balancer
 * probe adds no load to the production MongoDB cluster the field portal runs on.
 * /health/mongo does the real round trip.
 */
const express = require('express');
const config = require('../config/env');
const mongo = require('../db/mongo');
const cache = require('../cache/queryCache');
const freshness = require('../sync/freshnessWatcher');

const router = express.Router();

const handle = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res))
    .then((result) => res.json(result))
    .catch(next);

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    env: config.env,
    source: 'mongodb',
    uptimeSeconds: Math.round(process.uptime()),
  });
});

/** Real MongoDB round trip. */
router.get(
  '/health/mongo',
  handle(async () => {
    const started = Date.now();
    const info = await mongo.ping();
    return { status: 'ok', latencyMs: Date.now() - started, session: info, pool: mongo.poolStats() };
  })
);

router.get('/status', (req, res) => {
  res.json({
    env: config.env,
    source: 'mongodb',
    mongo: {
      enabled: config.mongo.enabled,
      database: config.mongo.database || null,
      // Host only -- the URI embeds the password and must never be echoed.
      host: config.mongo.uri
        ? String(config.mongo.uri).replace(/^mongodb(\+srv)?:\/\/[^@]*@/, '').split(/[/?]/)[0]
        : null,
      pool: mongo.poolStats(),
    },
    cache: cache.stats(),
    sync: freshness.status(),
  });
});

/**
 * Force a cache flush. Useful after a bulk data load when you do not
 * want to wait for the next poll.
 *
 * TODO(auth): this mutates shared server state and must require an admin
 * credential before this service is exposed publicly. It is unauthenticated
 * today only because the whole API is.
 */
router.post(
  '/cache/invalidate',
  handle(async () => ({
    status: 'ok',
    generation: cache.invalidateAll('manual-api'),
    cache: cache.stats(),
  }))
);

/** Run one freshness check immediately and report whether data changed. */
router.post(
  '/sync/check',
  handle(async () => ({ status: 'ok', result: await freshness.checkOnce(), sync: freshness.status() }))
);

module.exports = router;
