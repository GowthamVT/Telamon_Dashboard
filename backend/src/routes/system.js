/**
 * Operational endpoints: health, cache and pool visibility, sync status, and a
 * manual cache-invalidation hook.
 *
 * /health is intentionally cheap and touches neither source, so a load balancer
 * probe cannot spin up the Snowflake warehouse or add load to the MongoDB
 * cluster. /health/source does the real round trip against whichever source is
 * active; /health/snowflake and /health/mongo force a specific one.
 */
const express = require('express');
const config = require('../config/env');
const sf = require('../db/snowflake');
const mongo = require('../db/mongo');
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
    // WHICH SOURCE IS SERVING. On the cheap probe deliberately: during the
    // migration "is it on Mongo yet?" must be answerable without a round trip.
    source: config.mongo.enabled ? 'mongodb' : 'snowflake',
    configured: dashboard.isConfigured(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

/** Round trip against whichever source is actually serving the monitors. */
router.get(
  '/health/source',
  handle(async () => {
    const started = Date.now();
    if (config.mongo.enabled) {
      const info = await mongo.ping();
      return {
        status: 'ok',
        source: 'mongodb',
        latencyMs: Date.now() - started,
        session: info,
        pool: mongo.poolStats(),
      };
    }
    const session = await sf.ping();
    return {
      status: 'ok',
      source: 'snowflake',
      latencyMs: Date.now() - started,
      session,
      pool: sf.poolStats(),
    };
  })
);

/** Real MongoDB round trip. */
router.get(
  '/health/mongo',
  handle(async () => {
    const started = Date.now();
    const info = await mongo.ping();
    return { status: 'ok', latencyMs: Date.now() - started, session: info, pool: mongo.poolStats() };
  })
);

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
    /** The active source for the monitor endpoints. */
    source: config.mongo.enabled ? 'mongodb' : 'snowflake',
    configured: dashboard.isConfigured(),
    mongo: {
      enabled: config.mongo.enabled,
      database: config.mongo.database || null,
      // Host only -- the URI embeds the password and must never be echoed.
      host: config.mongo.uri
        ? String(config.mongo.uri).replace(/^mongodb(\+srv)?:\/\/[^@]*@/, '').split(/[/?]/)[0]
        : null,
      pool: mongo.poolStats(),
    },
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
