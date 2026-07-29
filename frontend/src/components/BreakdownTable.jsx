import { formatDimensionValue, formatValue } from '../lib/format';

/**
 * Sortable table twin of the breakdown chart.
 *
 * This is not decoration: it is the accessibility relief for the light-mode
 * series color that sits below 3:1 contrast, and it means no value is reachable
 * only by hovering a mark. Sorting is server-side (Snowflake ORDER BY), so it
 * sorts the whole result set rather than just the current page.
 *
 * Rows are also a drill-down affordance, mirroring a bar click.
 */
export function BreakdownTable({ data, sort, onSortChange, onDrillDown, canDrillDeeper, isRefetching }) {
  const rows = data?.rows || [];
  const dimension = data?.dimension;
  const measures = data?.measures || [];

  if (rows.length === 0) {
    return <div className="chart-empty">No rows match the current filters.</div>;
  }

  const toggleSort = (key) => {
    if (!onSortChange) return;
    // Same column flips direction; a new column starts descending for measures
    // (biggest first is the usual question) and ascending for the dimension.
    const isSame = sort?.by === key;
    const nextDir = isSame ? (sort.dir === 'desc' ? 'asc' : 'desc') : key === dimension?.key ? 'asc' : 'desc';
    onSortChange({ by: key, dir: nextDir });
  };

  const arrow = (key) => {
    if (sort?.by !== key) return null;
    return (
      <span className="sort-arrow" aria-hidden="true">
        {sort.dir === 'desc' ? '↓' : '↑'}
      </span>
    );
  };

  const ariaSort = (key) => {
    if (sort?.by !== key) return 'none';
    return sort.dir === 'desc' ? 'descending' : 'ascending';
  };

  const headerProps = (key) => ({
    className: 'sortable',
    onClick: () => toggleSort(key),
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleSort(key);
      }
    },
    tabIndex: 0,
    role: 'columnheader',
    'aria-sort': ariaSort(key),
    scope: 'col',
  });

  return (
    <div className={`table-wrap${isRefetching ? ' refetching' : ''}`}>
      <table>
        <caption className="visually-hidden">
          {dimension?.label} broken down by {measures.map((m) => m.label).join(', ')}. Column
          headers are sortable.
        </caption>
        <thead>
          <tr>
            <th {...headerProps(dimension?.key)}>
              {dimension?.label}
              {arrow(dimension?.key)}
            </th>
            {measures.map((measure) => (
              <th key={measure.key} className="numeric sortable" {...headerProps(measure.key)}>
                {measure.label}
                {arrow(measure.key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const rawValue = row[dimension?.key];
            const clickable = canDrillDeeper && onDrillDown;
            return (
              <tr
                key={`${rawValue}-${index}`}
                className={clickable ? 'clickable' : undefined}
                onClick={
                  clickable
                    ? () =>
                        onDrillDown({
                          dimension: dimension.key,
                          label: dimension.label,
                          value: rawValue,
                        })
                    : undefined
                }
              >
                <td className="dim-value">{formatDimensionValue(rawValue)}</td>
                {measures.map((measure) => (
                  <td key={measure.key} className="numeric">
                    {formatValue(row[measure.key], measure.format)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
