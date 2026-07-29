import { api } from '../api/client';
import { useApi } from '../hooks/useApi';
import { formatDimensionValue } from '../lib/format';

/**
 * One filter row above everything it scopes -- never per-chart filters.
 * Every chart and table on the page re-renders against this same slice.
 */

/** Dimension dropdown, populated from live distinct values. */
function DimensionFilter({ dimension, value, onChange, scopeFilters, dateRange, timeColumn }) {
  // Option lists respect the *other* active filters so choices stay coherent.
  const params = {
    dimension: dimension.key,
    filters: scopeFilters,
    from: dateRange.from,
    to: dateRange.to,
    timeColumn,
    limit: 500,
  };

  const { data, isLoading, error } = useApi((opts) => api.filterOptions(params, opts), [
    'filter-options',
    params,
  ]);

  const options = data?.options || [];

  return (
    <label className="field">
      <span className="field-label">{dimension.label}</span>
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        disabled={isLoading || !!error}
        aria-label={`Filter by ${dimension.label}`}
      >
        <option value="">
          {error ? 'Unavailable' : isLoading ? 'Loading...' : `All ${dimension.label.toLowerCase()}`}
        </option>
        {options.map((option) => (
          <option key={String(option.value)} value={option.value ?? ''}>
            {formatDimensionValue(option.value)}
            {option.count != null ? ` (${option.count})` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FilterBar({
  meta,
  filters,
  onFilterChange,
  dateRange,
  onDateRangeChange,
  timeColumn,
  onTimeColumnChange,
  grain,
  onGrainChange,
  selectedMeasures,
  onMeasuresChange,
  onReset,
  hasActiveFilters,
}) {
  // Cap filter controls so a wide table does not produce a wall of dropdowns.
  const filterable = (meta.dimensions || []).slice(0, 4);
  const hasTime = (meta.timeColumns || []).length > 0;

  return (
    <div className="filter-bar" role="group" aria-label="Dashboard filters">
      {filterable.map((dimension) => {
        // Exclude this dimension's own value when fetching its options.
        const { [dimension.key]: _self, ...others } = filters;
        return (
          <DimensionFilter
            key={dimension.key}
            dimension={dimension}
            value={filters[dimension.key]}
            onChange={(value) => onFilterChange(dimension.key, value)}
            scopeFilters={others}
            dateRange={dateRange}
            timeColumn={timeColumn}
          />
        );
      })}

      {hasTime ? (
        <>
          <label className="field">
            <span className="field-label">From</span>
            <input
              type="date"
              value={dateRange.from || ''}
              max={dateRange.to || undefined}
              onChange={(event) => onDateRangeChange({ ...dateRange, from: event.target.value || null })}
            />
          </label>
          <label className="field">
            <span className="field-label">To</span>
            <input
              type="date"
              value={dateRange.to || ''}
              min={dateRange.from || undefined}
              onChange={(event) => onDateRangeChange({ ...dateRange, to: event.target.value || null })}
            />
          </label>

          {meta.timeColumns.length > 1 ? (
            <label className="field">
              <span className="field-label">Date field</span>
              <select value={timeColumn || ''} onChange={(event) => onTimeColumnChange(event.target.value)}>
                {meta.timeColumns.map((column) => (
                  <option key={column.key} value={column.key}>
                    {column.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="field">
            <span className="field-label">Grain</span>
            <select value={grain} onChange={(event) => onGrainChange(event.target.value)}>
              {(meta.grains || ['day', 'week', 'month', 'quarter', 'year']).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}

      <label className="field">
        <span className="field-label">Measures</span>
        <select
          multiple
          size={Math.min(4, Math.max(2, (meta.measures || []).length))}
          value={selectedMeasures}
          onChange={(event) =>
            onMeasuresChange(Array.from(event.target.selectedOptions, (option) => option.value))
          }
          aria-label="Measures to display (multiple selection)"
        >
          {(meta.measures || []).map((measure) => (
            <option key={measure.key} value={measure.key}>
              {measure.label}
            </option>
          ))}
        </select>
        <span className="field-hint">Ctrl/Cmd-click for multiple</span>
      </label>

      <button type="button" className="subtle" onClick={onReset} disabled={!hasActiveFilters}>
        Reset filters
      </button>
    </div>
  );
}
