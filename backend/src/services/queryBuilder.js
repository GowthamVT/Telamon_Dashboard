/**
 * Translates validated API requests into parameterised Snowflake SQL.
 *
 * Two rules hold everywhere in this file:
 *   1. Identifiers (table/column names) only ever come from the dashboard
 *      descriptor, resolved from request *keys*. A key that is not in the
 *      descriptor is rejected -- it is never passed through to SQL.
 *   2. Values (filter values, date bounds, limits) are ALWAYS bind parameters.
 *
 * Together those make the request surface injection-safe without needing to
 * escape anything by hand.
 */

/** Only these two orderings are reachable from a request. */
const SORT_DIRECTIONS = { asc: 'ASC', desc: 'DESC' };

const TIME_GRAINS = {
  day: 'DAY',
  week: 'WEEK',
  month: 'MONTH',
  quarter: 'QUARTER',
  year: 'YEAR',
};

class RequestError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RequestError';
    this.status = 400;
    this.details = details;
  }
}

/** Render a measure as an aggregate expression plus its output alias. */
function measureExpression(measure) {
  const alias = `"${measure.key}"`;
  switch (measure.agg) {
    case 'COUNT':
      return `COUNT(*) AS ${alias}`;
    case 'COUNT_DISTINCT':
      return `COUNT(DISTINCT "${measure.column}") AS ${alias}`;
    default:
      return `${measure.agg}("${measure.column}") AS ${alias}`;
  }
}

function resolveMeasures(descriptor, keys) {
  const requested = keys && keys.length > 0 ? keys : descriptor.measures.map((m) => m.key);
  return requested.map((key) => {
    const measure = descriptor.measure(key);
    if (!measure) {
      throw new RequestError(`Unknown measure "${key}".`, {
        allowed: descriptor.measures.map((m) => m.key),
      });
    }
    return measure;
  });
}

function resolveDimension(descriptor, key) {
  const dimension = descriptor.dimension(key);
  if (!dimension) {
    throw new RequestError(`Unknown dimension "${key}".`, {
      allowed: descriptor.dimensions.map((d) => d.key),
    });
  }
  return dimension;
}

/**
 * Build the shared WHERE clause.
 *
 * `filters` is { dimensionKey: value | value[] } -- equality / IN semantics.
 * `dateRange` is { column?: timeColumnKey, from?: ISO, to?: ISO }.
 *
 * -------------------------------------------------------------------------
 * TODO(RLS): per-user row-level security is deliberately NOT implemented.
 * Every caller currently sees identical data.
 *
 * This function is the ONE place to add it. When auth arrives, pass the
 * authenticated principal in and append a mandatory predicate here, e.g.
 *
 *     if (principal) {
 *       clauses.push(`"TENANT_ID" = ?`);
 *       binds.push(principal.tenantId);
 *     }
 *
 * Adding it here means every endpoint (summary, timeseries, filter options,
 * detail, drill-down) inherits the restriction automatically, because they all
 * build their WHERE clause through this function. Do not add tenant predicates
 * at the route level -- it is too easy to miss one.
 *
 * Note the cache key must then include the principal's scope, or one user's
 * rows would be served to another. See services/analyticsService.js.
 * -------------------------------------------------------------------------
 */
function buildWhere(descriptor, { filters = {}, dateRange = null } = {}) {
  const clauses = [];
  const binds = [];

  for (const [key, rawValue] of Object.entries(filters)) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    const dimension = resolveDimension(descriptor, key);
    const values = (Array.isArray(rawValue) ? rawValue : [rawValue]).filter(
      (v) => v !== undefined && v !== null && v !== ''
    );
    if (values.length === 0) continue;

    if (values.length === 1) {
      clauses.push(`"${dimension.column}" = ?`);
      binds.push(values[0]);
    } else {
      clauses.push(`"${dimension.column}" IN (${values.map(() => '?').join(', ')})`);
      binds.push(...values);
    }
  }

  if (dateRange && (dateRange.from || dateRange.to)) {
    const timeKey = dateRange.column || descriptor.defaultTimeColumn;
    const timeColumn = descriptor.timeColumn(timeKey);
    if (!timeColumn) {
      throw new RequestError(`Unknown time column "${timeKey}".`, {
        allowed: descriptor.timeColumns.map((t) => t.key),
      });
    }
    if (dateRange.from) {
      clauses.push(`"${timeColumn.column}" >= ?`);
      binds.push(dateRange.from);
    }
    if (dateRange.to) {
      clauses.push(`"${timeColumn.column}" <= ?`);
      binds.push(dateRange.to);
    }
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join('\n    AND ')}` : '',
    binds,
  };
}

/** Scalar KPI row: every requested measure aggregated over the filtered set. */
function buildSummary(descriptor, request) {
  const measures = resolveMeasures(descriptor, request.measures);
  const where = buildWhere(descriptor, request);
  const sql = `SELECT ${measures.map(measureExpression).join(',\n       ')}
  FROM ${descriptor.fqn}
  ${where.sql}`;
  return { sql, binds: where.binds, measures };
}

/**
 * Grouped aggregate: the workhorse behind both the chart and the sortable table,
 * and the query that a drill-down re-issues at the next level down.
 */
function buildBreakdown(descriptor, request) {
  const dimension = resolveDimension(descriptor, request.dimension);
  const measures = resolveMeasures(descriptor, request.measures);
  const where = buildWhere(descriptor, request);

  // Sort target must be the grouped dimension or one of the selected measures.
  const sortKey = request.sortBy || measures[0].key;
  const direction = SORT_DIRECTIONS[String(request.sortDir || 'desc').toLowerCase()];
  if (!direction) {
    throw new RequestError(`Invalid sortDir "${request.sortDir}".`, { allowed: ['asc', 'desc'] });
  }
  const sortIsDimension = sortKey === dimension.key;
  if (!sortIsDimension && !measures.some((m) => m.key === sortKey)) {
    throw new RequestError(`Cannot sort by "${sortKey}" -- not a selected measure or the grouped dimension.`, {
      allowed: [dimension.key, ...measures.map((m) => m.key)],
    });
  }

  const limit = clampLimit(request.limit, 50, 1000);
  const offset = Math.max(0, Number.parseInt(request.offset, 10) || 0);

  const sql = `SELECT "${dimension.column}" AS "${dimension.key}",
       ${measures.map(measureExpression).join(',\n       ')}
  FROM ${descriptor.fqn}
  ${where.sql}
 GROUP BY "${dimension.column}"
 ORDER BY "${sortKey}" ${direction} NULLS LAST
 LIMIT ? OFFSET ?`;

  return {
    sql,
    binds: [...where.binds, limit, offset],
    dimension,
    measures,
    sort: { by: sortKey, dir: direction.toLowerCase() },
    page: { limit, offset },
  };
}

/** Measures bucketed over time, for the trend chart. */
function buildTimeseries(descriptor, request) {
  const timeKey = request.timeColumn || descriptor.defaultTimeColumn;
  const timeColumn = descriptor.timeColumn(timeKey);
  if (!timeColumn) {
    throw new RequestError(
      descriptor.timeColumns.length === 0
        ? 'This dataset has no date/timestamp column, so timeseries is unavailable.'
        : `Unknown time column "${timeKey}".`,
      { allowed: descriptor.timeColumns.map((t) => t.key) }
    );
  }

  const grain = TIME_GRAINS[String(request.grain || 'month').toLowerCase()];
  if (!grain) {
    throw new RequestError(`Invalid grain "${request.grain}".`, {
      allowed: Object.keys(TIME_GRAINS),
    });
  }

  const measures = resolveMeasures(descriptor, request.measures);
  const where = buildWhere(descriptor, request);

  const sql = `SELECT DATE_TRUNC('${grain}', "${timeColumn.column}") AS "bucket",
       ${measures.map(measureExpression).join(',\n       ')}
  FROM ${descriptor.fqn}
  ${where.sql}
 GROUP BY 1
 ORDER BY 1 ASC
 LIMIT ?`;

  return {
    sql,
    binds: [...where.binds, clampLimit(request.limit, 500, 2000)],
    timeColumn,
    grain: grain.toLowerCase(),
    measures,
  };
}

/** Distinct values for one dimension -- populates the filter dropdowns. */
function buildFilterOptions(descriptor, request) {
  const dimension = resolveDimension(descriptor, request.dimension);
  // Options respect the other active filters so choices stay coherent, but a
  // dimension never constrains its own option list.
  const { [request.dimension]: _self, ...others } = request.filters || {};
  const where = buildWhere(descriptor, { ...request, filters: others });

  const sql = `SELECT "${dimension.column}" AS "value", COUNT(*) AS "count"
  FROM ${descriptor.fqn}
  ${where.sql}
 GROUP BY "${dimension.column}"
 ORDER BY "count" DESC NULLS LAST
 LIMIT ?`;

  return { sql, binds: [...where.binds, clampLimit(request.limit, 500, 5000)], dimension };
}

/**
 * Raw rows behind an aggregate -- the drill-through target.
 * Returns descriptor-declared detail columns only, never SELECT *.
 */
function buildDetail(descriptor, request) {
  const columns =
    descriptor.detailColumns.length > 0
      ? descriptor.detailColumns
      : descriptor.dimensions.map((d) => d.column);

  if (columns.length === 0) {
    throw new RequestError('No detail columns are declared in dashboard.config.json.');
  }

  const where = buildWhere(descriptor, request);
  const limit = clampLimit(request.limit, 100, 1000);
  const offset = Math.max(0, Number.parseInt(request.offset, 10) || 0);

  // Sorting a detail view is optional; when present it must name a real column.
  let orderBy = '';
  if (request.sortBy) {
    const match = columns.find((c) => c === request.sortBy || c === String(request.sortBy).toUpperCase());
    if (!match) {
      throw new RequestError(`Cannot sort detail by "${request.sortBy}".`, { allowed: columns });
    }
    const direction = SORT_DIRECTIONS[String(request.sortDir || 'asc').toLowerCase()] || 'ASC';
    orderBy = `\n ORDER BY "${match}" ${direction} NULLS LAST`;
  }

  const sql = `SELECT ${columns.map((c) => `"${c}"`).join(',\n       ')}
  FROM ${descriptor.fqn}
  ${where.sql}${orderBy}
 LIMIT ? OFFSET ?`;

  return { sql, binds: [...where.binds, limit, offset], columns, page: { limit, offset } };
}

/** Total matching rows, so the UI can show "showing N of M". */
function buildCount(descriptor, request) {
  const where = buildWhere(descriptor, request);
  return {
    sql: `SELECT COUNT(*) AS "total" FROM ${descriptor.fqn}\n  ${where.sql}`,
    binds: where.binds,
  };
}

function clampLimit(raw, fallback, max) {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

module.exports = {
  RequestError,
  TIME_GRAINS,
  buildWhere,
  buildSummary,
  buildBreakdown,
  buildTimeseries,
  buildFilterOptions,
  buildDetail,
  buildCount,
};
