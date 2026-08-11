/**
 * Central configuration. Everything comes from the environment -- no credential
 * or account identifier is ever hardcoded in source.
 *
 * Loads backend/.env, validates what must be present, and exposes a frozen
 * config object. Fails fast with an actionable message rather than letting a
 * missing value surface later as a confusing connection error.
 */
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

const config = Object.freeze({
  env: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',
  port: int('PORT', 8080),
  logLevel: optional('LOG_LEVEL', 'dev'),

  paths: Object.freeze({
    repoRoot: REPO_ROOT,
    backendRoot: BACKEND_ROOT,
  }),

  /**
   * MongoDB source cluster (the ECSite production database) -- the ONLY source.
   *
   * Required, so a missing value fails at boot with an actionable message rather
   * than surfacing as an empty dashboard. While Snowflake still existed these
   * were optional, because the app had to boot without them.
   */
  mongo: Object.freeze({
    uri: required('MONGO_URI'),
    database: required('MONGO_DATABASE'),
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

/*
 * Checked AFTER config is built: the required() calls happen inside the object
 * literal, so validating before it would always see an empty list.
 */
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}\n` +
      `Copy backend/.env.example to backend/.env and fill in the values.`
  );
}

module.exports = config;
