/**
 * Value formatting. The descriptor's `format` hint on each measure decides which
 * of these applies, so a column named REVENUE renders as currency without the UI
 * hardcoding any column names.
 */

const compact = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const plain = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** Snowflake returns NUMBER/DECIMAL as strings to preserve precision. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Compact form for stat tiles, where space is tight. */
export function formatCompact(value, format = 'number') {
  const n = toNumber(value);
  if (n === null) return '--';

  switch (format) {
    case 'currency':
      // Intl currency + compact needs a currency code; the dataset does not tell
      // us one, so prefix a neutral symbol rather than guess USD/EUR/INR.
      return `${n < 0 ? '-' : ''}$${compact.format(Math.abs(n))}`;
    case 'percent':
      return `${plain.format(n)}%`;
    case 'integer':
      return Math.abs(n) >= 100000 ? compact.format(n) : integer.format(n);
    default:
      return Math.abs(n) >= 100000 ? compact.format(n) : plain.format(n);
  }
}

/** Full precision, for table cells and tooltips. */
export function formatValue(value, format = 'number') {
  const n = toNumber(value);
  if (n === null) {
    // Distinguish a real NULL from a missing key.
    return value === null ? '--' : formatCell(value);
  }

  switch (format) {
    case 'currency':
      return `${n < 0 ? '-' : ''}$${plain.format(Math.abs(n))}`;
    case 'percent':
      return `${plain.format(n)}%`;
    case 'integer':
      return integer.format(n);
    default:
      return plain.format(n);
  }
}

/** Best-effort rendering of an arbitrary detail-table cell. */
export function formatCell(value) {
  if (value === null || value === undefined) return '--';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);

  const s = String(value);
  // Snowflake DATE/TIMESTAMP come back as ISO strings; trim to something readable.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 19).replace('T', ' ');
  return s;
}

/** Axis/tooltip label for a time bucket, at the right resolution for the grain. */
export function formatBucket(value, grain = 'month') {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  switch (grain) {
    case 'year':
      return String(date.getUTCFullYear());
    case 'quarter':
      return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
    case 'month':
      return date.toLocaleDateString(undefined, {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
    default:
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      });
  }
}

/** Compact axis ticks: 12000 -> 12K. */
export function formatTick(value) {
  const n = toNumber(value);
  if (n === null) return '';
  return Math.abs(n) >= 1000 ? compact.format(n) : plain.format(n);
}

/** Dimension values can be NULL in Snowflake; label them explicitly. */
export function formatDimensionValue(value) {
  if (value === null || value === undefined || value === '') return '(none)';
  return formatCell(value);
}
