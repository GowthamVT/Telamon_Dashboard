import { formatValue } from '../lib/format';

/**
 * Shared tooltip. Values are also reachable from the axis ticks and the table
 * view, so the tooltip enhances rather than gates -- per the interaction spec.
 *
 * Text uses text tokens; identity comes from the swatch beside it, never from
 * coloring the text.
 */
export function ChartTooltip({ active, payload, label, measures = [], hint }) {
  if (!active || !payload?.length) return null;

  const formatOf = (key) => measures.find((m) => m.key === key)?.format || 'number';
  const labelOf = (key) => measures.find((m) => m.key === key)?.label || key;

  return (
    <div className="tooltip" role="tooltip">
      <div className="tooltip-title">{label}</div>
      {payload.map((entry) => (
        <div className="tooltip-row" key={entry.dataKey}>
          <span className="tooltip-swatch" style={{ background: entry.color }} aria-hidden="true" />
          <span>{labelOf(entry.dataKey)}</span>
          <span className="tooltip-value">
            {formatValue(entry.value, formatOf(entry.dataKey))}
          </span>
        </div>
      ))}
      {hint ? <div className="tooltip-hint">{hint}</div> : null}
    </div>
  );
}

/** Legend for >= 2 series. A single series relies on the card title instead. */
export function SeriesLegend({ series, colorFor }) {
  if (!series || series.length < 2) return null;
  return (
    <div className="legend">
      {series.map((s, i) => (
        <span className="legend-item" key={s.key}>
          <span
            className="legend-key"
            style={{ background: colorFor(i), height: s.shape === 'bar' ? 8 : 3 }}
            aria-hidden="true"
          />
          {s.label}
        </span>
      ))}
    </div>
  );
}
