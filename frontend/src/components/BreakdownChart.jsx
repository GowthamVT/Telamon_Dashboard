import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { axisProps, gridProps, MAX_SERIES, seriesColor, useChartTokens } from './chartTheme';
import { ChartTooltip } from './ChartTooltip';
import { formatDimensionValue, formatTick } from '../lib/format';

/**
 * Grouped columns, faceted as small multiples -- one panel per measure -- and the
 * primary drill-DOWN affordance: clicking a column pushes that value onto the
 * drill stack.
 *
 * Faceted for the same reason as the trend chart: a count and a currency total
 * do not share a scale, and a second y-axis would fabricate a relationship. One
 * axis per panel, one series per panel.
 *
 * Marks: columns capped at 24px, 4px rounded cap with a square baseline.
 */
function BreakdownFacet({ rows, measure, color, tokens, onBarClick, canDrillDeeper, single }) {
  return (
    <div className="facet">
      <div className="facet-title">{measure.label}</div>
      <div className="chart-box" style={{ height: single ? 300 : 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
            barCategoryGap="20%"
          >
            <CartesianGrid {...gridProps(tokens)} />
            <XAxis
              dataKey="__label"
              {...axisProps(tokens)}
              interval={0}
              angle={rows.length > 6 ? -30 : 0}
              textAnchor={rows.length > 6 ? 'end' : 'middle'}
              height={rows.length > 6 ? 64 : 28}
            />
            <YAxis {...axisProps(tokens)} tickFormatter={formatTick} width={56} domain={[0, 'auto']} />
            <Tooltip
              content={
                <ChartTooltip
                  measures={[measure]}
                  hint={canDrillDeeper ? 'Click to drill down' : undefined}
                />
              }
              cursor={{ fill: tokens.gridline, fillOpacity: 0.4 }}
            />
            {/* One series per panel => one color for every bar. Never a value
                ramp across nominal categories. */}
            <Bar
              dataKey={measure.key}
              fill={color}
              maxBarSize={24}
              radius={[4, 4, 0, 0]}
              onClick={onBarClick}
              cursor={canDrillDeeper ? 'pointer' : 'default'}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function BreakdownChart({ data, onDrillDown, canDrillDeeper, isRefetching }) {
  const tokens = useChartTokens();
  const rows = data?.rows || [];
  const dimension = data?.dimension;

  if (rows.length === 0) {
    return <div className="chart-empty">No rows match the current filters.</div>;
  }

  const series = (data?.measures || []).slice(0, MAX_SERIES);
  const dimensionKey = dimension?.key;

  const chartRows = rows.map((row) => ({
    ...row,
    // Recharts needs a string category; keep the raw value for the drill click.
    __label: formatDimensionValue(row[dimensionKey]),
    __raw: row[dimensionKey],
  }));

  const handleClick = (payload) => {
    if (!canDrillDeeper || !onDrillDown || !payload) return;
    onDrillDown({
      dimension: dimensionKey,
      label: dimension?.label || dimensionKey,
      value: payload.__raw,
    });
  };

  return (
    <div className={`facets${isRefetching ? ' refetching' : ''}`}>
      {series.map((measure, i) => (
        <BreakdownFacet
          key={measure.key}
          rows={chartRows}
          measure={measure}
          color={seriesColor(tokens, i)}
          tokens={tokens}
          onBarClick={handleClick}
          canDrillDeeper={canDrillDeeper}
          single={series.length === 1}
        />
      ))}
    </div>
  );
}
