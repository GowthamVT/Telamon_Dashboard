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
const mongoDb = require('../db/mongo');
const cache = require('../cache/queryCache');
const dashboard = require('../config/dashboard');

/**
 * Collections the monitors read. Fingerprinting these is what tells us the
 * source changed when MongoDB is the active source.
 */
const MONGO_WATCHED = [
  'SmallCellNode',
  'FormGroup',
  'FormBuilderQuestions',
  'FormBuilderAnswers',
  'FieldMedia',
];

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

/**
 * MongoDB fingerprint: document counts across the collections the monitors read.
 *
 * estimatedDocumentCount() reads collection metadata rather than scanning, so
 * this stays cheap even against multi-million-document collections and adds no
 * meaningful load to the cluster the field portal runs on.
 *
 * KNOWN LIMIT: counts detect inserts and deletes, not in-place updates. A photo
 * whose approvalStatus flips from null to Approved changes no count, so that is
 * picked up when the cache entry expires rather than immediately.
 * CACHE_TTL_SECONDS (300 by default) is therefore the real staleness bound; this
 * watcher shortens it for the common case of new photos and new reports.
 */
async function computeMongoFingerprint() {
  state.strategy = 'mongo-collection-counts';
  const db = await mongoDb.getDb();
  const parts = [];
  for (const name of MONGO_WATCHED) {
    const n = await db.collection(name).estimatedDocumentCount();
    parts.push(name + ':' + n);
  }
  return 'mongo:' + parts.join('|');
}

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
  state.checks += 1;
  state.lastCheckedAt = new Date().toISOString();

  /*
   * The Snowflake path needs dashboard.config.json, produced by
   * `npm run introspect`. That descriptor has never existed in this project, so
   * every Snowflake tick failed with "Dashboard is not configured yet" and the
   * cache was only ever bounded by its TTL. The MongoDB path needs no descriptor
   * -- it fingerprints the collections the monitors actually read -- so
   * freshness works for the first time once MONGO_ENABLED is on.
   */
  const fingerprint = config.mongo.enabled
    ? await computeMongoFingerprint()
    : await computeFingerprint(dashboard.load());
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
    // Never let a transient source/config error kill the interval; the next tick
    // retries. A missing descriptor is expected on the Snowflake path before
    // `npm run introspect`.
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
