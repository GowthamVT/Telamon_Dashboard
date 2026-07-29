/**
 * Pooled Snowflake access.
 *
 * One process-wide connection pool is created lazily on first query and reused
 * for the lifetime of the process. Requests borrow a connection and return it;
 * we never open a connection per request -- Snowflake session setup costs
 * hundreds of milliseconds, so per-request connects would dominate latency.
 *
 * Authentication is key-pair (JWT). No password is ever read or stored.
 */
const fs = require('node:fs');
const snowflakeSdk = require('snowflake-sdk');
const config = require('../config/env');
const logger = require('../util/logger');

// The SDK is chatty on stdout by default; route it through our own level.
snowflakeSdk.configure({ logLevel: 'ERROR', additionalLogToConsole: false });

/** @type {import('generic-pool').Pool<any> | null} */
let pool = null;

/**
 * Connections that have already had their session parameters applied.
 * A WeakSet keeps this from leaking when the pool destroys a connection.
 */
const primed = new WeakSet();

let stats = { acquired: 0, executed: 0, failed: 0 };

/**
 * Which auth mode is in effect.
 *
 * Key-pair (JWT) is the intended mode and the default. Password auth is an
 * explicit override for when the public key cannot be registered on the user
 * (that needs USERADMIN/ACCOUNTADMIN, which the PUBLIC role lacks).
 *
 * Setting SNOWFLAKE_PASSWORD wins over the key on disk: a key file is always
 * present once `npm run keygen` has run, so deferring to it would make the
 * password setting silently do nothing. Unset SNOWFLAKE_PASSWORD to go back to
 * key-pair.
 */
function authMode() {
  const sf = config.snowflake;
  if (sf.password) return 'password';
  if (fs.existsSync(sf.resolvedKeyPath)) return 'keypair';
  // Neither available: stay on keypair so readPrivateKey() raises the actionable
  // "run npm run keygen" error rather than a vague auth failure.
  return 'keypair';
}

function buildConnectionOptions() {
  const sf = config.snowflake;
  const common = {
    account: sf.account,
    username: sf.username,
    role: sf.role,
    warehouse: sf.warehouse,
    database: sf.database,
    schema: sf.schema,
    // Keep result rows as JS objects keyed by column name.
    rowMode: 'object',
    clientSessionKeepAlive: true,
  };

  if (authMode() === 'password') {
    logger.warn(
      'Using PASSWORD authentication (SNOWFLAKE_PASSWORD is set and no key is in use). ' +
        'Key-pair auth is preferred -- register the public key and remove SNOWFLAKE_PASSWORD from .env.'
    );
    return { ...common, password: sf.password };
  }

  return {
    ...common,
    authenticator: 'SNOWFLAKE_JWT',
    privateKey: config.readPrivateKey(),
    ...(sf.privateKeyPassphrase ? { privateKeyPass: sf.privateKeyPassphrase } : {}),
  };
}

function getPool() {
  if (pool) return pool;

  const sf = config.snowflake;
  pool = snowflakeSdk.createPool(buildConnectionOptions(), {
    min: sf.pool.min,
    max: sf.pool.max,
    acquireTimeoutMillis: sf.pool.acquireTimeoutMs,
    idleTimeoutMillis: sf.pool.idleTimeoutMs,
    evictionRunIntervalMillis: Math.max(30_000, sf.pool.idleTimeoutMs / 4),
    testOnBorrow: false,
  });

  logger.info(
    `Snowflake pool created (min=${sf.pool.min} max=${sf.pool.max}) for ` +
      `${sf.account}/${sf.database}.${sf.schema} as role ${sf.role}`
  );
  return pool;
}

/** Promise wrapper around connection.execute. */
function executeOnConnection(connection, sqlText, binds) {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err, stmt, rows) => {
        if (err) return reject(err);
        resolve({ rows: rows || [], statement: stmt });
      },
    });
  });
}

/**
 * Apply session-level guards once per physical connection.
 * STATEMENT_TIMEOUT_IN_SECONDS is the authoritative protection against a
 * runaway query holding a pooled connection open indefinitely.
 */
async function primeConnection(connection) {
  if (primed.has(connection)) return;
  const seconds = Math.max(1, Math.ceil(config.snowflake.queryTimeoutMs / 1000));
  await executeOnConnection(
    connection,
    `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = ${seconds}, TIMEZONE = 'UTC'`,
    []
  );
  primed.add(connection);
}

/**
 * Run a query on a pooled connection.
 *
 * @param {string} sqlText          SQL with `?` placeholders -- never interpolate user input.
 * @param {Array}  [binds]         Bind values for the placeholders.
 * @param {{label?: string}} [opts] Optional label used in timing logs.
 * @returns {Promise<{rows: object[], rowCount: number, columns: {name: string, type: string}[], elapsedMs: number}>}
 */
async function query(sqlText, binds = [], opts = {}) {
  const label = opts.label || 'query';
  const started = process.hrtime.bigint();

  try {
    const result = await getPool().use(async (connection) => {
      stats.acquired += 1;
      await primeConnection(connection);
      return executeOnConnection(connection, sqlText, binds);
    });

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    stats.executed += 1;
    logger.debug(`${label} ok in ${elapsedMs.toFixed(0)}ms (${result.rows.length} rows)`);

    const columns = (result.statement?.getColumns?.() || []).map((c) => ({
      name: c.getName(),
      type: c.getType(),
    }));

    return {
      rows: result.rows,
      rowCount: result.rows.length,
      columns,
      elapsedMs,
    };
  } catch (err) {
    stats.failed += 1;
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    logger.error(`${label} failed after ${elapsedMs.toFixed(0)}ms: ${err.message}`);
    throw err;
  }
}

/** Cheap liveness probe used by /api/health and by verify-connection.js. */
async function ping() {
  const { rows } = await query(
    `SELECT CURRENT_ACCOUNT()   AS account,
            CURRENT_USER()      AS "user",
            CURRENT_ROLE()      AS role,
            CURRENT_WAREHOUSE() AS warehouse,
            CURRENT_DATABASE()  AS database,
            CURRENT_SCHEMA()    AS schema,
            CURRENT_VERSION()   AS version`,
    [],
    { label: 'ping' }
  );
  return rows[0];
}

function poolStats() {
  if (!pool) return { initialized: false, ...stats };
  return {
    initialized: true,
    size: pool.size,
    available: pool.available,
    borrowed: pool.borrowed,
    pending: pool.pending,
    min: pool.min,
    max: pool.max,
    ...stats,
  };
}

/** Drain the pool on shutdown so Snowflake sessions close cleanly. */
async function close() {
  if (!pool) return;
  const draining = pool;
  pool = null;
  try {
    await draining.drain();
    await draining.clear();
    logger.info('Snowflake pool drained');
  } catch (err) {
    logger.warn(`Error draining Snowflake pool: ${err.message}`);
  }
}

module.exports = { query, ping, poolStats, close, authMode };
