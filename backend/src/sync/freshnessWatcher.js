/**
 * Background freshness watcher.
 *
 * Polls MongoDB on an interval for a cheap fingerprint of the source.
 * When the fingerprint changes, the data changed, so the cache is invalidated
 * and the next request repopulates it. This is what lets us cache aggressively
 * without serving stale numbers indefinitely.
 *
 * Interval, and whether this runs at all, come from SYNC_POLL_SECONDS /
 * SYNC_ENABLED. Change streams would replace computeMongoFingerprint().
 */
const config = require('../config/env');
const logger = require('../util/logger');
const mongoDb = require('../db/mongo');
const cache = require('../cache/queryCache');

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

/** One poll cycle. Exported so it can be triggered manually or from a test. */
async function checkOnce({ invalidate = true } = {}) {
  state.checks += 1;
  state.lastCheckedAt = new Date().toISOString();

  const fingerprint = await computeMongoFingerprint();
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
    // Never let a transient error kill the interval; the next tick retries.
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
