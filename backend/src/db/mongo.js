/**
 * Pooled MongoDB access to the ECSite source cluster.
 *
 * One process-wide MongoClient is created
 * lazily on first use and reused for the lifetime of the process -- the driver
 * maintains its own connection pool internally, so a client per request would
 * mean a TLS handshake per request.
 *
 * READS ONLY. Every aggregation goes through assertReadOnlyPipeline() first, and
 * the Atlas user holds role `read`, so a write is refused by the server as well.
 *
 * WHY secondaryPreferred MATTERS: this is the same cluster the field portal runs
 * on. Analytics scans belong on a replica, not on the primary that crews depend
 * on while uploading photos. The read preference is set in MONGO_URI rather than
 * here so it is visible in configuration, but it is asserted below so a URI
 * missing it produces a warning instead of silently loading the primary.
 */
const config = require('../config/env');
const logger = require('../util/logger');
const { assertReadOnlyPipeline } = require('./mongoReadOnly');

/** @type {import('mongodb').MongoClient | null} */
let client = null;
let connecting = null;

let stats = { queries: 0, failed: 0, docsReturned: 0 };

function requireConfigured() {
  if (!config.mongo.uri) {
    throw new Error(
      'MongoDB is not configured: MONGO_URI is missing from backend/.env. ' +
        'See backend/.env.example for the expected format.'
    );
  }
  if (!config.mongo.database) {
    throw new Error('MongoDB is not configured: MONGO_DATABASE is missing from backend/.env.');
  }
}

/**
 * Connect once, and reuse. Concurrent callers share a single in-flight connect
 * rather than each starting their own.
 */
async function getDb() {
  requireConfigured();
  if (client) return client.db(config.mongo.database);
  if (connecting) return connecting;

  connecting = (async () => {
    const { MongoClient } = require('mongodb');

    if (!/readPreference=secondary/i.test(config.mongo.uri)) {
      logger.warn(
        'MONGO_URI has no readPreference=secondaryPreferred. Dashboard queries may ' +
          'land on the primary that the field portal uses. Add it to the URI.'
      );
    }

    const created = new MongoClient(config.mongo.uri, {
      maxPoolSize: config.mongo.poolMax,
      serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMs,
      connectTimeoutMS: config.mongo.connectTimeoutMs,
      // We never write, so retryable writes are pointless overhead.
      retryWrites: false,
    });

    await created.connect();
    client = created;
    connecting = null;

    const host = String(config.mongo.uri).replace(/\/\/[^@]*@/, '//***@');
    logger.info(`MongoDB connected (maxPoolSize=${config.mongo.poolMax}) -> ${host}`);
    return client.db(config.mongo.database);
  })();

  try {
    return await connecting;
  } catch (err) {
    connecting = null;
    throw err;
  }
}

/**
 * Run a read-only aggregation.
 *
 * Returns { rows, rowCount, elapsedMs }.
 *
 * `maxTimeMS` is always applied so a runaway pipeline cannot pin a connection or
 * load the cluster indefinitely.
 */
async function aggregate(collection, pipeline, { label = 'mongo', maxTimeMS } = {}) {
  assertReadOnlyPipeline(pipeline);

  const db = await getDb();
  const started = process.hrtime.bigint();

  try {
    const rows = await db
      .collection(collection)
      .aggregate(pipeline, {
        maxTimeMS: maxTimeMS ?? config.mongo.queryTimeoutMs,
        allowDiskUse: false,
      })
      .toArray();

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    stats.queries += 1;
    stats.docsReturned += rows.length;
    logger.debug(`${label} ok in ${elapsedMs.toFixed(0)}ms (${rows.length} docs)`);

    return { rows, rowCount: rows.length, elapsedMs };
  } catch (err) {
    stats.failed += 1;
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    logger.error(`${label} failed after ${elapsedMs.toFixed(0)}ms: ${err.message}`);
    throw err;
  }
}

/** Plain find, for the rare case where an aggregation would be overkill. */
async function find(collection, filter, { label = 'mongo-find', projection, limit, sort } = {}) {
  const db = await getDb();
  const started = process.hrtime.bigint();
  try {
    let cursor = db.collection(collection).find(filter, {
      maxTimeMS: config.mongo.queryTimeoutMs,
    });
    if (projection) cursor = cursor.project(projection);
    if (sort) cursor = cursor.sort(sort);
    if (limit) cursor = cursor.limit(limit);

    const rows = await cursor.toArray();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    stats.queries += 1;
    stats.docsReturned += rows.length;
    logger.debug(`${label} ok in ${elapsedMs.toFixed(0)}ms (${rows.length} docs)`);
    return { rows, rowCount: rows.length, elapsedMs };
  } catch (err) {
    stats.failed += 1;
    logger.error(`${label} failed: ${err.message}`);
    throw err;
  }
}

/** Liveness probe, for /api/health and for the connection check script. */
async function ping() {
  const db = await getDb();
  const started = process.hrtime.bigint();
  await db.admin().ping();
  const info = await db.command({ buildInfo: 1 }).catch(() => ({}));
  return {
    ok: true,
    database: config.mongo.database,
    serverVersion: info.version || 'unknown',
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

function poolStats() {
  return { initialized: Boolean(client), maxPoolSize: config.mongo.poolMax, ...stats };
}

/** Close on shutdown so the cluster sees a clean disconnect. */
async function close() {
  if (!client) return;
  const closing = client;
  client = null;
  try {
    await closing.close();
    logger.info('MongoDB client closed');
  } catch (err) {
    logger.warn(`Error closing MongoDB client: ${err.message}`);
  }
}

module.exports = { getDb, aggregate, find, ping, poolStats, close };
