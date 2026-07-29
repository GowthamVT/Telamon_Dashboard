/**
 * Chart theme bridge.
 *
 * Recharts needs concrete color strings, not CSS custom properties, so we read
 * the resolved token values off :root once per theme change. That keeps a single
 * source of truth in theme.css while still feeding Recharts real hex values.
 */
import { useEffect, useState } from 'react';

const TOKENS = [
  'surface-1',
  'text-primary',
  'text-secondary',
  'text-muted',
  'gridline',
  'axis',
  'series-1',
  'series-2',
  'series-3',
];

function readTokens() {
  if (typeof window === 'undefined') return {};
  const styles = getComputedStyle(document.documentElement);
  return TOKENS.reduce((acc, name) => {
    acc[name] = styles.getPropertyValue(`--${name}`).trim();
    return acc;
  }, {});
}

/** Series colors, assigned by fixed slot order -- never cycled, never by rank. */
export function seriesColor(tokens, index) {
  const slots = [tokens['series-1'], tokens['series-2'], tokens['series-3']];
  return slots[index] || slots[0];
}

/**
 * The validated palette is 3 slots for all-pairs use. Beyond that we do not
 * generate or recycle hues -- callers cap the series count instead.
 */
export const MAX_SERIES = 3;

export function useChartTokens() {
  const [tokens, setTokens] = useState(readTokens);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setTokens(readTokens());

    media.addEventListener('change', update);
    // A theme toggle stamps data-theme on <html>; re-read when that changes.
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    update();
    return () => {
      media.removeEventListener('change', update);
      observer.disconnect();
    };
  }, []);

  return tokens;
}

/** Shared axis/grid styling: recessive, solid hairlines -- never dashed. */
export function axisProps(tokens) {
  return {
    stroke: tokens.axis,
    tick: { fill: tokens['text-muted'], fontSize: 11 },
    tickLine: false,
  };
}

export function gridProps(tokens) {
  return {
    stroke: tokens.gridline,
    strokeWidth: 1,
    vertical: false,
  };
}
