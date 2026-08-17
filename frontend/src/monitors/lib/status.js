/**
 * Status vocabulary and colour mapping shared by both monitors.
 *
 * These four colours are a FIXED status palette, not a categorical series
 * palette: each one means a state (good / in-flight / not-started / bad). They
 * are never reused to distinguish one site from another, and they always ship
 * alongside a text label -- colour never carries the meaning on its own.
 */

export const STATUS = {
  COMPLETE: 'Completed',
  IN_PROGRESS: 'In Progress',
  YET_TO_START: 'Yet to Start',
};

/*
 * Themed through CSS variables rather than literal hexes, so one set of
 * components serves both themes. The tokens are defined in monitor.css; the
 * meaning of each colour is identical in light and dark, only its lightness
 * changes -- #34e0a1 measures 1.6:1 on white and had to darken to #0b8f5d.
 */
export const STATUS_COLORS = {
  [STATUS.COMPLETE]: { fg: 'var(--mon-complete)', bg: 'var(--mon-complete-bg)' },
  [STATUS.IN_PROGRESS]: { fg: 'var(--mon-progress)', bg: 'var(--mon-progress-bg)' },
  [STATUS.YET_TO_START]: { fg: 'var(--mon-notstarted)', bg: 'var(--mon-notstarted-bg)' },
};

export const DANGER = 'var(--mon-danger)';
export const EMPTY_TRACK = 'var(--mon-empty)';

export function statusColor(status) {
  return STATUS_COLORS[status]?.fg || '#EAEDF3';
}

export function statusTint(status) {
  return STATUS_COLORS[status]?.bg || 'transparent';
}

/** Traffic-light colour for a raw completion percentage. */
export function pctColor(pct) {
  if (pct >= 70) return STATUS_COLORS[STATUS.COMPLETE].fg;
  if (pct >= 40) return STATUS_COLORS[STATUS.IN_PROGRESS].fg;
  return DANGER;
}

/** Milestone block colour: full, partial, or untouched. */
export function milestoneColor(pct) {
  if (pct === 100) return STATUS_COLORS[STATUS.COMPLETE].fg;
  if (pct > 0) return STATUS_COLORS[STATUS.IN_PROGRESS].fg;
  return EMPTY_TRACK;
}

/** Progress-bar colour driven by a 0-100 percentage. */
export function progressColor(pct) {
  if (pct === 100) return STATUS_COLORS[STATUS.COMPLETE].fg;
  if (pct === 0) return STATUS_COLORS[STATUS.YET_TO_START].fg;
  return STATUS_COLORS[STATUS.IN_PROGRESS].fg;
}

export function percent(done, total) {
  if (!total) return 0;
  return Math.round((done / total) * 100);
}

/** How many of `count` spark bars should be lit for a given percentage. */
export function litBars(pct, count) {
  return Math.round((pct / 100) * count);
}

/**
 * Human summary of a live status-KPI payload.
 *
 * Surfaces the no-history bucket explicitly: for Telamon over half the nodes
 * have no status-history row and are counted as "Yet to Start". That is a
 * defensible reading (never worked) but it dominates the chart, so it must be
 * stated rather than buried.
 */
export function describeStatusScope(kpi) {
  if (!kpi) return null;
  const level = kpi.scopeLevel === 'node' ? 'this node' : kpi.scopeLevel === 'site' ? 'this site' : 'company-wide';
  const noHistory = (kpi.raw || []).find((r) => /no status history/i.test(r.status));
  return {
    level,
    label: kpi.scopeLabel,
    total: kpi.total,
    noHistory: noHistory ? noHistory.sites : 0,
  };
}

/**
 * Local timestamp for the header. Rendered client-side so it reflects the
 * viewer's timezone rather than the warehouse's.
 */
export function nowStamp(date = new Date()) {
  return {
    date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    time: date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
  };
}
