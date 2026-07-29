/**
 * Operational endpoints: health, cache and pool visibility, sync status, and a
 * manual cache-invalidation hook.
 *
 * /health is intentionally cheap and does NOT touch Snowflake, so a load
 * balancer probe cannot spin up the warehouse. /health/snowflake does the real
 * round trip.
 */
const express = require('express');
const config = require('../config/env');
const sf = require('../db/snowflake');
const cache = require('../cache/queryCache');
const dashboard = require('../config/dashboard');
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
    configured: dashboard.isConfigured(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

/** Real Snowflake round trip -- confirms key-pair auth still works. */
router.get(
  '/health/snowflake',
  handle(async () => {
    const started = Date.now();
    const session = await sf.ping();
    return { status: 'ok', latencyMs: Date.now() - started, session, pool: sf.poolStats() };
  })
);

router.get('/status', (req, res) => {
  res.json({
    env: config.env,
    configured: dashboard.isConfigured(),
    snowflake: {
      account: config.snowflake.account,
      database: config.snowflake.database,
      schema: config.snowflake.schema,
      role: config.snowflake.role,
      warehouse: config.snowflake.warehouse,
      // Never expose the private key path contents or any secret here.
      auth: 'key-pair (SNOWFLAKE_JWT)',
    },
    pool: sf.poolStats(),
    cache: cache.stats(),
    sync: freshness.status(),
  });
});

/**
 * Force a cache flush. Useful after loading data into Snowflake when you do not
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
