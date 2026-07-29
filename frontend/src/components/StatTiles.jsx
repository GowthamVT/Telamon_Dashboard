import { formatCompact } from '../lib/format';

/**
 * KPI tiles. One number is a stat tile, not a one-bar bar chart.
 *
 * Values use the font's proportional figures (tabular-nums would make a large
 * standalone number look loose).
 */
export function StatTiles({ data, isLoading, isRefetching, scopeLabel }) {
  const measures = data?.measures || [];
  const values = data?.values || {};

  if (isLoading) {
    return (
      <div className="tiles">
        {[0, 1, 2].map((i) => (
          <div className="tile" key={i}>
            <div className="tile-label">Loading</div>
            <div className="tile-value" style={{ color: 'var(--text-muted)' }}>
              --
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (measures.length === 0) return null;

  return (
    <div className={`tiles${isRefetching ? ' refetching' : ''}`}>
      {measures.map((measure) => (
        <div className="tile" key={measure.key}>
          <div className="tile-label">{measure.label}</div>
          <div className="tile-value">{formatCompact(values[measure.key], measure.format)}</div>
          {scopeLabel ? <div className="tile-sub">{scopeLabel}</div> : null}
        </div>
      ))}
    </div>
  );
}
