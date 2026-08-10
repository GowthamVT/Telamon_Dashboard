/**
 * Central configuration. Everything comes from the environment -- no credential
 * or account identifier is ever hardcoded in source.
 *
 * Loads backend/.env, validates what must be present, and exposes a frozen
 * config object. Fails fast with an actionable message rather than letting a
 * missing value surface later as a confusing Snowflake auth error.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });

const missing = [];

/** Required string: record it as missing rather than throwing one-at-a-time. */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    missing.push(name);
    return undefined;
  }
  return value.trim();
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Config error: ${name} must be an integer, got "${raw}".`);
  }
  return parsed;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function list(name, fallback = []) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const snowflake = {
  account: required('SNOWFLAKE_ACCOUNT'),
  username: required('SNOWFLAKE_USER'),
  role: optional('SNOWFLAKE_ROLE', 'PUBLIC'),
  warehouse: required('SNOWFLAKE_WAREHOUSE'),
  database: required('SNOWFLAKE_DATABASE'),
  schema: required('SNOWFLAKE_SCHEMA'),
  privateKeyPath: optional('SNOWFLAKE_PRIVATE_KEY_PATH', 'keys/snowflake_key.p8'),
  privateKeyPassphrase: optional('SNOWFLAKE_PRIVATE_KEY_PASSPHRASE', undefined),
  // Fallback auth. Key-pair is preferred and used whenever this is unset; set it
  // only when you cannot register a public key (that needs USERADMIN, which the
  // PUBLIC role lacks). Read from .env, which is gitignored -- never hardcode it,
  // and never paste it into a chat/ticket.
  password: optional('SNOWFLAKE_PASSWORD', undefined),
  pool: {
    min: int('SNOWFLAKE_POOL_MIN', 1),
    max: int('SNOWFLAKE_POOL_MAX', 6),
    acquireTimeoutMs: int('SNOWFLAKE_POOL_ACQUIRE_TIMEOUT_MS', 30_000),
    idleTimeoutMs: int('SNOWFLAKE_POOL_IDLE_TIMEOUT_MS', 300_000),
  },
  queryTimeoutMs: int('SNOWFLAKE_QUERY_TIMEOUT_MS', 60_000),
};

if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}\n` +
      `Copy backend/.env.example to backend/.env and fill in the values.`
  );
}

// Resolve the key path relative to the repo root so the .env value can stay
// short ("keys/snowflake_key.p8") regardless of where node is launched from.
const resolvedKeyPath = path.isAbsolute(snowflake.privateKeyPath)
  ? snowflake.privateKeyPath
  : path.resolve(REPO_ROOT, snowflake.privateKeyPath);

/**
 * Read the PKCS#8 private key from disk.
 *
 * Deliberately lazy: importing this module must not require key material to
 * exist, so that `npm run keygen` and unit tests work on a fresh clone.
 */
function readPrivateKey() {
  if (!fs.existsSync(resolvedKeyPath)) {
    throw new Error(
      `Snowflake private key not found at: ${resolvedKeyPath}\n` +
        `Generate one with:  cd backend && npm run keygen\n` +
        `Then register the printed public key on the Snowflake user.`
    );
  }
  return fs.readFileSync(resolvedKeyPath, 'utf8');
}

if (snowflake.pool.min > snowflake.pool.max) {
  throw new Error(
    `Config error: SNOWFLAKE_POOL_MIN (${snowflake.pool.min}) cannot exceed ` +
      `SNOWFLAKE_POOL_MAX (${snowflake.pool.max}).`
  );
}

const config = Object.freeze({
  env: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',
  port: int('PORT', 8080),
  logLevel: optional('LOG_LEVEL', 'dev'),

  paths: Object.freeze({
    repoRoot: REPO_ROOT,
    backendRoot: BACKEND_ROOT,
    privateKey: resolvedKeyPath,
  }),

  snowflake: Object.freeze({ ...snowflake, resolvedKeyPath }),
  readPrivateKey,

  /**
   * MongoDB source cluster (the ECSite production database).
   *
   * Deliberately NOT validated with required(): Mongo is optional while the
   * migration is in progress, so a missing MONGO_URI must not stop the Snowflake
   * path from booting. db/mongo.js raises an actionable error if something tries
   * to use it unconfigured.
   *
   * `enabled` is the migration switch. While false the monitors are served from
   * Snowflake exactly as before, and the Mongo adapter can be tested directly
   * without any traffic reaching it.
   */
  mongo: Object.freeze({
    uri: optional('MONGO_URI', ''),
    database: optional('MONGO_DATABASE', ''),
    enabled: bool('MONGO_ENABLED', false),
    poolMax: int('MONGO_POOL_MAX', 6),
    queryTimeoutMs: int('MONGO_QUERY_TIMEOUT_MS', 60_000),
    serverSelectionTimeoutMs: int('MONGO_SERVER_SELECTION_TIMEOUT_MS', 15_000),
    connectTimeoutMs: int('MONGO_CONNECT_TIMEOUT_MS', 15_000),
  }),

  cache: Object.freeze({
    ttlSeconds: int('CACHE_TTL_SECONDS', 300),
    maxEntries: int('CACHE_MAX_ENTRIES', 500),
  }),

  sync: Object.freeze({
    enabled: bool('SYNC_ENABLED', true),
    pollSeconds: int('SYNC_POLL_SECONDS', 60),
  }),

  http: Object.freeze({
    // Empty list => reflect any origin (dev convenience). See middleware/security.js.
    corsAllowedOrigins: list('CORS_ALLOWED_ORIGINS'),
    frameAncestors: list('FRAME_ANCESTORS'),
    rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitMaxRequests: int('RATE_LIMIT_MAX_REQUESTS', 300),
  }),
});

module.exports = config;
