import { useMemo, useState } from 'react';
import { api } from './api/client';
import { useApi } from './hooks/useApi';
import { useDrill } from './hooks/useDrill';
import { FilterBar } from './components/FilterBar';
import { StatTiles } from './components/StatTiles';
import { TrendChart } from './components/TrendChart';
import { BreakdownChart } from './components/BreakdownChart';
import { BreakdownTable } from './components/BreakdownTable';
import { Breadcrumbs } from './components/Breadcrumbs';
import { DetailView } from './components/DetailView';
import { MAX_SERIES } from './components/chartTheme';
import { formatDimensionValue } from './lib/format';

const BREAKDOWN_LIMIT = 25;

/** The API has no descriptor yet: show the fix, not a raw error. */
function NotConfigured({ message }) {
  return (
    <div className="banner info">
      <div className="banner-body">
        <strong>Dashboard not configured yet</strong>
        The API is running but has not introspected your Snowflake schema. Once key-pair auth
        works, run:
        <div style={{ marginTop: 8 }}>
          <code>cd backend &amp;&amp; npm run introspect</code>
        </div>
        {message ? (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>{message}</div>
        ) : null}
      </div>
    </div>
  );
}

function ErrorBanner({ error, onRetry }) {
  return (
    <div className="banner">
      <div className="banner-body">
        <strong>{error.code === 'network' ? 'Cannot reach the API' : 'Request failed'}</strong>
        {error.message}
        {error.details?.allowed ? (
          <div style={{ marginTop: 6, fontSize: 12 }}>
            Allowed values: {error.details.allowed.join(', ')}
          </div>
        ) : null}
        {onRetry ? (
          <div style={{ marginTop: 10 }}>
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function App() {
  // Filter-bar state. In memory only -- see api/client.js on iframe constraints.
  const [filters, setFilters] = useState({});
  const [dateRange, setDateRange] = useState({ from: null, to: null });
  const [timeColumn, setTimeColumn] = useState(null);
  const [grain, setGrain] = useState('month');
  const [selectedMeasures, setSelectedMeasures] = useState([]);
  const [sort, setSort] = useState(null);

  const meta = useApi((opts) => api.meta(opts), ['meta']);
  const descriptor = meta.data;

  const drillPath = descriptor?.drillPath || [];
  const drill = useDrill(drillPath);

  // Selections fall back to descriptor defaults until the user picks.
  const measures = useMemo(() => {
    if (selectedMeasures.length > 0) return selectedMeasures;
    return (descriptor?.measures || []).slice(0, MAX_SERIES).map((m) => m.key);
  }, [selectedMeasures, descriptor]);

  const effectiveTimeColumn = timeColumn || descriptor?.defaultTimeColumn || null;

  /** Filter bar + drill crumbs = one slice that scopes every card on the page. */
  const activeFilters = useMemo(
    () => ({ ...filters, ...drill.drillFilters }),
    [filters, drill.drillFilters]
  );

  const hasActiveFilters =
    Object.values(filters).some((v) => v != null && v !== '') || !!dateRange.from || !!dateRange.to;

  const sharedParams = {
    filters: activeFilters,
    from: dateRange.from,
    to: dateRange.to,
    timeColumn: effectiveTimeColumn,
  };

  const ready = !!descriptor && measures.length > 0;

  const summary = useApi(
    (opts) => api.summary({ ...sharedParams, measures }, opts),
    ['summary', sharedParams, measures],
    { enabled: ready }
  );

  const hasTime = (descriptor?.timeColumns || []).length > 0;
  const timeseries = useApi(
    (opts) => api.timeseries({ ...sharedParams, measures, grain }, opts),
    ['timeseries', sharedParams, measures, grain],
    { enabled: ready && hasTime }
  );

  const currentDimension = drill.currentDimension;
  const breakdownParams = {
    ...sharedParams,
    measures,
    dimension: currentDimension,
    sortBy: sort?.by,
    sortDir: sort?.dir,
    limit: BREAKDOWN_LIMIT,
  };
  const breakdown = useApi(
    (opts) => api.breakdown(breakdownParams, opts),
    ['breakdown', breakdownParams],
    { enabled: ready && !!currentDimension && !drill.detailOpen }
  );

  // The server echoes the sort it actually applied, so header arrows are honest
  // even before the user clicks anything.
  const effectiveSort = sort || breakdown.data?.sort || null;

  const handleFilterChange = (key, value) => {
    setFilters((prev) => {
      const next = { ...prev };
      if (value == null || value === '') delete next[key];
      else next[key] = value;
      return next;
    });
    // A changed slice invalidates the current drill position.
    drill.reset();
  };

  const handleReset = () => {
    setFilters({});
    setDateRange({ from: null, to: null });
    setSort(null);
    drill.reset();
  };

  const handleDrillDown = (crumb) => {
    drill.drillDown(crumb);
    // Each level asks its own question; let it pick its own default sort.
    setSort(null);
  };

  const scopeLabel = drill.crumbs.length
    ? drill.crumbs.map((c) => `${c.label}: ${formatDimensionValue(c.value)}`).join(' · ')
    : 'All data';

  if (meta.isLoading) {
    return (
      <div className="app">
        <div className="state-box">Loading dashboard...</div>
      </div>
    );
  }

  if (meta.error) {
    return (
      <div className="app">
        <header className="app-header">
          <h1 className="app-title">Snowflake Analytics</h1>
        </header>
        {meta.error.code === 'not_configured' ? (
          <NotConfigured message={meta.error.message} />
        ) : (
          <ErrorBanner error={meta.error} onRetry={meta.refetch} />
        )}
      </div>
    );
  }

  const source = descriptor.source || {};
  const currentDimensionLabel = currentDimension
    ? descriptor.dimensions.find((d) => d.key === currentDimension)?.label
    : null;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1 className="app-title">Snowflake Analytics</h1>
          <p className="app-subtitle">
            {source.database}.{source.schema}.{source.object}
          </p>
        </div>
        <div className="header-meta">
          {summary.cacheHit ? (
            <span className="cache-pill">
              <span className="dot" aria-hidden="true" />
              cached
            </span>
          ) : null}
          <span>{descriptor.dimensions?.length || 0} dimensions</span>
        </div>
      </header>

      <FilterBar
        meta={descriptor}
        filters={filters}
        onFilterChange={handleFilterChange}
        dateRange={dateRange}
        onDateRangeChange={(range) => {
          setDateRange(range);
          drill.reset();
        }}
        timeColumn={effectiveTimeColumn}
        onTimeColumnChange={setTimeColumn}
        grain={grain}
        onGrainChange={setGrain}
        selectedMeasures={measures}
        onMeasuresChange={setSelectedMeasures}
        onReset={handleReset}
        hasActiveFilters={hasActiveFilters}
      />

      {summary.error ? <ErrorBanner error={summary.error} onRetry={summary.refetch} /> : null}

      <StatTiles
        data={summary.data}
        isLoading={summary.isLoading}
        isRefetching={summary.isRefetching}
        scopeLabel={scopeLabel}
      />

      {drillPath.length > 0 ? (
        <Breadcrumbs
          crumbs={drill.crumbs}
          currentDimensionLabel={currentDimensionLabel}
          onNavigate={drill.drillUpTo}
        />
      ) : null}

      {drill.detailOpen ? (
        <DetailView
          filters={activeFilters}
          dateRange={dateRange}
          timeColumn={effectiveTimeColumn}
          onClose={drill.closeDetail}
          scopeLabel={scopeLabel}
        />
      ) : (
        <div className="grid">
          {hasTime ? (
            <div className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">
                    Trend by {grain}
                    {timeseries.data?.timeColumn ? ` (${timeseries.data.timeColumn.label})` : ''}
                  </h2>
                  <div className="card-hint">{scopeLabel}</div>
                </div>
              </div>
              {timeseries.error ? (
                <ErrorBanner error={timeseries.error} onRetry={timeseries.refetch} />
              ) : timeseries.isLoading ? (
                <div className="chart-empty">Loading trend...</div>
              ) : (
                <TrendChart
                  data={timeseries.data}
                  grain={grain}
                  isRefetching={timeseries.isRefetching}
                />
              )}
            </div>
          ) : null}

          {currentDimension ? (
            <>
              <div className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">{breakdown.data?.dimension?.label || currentDimensionLabel}</h2>
                    <div className="card-hint">
                      {drill.canDrillDeeper
                        ? 'Click a bar or row to drill down'
                        : 'Deepest level of the drill path'}
                    </div>
                  </div>
                  <button type="button" onClick={drill.openDetail}>
                    View detail rows
                  </button>
                </div>

                {breakdown.error ? (
                  <ErrorBanner error={breakdown.error} onRetry={breakdown.refetch} />
                ) : breakdown.isLoading ? (
                  <div className="chart-empty">Loading breakdown...</div>
                ) : (
                  <BreakdownChart
                    data={breakdown.data}
                    onDrillDown={handleDrillDown}
                    canDrillDeeper={drill.canDrillDeeper}
                    isRefetching={breakdown.isRefetching}
                  />
                )}
              </div>

              {/* Table twin: the sortable, WCAG-clean equivalent of the chart. */}
              {!breakdown.error && !breakdown.isLoading ? (
                <div className="card">
                  <div className="card-header">
                    <div>
                      <h2 className="card-title">Table view</h2>
                      <div className="card-hint">
                        Sorting runs in Snowflake, so it orders the full result set. Top{' '}
                        {BREAKDOWN_LIMIT}.
                      </div>
                    </div>
                  </div>
                  <BreakdownTable
                    data={breakdown.data}
                    sort={effectiveSort}
                    onSortChange={setSort}
                    onDrillDown={handleDrillDown}
                    canDrillDeeper={drill.canDrillDeeper}
                    isRefetching={breakdown.isRefetching}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <div className="card">
              <div className="state-box">
                <strong>Deepest drill level reached</strong>
                <span>Open the detail rows, or use the breadcrumbs to go back up.</span>
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button type="button" className="primary" onClick={drill.openDetail}>
                    View detail rows
                  </button>
                  <button
                    type="button"
                    onClick={() => drill.drillUpTo(Math.max(0, drill.crumbs.length - 1))}
                  >
                    Drill up
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {drillPath.length === 0 ? (
        <div className="banner info" style={{ marginTop: 16 }}>
          <div className="banner-body">
            <strong>No drill path configured</strong>
            No low-cardinality dimensions were detected, so drill-down is unavailable. Add
            dimension keys to <code>drillPath</code> in <code>backend/dashboard.config.json</code>.
          </div>
        </div>
      ) : null}
    </div>
  );
}
