import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { axisProps, gridProps, MAX_SERIES, seriesColor, useChartTokens } from './chartTheme';
import { ChartTooltip } from './ChartTooltip';
import { formatBucket, formatTick } from '../lib/format';

/**
 * Time trend, faceted as small multiples -- one panel per measure.
 *
 * Why facet instead of overlaying: measures on this dataset differ by orders of
 * magnitude (a count in the thousands beside a currency total in the hundreds of
 * thousands). Overlaid on one axis, the smaller series flattens onto the
 * baseline and reads as zero. A second y-axis would "fix" the picture by
 * inventing a correlation the data does not contain, so it is off the table.
 * Each panel therefore gets its OWN axis, and no panel has two scales.
 *
 * Each facet is a single series, so it needs no legend -- the panel title names
 * what is plotted.
 */
function TrendFacet({ rows, measure, color, tokens, grain, single }) {
  return (
    <div className="facet">
      <div className="facet-title">{measure.label}</div>
      <div className="chart-box" style={{ height: single ? 300 : 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid {...gridProps(tokens)} />
            <XAxis dataKey="bucketLabel" {...axisProps(tokens)} minTickGap={28} />
            <YAxis
              {...axisProps(tokens)}
              tickFormatter={formatTick}
              width={56}
              // Start at zero and let the scale round to clean tick values.
              domain={[0, 'auto']}
            />
            <Tooltip
              content={<ChartTooltip measures={[measure]} />}
              cursor={{ stroke: tokens.axis, strokeWidth: 1 }}
            />
            <Line
              type="monotone"
              dataKey={measure.key}
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              // >=8px marker with a 2px surface ring so it stays legible.
              activeDot={{ r: 4, fill: color, stroke: tokens['surface-1'], strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function TrendChart({ data, grain, isRefetching }) {
  const tokens = useChartTokens();
  const rows = data?.rows || [];

  if (rows.length === 0) {
    return <div className="chart-empty">No data in this time range.</div>;
  }

  // Cap at the validated slot count rather than generating more hues.
  const series = (data?.measures || []).slice(0, MAX_SERIES);

  const chartRows = rows.map((row) => ({
    ...row,
    bucketLabel: formatBucket(row.bucket, grain),
  }));

  return (
    <div className={`facets${isRefetching ? ' refetching' : ''}`}>
      {series.map((measure, i) => (
        <TrendFacet
          key={measure.key}
          rows={chartRows}
          measure={measure}
          color={seriesColor(tokens, i)}
          tokens={tokens}
          grain={grain}
          single={series.length === 1}
        />
      ))}
    </div>
  );
}
