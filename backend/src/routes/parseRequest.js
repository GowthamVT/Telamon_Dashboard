/**
 * Turns an Express query string into the plain request object the query builder
 * expects. No validation of *meaning* happens here -- the builder rejects keys
 * that are not in the descriptor. This layer only normalises shape.
 *
 * Conventions:
 *   measures=revenue,orders     comma-separated measure keys
 *   dimension=region            dimension key to group by
 *   f.<dimension>=a,b           filter; repeatable and/or comma-separated
 *   from=2024-01-01&to=...      date range on `timeColumn` (or the default)
 *   grain=month                 timeseries bucket
 *   sortBy=revenue&sortDir=desc sorting
 *   limit=50&offset=0           paging
 */
const FILTER_PREFIX = 'f.';

function csv(value) {
  if (value === undefined || value === null) return [];
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function parseRequest(req) {
  const q = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };

  const filters = {};
  for (const [key, value] of Object.entries(q)) {
    if (!key.startsWith(FILTER_PREFIX)) continue;
    const dimensionKey = key.slice(FILTER_PREFIX.length);
    if (!dimensionKey) continue;
    const values = csv(value);
    if (values.length > 0) filters[dimensionKey] = values;
  }
  // A POST body may also send filters as a nested object.
  if (q.filters && typeof q.filters === 'object' && !Array.isArray(q.filters)) {
    for (const [k, v] of Object.entries(q.filters)) {
      const values = csv(v);
      if (values.length > 0) filters[k] = values;
    }
  }

  const dateRange =
    q.from || q.to
      ? {
          column: q.timeColumn || undefined,
          from: q.from || undefined,
          to: q.to || undefined,
        }
      : null;

  return {
    measures: csv(q.measures),
    dimension: q.dimension || undefined,
    timeColumn: q.timeColumn || undefined,
    grain: q.grain || undefined,
    filters,
    dateRange,
    sortBy: q.sortBy || undefined,
    sortDir: q.sortDir || undefined,
    limit: q.limit,
    offset: q.offset,
  };
}

module.exports = { parseRequest };
