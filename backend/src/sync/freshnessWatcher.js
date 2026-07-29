/**
 * Background freshness watcher.
 *
 * Polls Snowflake on an interval for a cheap fingerprint of the source object.
 * When the fingerprint changes, the data changed, so the cache is invalidated
 * and the next request repopulates it. This is what lets us cache aggressively
 * without serving stale numbers indefinitely.
 *
 * Two fingerprint strategies:
 *   - TABLE: INFORMATION_SCHEMA metadata (LAST_ALTERED / ROW_COUNT / BYTES).
 *     Pure metadata, so it does not spin up warehouse compute.
 *   - VIEW:  a COUNT(*) (+ MAX(time)) probe, because a view's LAST_ALTERED
 *     tracks the *definition*, not the underlying rows.
 *
 * Interval, and whether this runs at all, come from SYNC_POLL_SECONDS /
 * SYNC_ENABLED. Upgrading to Snowflake Streams later means replacing only
 * computeFingerprint().
 */
const config = require('../config/env');
const logger = require('../util/logger');
const sf = require('../db/snowflake');
const cache = require('../cache/queryCache');
const dashboard = require('../config/dashboard');

let timer = null;
let lastFingerprint = null;
let state = {
  running: false,
  lastCheckedAt: null,
  lastChangeAt: null,
  checks: 0,
  changes: 0,
  errors: 0,
  lastError: null,
  strategy: null,
};

async function computeFingerprint(descriptor) {
  const isView = String(descriptor.generatedFrom?.type || 'BASE TABLE')
    .toUpperCase()
    .includes('VIEW');

  if (!isView) {
    state.strategy = 'information_schema-metadata';
    const { rows } = await sf.query(
      `SELECT TO_VARCHAR(MAX(LAST_ALTERED)) AS last_altered,
              MAX(ROW_COUNT)                AS row_count,
              MAX(BYTES)                    AS bytes
         FROM IDENTIFIER(?).INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [descriptor.source.database, descriptor.source.schema, descriptor.source.object],
      { label: 'freshness-metadata' }
    );
    const r = rows[0] || {};
    // A table that reports no metadata (some views/external objects) falls back
    // below, otherwise we would fingerprint "null" forever and never invalidate.
    if (r.LAST_ALTERED || r.ROW_COUNT !== null) {
      return `meta:${r.LAST_ALTERED}|${r.ROW_COUNT}|${r.BYTES}`;
    }
  }

  state.strategy = 'count-probe';
  const timeColumn = descriptor.timeColumn(descriptor.defaultTimeColumn);
  const maxExpr = timeColumn ? `, TO_VARCHAR(MAX("${timeColumn.column}")) AS max_time` : '';
  const { rows } = await sf.query(
    `SELECT COUNT(*) AS row_count${maxExpr} FROM ${descriptor.fqn}`,
    [],
    { label: 'freshness-probe' }
  );
  const r = rows[0] || {};
  return `probe:${r.ROW_COUNT}|${r.MAX_TIME ?? '-'}`;
}

/** One poll cycle. Exported so it can be triggered manually or from a test. */
async function checkOnce({ invalidate = true } = {}) {
  const descriptor = dashboard.load();
  state.checks += 1;
  state.lastCheckedAt = new Date().toISOString();

  const fingerprint = await computeFingerprint(descriptor);
  const changed = lastFingerprint !== null && fingerprint !== lastFingerprint;
  const first = lastFingerprint === null;
  lastFingerprint = fingerprint;

  if (changed) {
    state.changes += 1;
    state.lastChangeAt = state.lastCheckedAt;
    logger.info(`Source data changed (${fingerprint}) -- invalidating cache`);
    if (invalidate) cache.invalidateAll('freshness-watcher');
  } else if (first) {
    logger.info(`Freshness baseline established via ${state.strategy}: ${fingerprint}`);
  } else {
    logger.debug(`No change (${fingerprint})`);
  }

  return { fingerprint, changed, first, strategy: state.strategy };
}

async function tick() {
  try {
    await checkOnce();
    state.lastError = null;
  } catch (err) {
    state.errors += 1;
    state.lastError = err.message;
    // Never let a transient Snowflake/config error kill the interval; the next
    // tick retries. A missing descriptor is expected before `npm run introspect`.
    logger.warn(`Freshness check failed: ${err.message}`);
  }
}

function start() {
  if (!config.sync.enabled || config.sync.pollSeconds <= 0) {
    logger.info('Freshness watcher disabled (SYNC_ENABLED=false or SYNC_POLL_SECONDS=0)');
    return;
  }
  if (timer) return;

  const intervalMs = config.sync.pollSeconds * 1000;
  timer = setInterval(tick, intervalMs);
  timer.unref(); // don't hold the event loop open on shutdown
  state.running = true;
  logger.info(`Freshness watcher started (every ${config.sync.pollSeconds}s)`);

  // Establish the baseline immediately rather than waiting a full interval.
  tick();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  state.running = false;
}

function status() {
  return {
    ...state,
    enabled: config.sync.enabled,
    pollSeconds: config.sync.pollSeconds,
    fingerprint: lastFingerprint,
  };
}

module.exports = { start, stop, status, checkOnce };
