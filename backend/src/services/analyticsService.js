/**
 * Cache-wrapped analytics reads. Routes call only this module -- they never
 * touch SQL or the pool directly.
 *
 * Every result is cached under a key derived from the full logical request, so
 * two users asking for the same slice cost one warehouse query.
 *
 * TODO(RLS): once per-user filtering exists, the principal's scope MUST become
 * part of every cache payload below (e.g. `scope: principal.tenantId`).
 * Otherwise one tenant's cached rows would be served to another -- a cache key
 * that ignores the security boundary is a data leak, not just a stale read.
 */
const sf = require('../db/snowflake');
const cache = require('../cache/queryCache');
const dashboard = require('../config/dashboard');
const qb = require('./queryBuilder');

/** Descriptor metadata the UI needs to render controls. No data, so no cache. */
function getMeta() {
  const d = dashboard.load();
  return {
    source: d.source,
    generatedFrom: d.generatedFrom,
    measures: d.measures.map(({ key, label, format, agg }) => ({ key, label, format, agg })),
    dimensions: d.dimensions.map(({ key, label, approxDistinct }) => ({
      key,
      label,
      approxDistinct,
    })),
    timeColumns: d.timeColumns.map(({ key, label, type }) => ({ key, label, type })),
    defaultTimeColumn: d.defaultTimeColumn,
    drillPath: d.drillPath,
    detailColumns: d.detailColumns,
    grains: Object.keys(qb.TIME_GRAINS),
  };
}

async function getSummary(request) {
  const d = dashboard.load();
  return cache.wrap('summary', request, async () => {
    const { sql, binds, measures } = qb.buildSummary(d, request);
    const { rows, elapsedMs } = await sf.query(sql, binds, { label: 'summary' });
    return {
      measures: measures.map(({ key, label, format }) => ({ key, label, format })),
      values: rows[0] || {},
      elapsedMs,
    };
  });
}

async function getBreakdown(request) {
  const d = dashboard.load();
  return cache.wrap('breakdown', request, async () => {
    const built = qb.buildBreakdown(d, request);
    const { rows, elapsedMs } = await sf.query(built.sql, built.binds, { label: 'breakdown' });
    return {
      dimension: { key: built.dimension.key, label: built.dimension.label },
      measures: built.measures.map(({ key, label, format }) => ({ key, label, format })),
      rows,
      sort: built.sort,
      page: { ...built.page, returned: rows.length },
      elapsedMs,
    };
  });
}

async function getTimeseries(request) {
  const d = dashboard.load();
  return cache.wrap('timeseries', request, async () => {
    const built = qb.buildTimeseries(d, request);
    const { rows, elapsedMs } = await sf.query(built.sql, built.binds, { label: 'timeseries' });
    return {
      timeColumn: { key: built.timeColumn.key, label: built.timeColumn.label },
      grain: built.grain,
      measures: built.measures.map(({ key, label, format }) => ({ key, label, format })),
      rows,
      elapsedMs,
    };
  });
}

async function getFilterOptions(request) {
  const d = dashboard.load();
  return cache.wrap('filter-options', request, async () => {
    const built = qb.buildFilterOptions(d, request);
    const { rows, elapsedMs } = await sf.query(built.sql, built.binds, { label: 'filter-options' });
    return {
      dimension: { key: built.dimension.key, label: built.dimension.label },
      options: rows,
      elapsedMs,
    };
  });
}

/** Drill-through: raw rows plus a total count for "showing N of M". */
async function getDetail(request) {
  const d = dashboard.load();
  return cache.wrap('detail', request, async () => {
    const built = qb.buildDetail(d, request);
    const counted = qb.buildCount(d, request);

    const [detail, total] = await Promise.all([
      sf.query(built.sql, built.binds, { label: 'detail' }),
      sf.query(counted.sql, counted.binds, { label: 'detail-count' }),
    ]);

    return {
      columns: built.columns,
      rows: detail.rows,
      page: { ...built.page, returned: detail.rows.length },
      total: Number(total.rows[0]?.total ?? 0),
      elapsedMs: detail.elapsedMs,
    };
  });
}

module.exports = {
  getMeta,
  getSummary,
  getBreakdown,
  getTimeseries,
  getFilterOptions,
  getDetail,
};
