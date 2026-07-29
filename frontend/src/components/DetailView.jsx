import { useState } from 'react';
import { api } from '../api/client';
import { useApi } from '../hooks/useApi';
import { formatCell } from '../lib/format';

const PAGE_SIZE = 100;

/**
 * Drill-THROUGH view: the raw Snowflake rows behind the aggregate the user was
 * looking at.
 *
 * It inherits the exact same filters as the summary view (drill crumbs + filter
 * bar), which is what makes the numbers reconcile -- the count here matches the
 * aggregate above it because both are built from one WHERE clause server-side.
 */
export function DetailView({ filters, dateRange, timeColumn, onClose, scopeLabel }) {
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState({ by: null, dir: 'asc' });

  const params = {
    filters,
    from: dateRange.from,
    to: dateRange.to,
    timeColumn,
    limit: PAGE_SIZE,
    offset,
    sortBy: sort.by || undefined,
    sortDir: sort.by ? sort.dir : undefined,
  };

  const { data, error, isLoading, isRefetching } = useApi((opts) => api.detail(params, opts), [
    'detail',
    params,
  ]);

  const columns = data?.columns || [];
  const rows = data?.rows || [];
  const total = data?.total ?? 0;

  const toggleSort = (column) => {
    setOffset(0);
    setSort((prev) =>
      prev.by === column ? { by: column, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { by: column, dir: 'asc' }
    );
  };

  const from = total === 0 ? 0 : offset + 1;
  const to = offset + rows.length;

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Detail rows</h2>
          <div className="card-hint">
            {scopeLabel ? `${scopeLabel} · ` : ''}
            {isLoading ? 'Loading...' : `Showing ${from}-${to} of ${total.toLocaleString()}`}
          </div>
        </div>
        <button type="button" onClick={onClose}>
          Back to summary
        </button>
      </div>

      {error ? (
        <div className="state-box">
          <strong>Could not load detail rows</strong>
          <span>{error.message}</span>
        </div>
      ) : isLoading ? (
        <div className="state-box">Loading rows...</div>
      ) : rows.length === 0 ? (
        <div className="state-box">No rows match the current filters.</div>
      ) : (
        <>
          <div className={`table-wrap${isRefetching ? ' refetching' : ''}`}>
            <table>
              <caption className="visually-hidden">
                Raw detail rows for the current selection. Column headers are sortable.
              </caption>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th
                      key={column}
                      className="sortable"
                      scope="col"
                      tabIndex={0}
                      role="columnheader"
                      aria-sort={
                        sort.by === column ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                      }
                      onClick={() => toggleSort(column)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          toggleSort(column);
                        }
                      }}
                    >
                      {column}
                      {sort.by === column ? (
                        <span className="sort-arrow" aria-hidden="true">
                          {sort.dir === 'asc' ? '↑' : '↓'}
                        </span>
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={offset + index}>
                    {columns.map((column) => (
                      <td key={column}>{formatCell(row[column])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            <button
              type="button"
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              disabled={offset === 0 || isRefetching}
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
              disabled={to >= total || isRefetching}
            >
              Next
            </button>
            <span className="card-hint">Page {Math.floor(offset / PAGE_SIZE) + 1}</span>
          </div>
        </>
      )}
    </div>
  );
}
