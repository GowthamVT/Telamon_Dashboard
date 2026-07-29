/**
 * In-memory TTL + LRU cache for query results.
 *
 * Purpose: a dashboard page load fans out into several aggregate queries, and
 * many users request identical slices. Without this, every page load bills
 * warehouse time. Entries are keyed by a hash of the full logical query.
 *
 * Also supports generation-based invalidation: the freshness watcher bumps a
 * generation counter when the underlying data changes, which logically expires
 * everything cached against the previous generation. That is cheaper and more
 * correct than walking and deleting keys.
 *
 * Swapping this for Redis later means reimplementing get/set/invalidate against
 * a Redis client -- callers only use this interface, so nothing else changes.
 */
const crypto = require('node:crypto');
const config = require('../config/env');
const logger = require('../util/logger');

const store = new Map(); // key -> { value, expiresAt, generation, bytes }
let generation = 0;
const metrics = { hits: 0, misses: 0, stores: 0, evictions: 0, expirations: 0 };

/** Stable key from an arbitrary descriptor object (property order independent). */
function keyFor(namespace, payload) {
  const canonical = JSON.stringify(payload, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v)
        .sort()
        .reduce((acc, k) => ((acc[k] = v[k]), acc), {});
    }
    return v;
  });
  const hash = crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 20);
  return `${namespace}:${hash}`;
}

function get(key) {
  const entry = store.get(key);
  if (!entry) {
    metrics.misses += 1;
    return undefined;
  }
  if (entry.generation !== generation) {
    store.delete(key);
    metrics.misses += 1;
    metrics.expirations += 1;
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    metrics.misses += 1;
    metrics.expirations += 1;
    return undefined;
  }
  // Re-insert to make Map iteration order act as LRU recency.
  store.delete(key);
  store.set(key, entry);
  metrics.hits += 1;
  return entry.value;
}

function set(key, value, ttlSeconds = config.cache.ttlSeconds) {
  while (store.size >= config.cache.maxEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
    metrics.evictions += 1;
  }
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
    generation,
  });
  metrics.stores += 1;
  return value;
}

/**
 * Read-through helper: return the cached value or compute, store, and return it.
 * `producer` is only invoked on a miss.
 */
async function wrap(namespace, payload, producer, ttlSeconds) {
  const key = keyFor(namespace, payload);
  const hit = get(key);
  if (hit !== undefined) {
    return { ...hit, cache: { hit: true, key, generation } };
  }
  const fresh = await producer();
  set(key, fresh, ttlSeconds);
  return { ...fresh, cache: { hit: false, key, generation } };
}

/**
 * Invalidate everything by advancing the generation. O(1); stale entries are
 * dropped lazily on next access or by LRU pressure.
 */
function invalidateAll(reason = 'manual') {
  generation += 1;
  logger.info(`Cache invalidated (generation -> ${generation}, reason: ${reason})`);
  return generation;
}

function stats() {
  const total = metrics.hits + metrics.misses;
  return {
    entries: store.size,
    maxEntries: config.cache.maxEntries,
    ttlSeconds: config.cache.ttlSeconds,
    generation,
    ...metrics,
    hitRate: total === 0 ? null : Number((metrics.hits / total).toFixed(3)),
  };
}

function clear() {
  store.clear();
}

module.exports = { keyFor, get, set, wrap, invalidateAll, stats, clear };
