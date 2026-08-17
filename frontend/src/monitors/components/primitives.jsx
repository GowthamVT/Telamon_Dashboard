/**
 * Presentational primitives shared by both monitors.
 *
 * Every one of these is pure: it takes already-derived numbers and renders them.
 * No component here fetches, so swapping mock data for Snowflake later touches
 * only the container modules.
 */
import { useEffect, useState } from 'react';
import { EMPTY_TRACK, litBars, nowStamp, statusColor, statusTint } from '../lib/status';

/* ---------------- Theme switch ---------------- */

const SunIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="4.6" fill="currentColor" />
    <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="12" y1="1.4" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="22.6" />
      <line x1="1.4" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="22.6" y2="12" />
      <line x1="4.5" y1="4.5" x2="6.3" y2="6.3" />
      <line x1="17.7" y1="17.7" x2="19.5" y2="19.5" />
      <line x1="4.5" y1="19.5" x2="6.3" y2="17.7" />
      <line x1="17.7" y1="6.3" x2="19.5" y2="4.5" />
    </g>
  </svg>
);

const MoonIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M20.3 15A8.6 8.6 0 0 1 9 3.7a9 9 0 1 0 11.3 11.3z" />
  </svg>
);

/**
 * Theme control for the monitor: light or dark, as a segmented pair.
 *
 * Writes `data-mon-theme` onto the .mon-root element, which is where the palette
 * tokens live. Deliberately NOT on <html>: the monitor is embedded in a
 * cross-origin iframe alongside a separate light-themed dashboard, and stamping the
 * document root would reach outside this component's own styles.
 *
 * NOT PERSISTED, and that is deliberate. localStorage is partitioned or blocked
 * outright in a third-party iframe, so a saved choice would apply for some viewers
 * and silently vanish for others. The initial state follows the operating system,
 * which needs no storage and is right more often than a remembered guess.
 *
 * Two buttons rather than one toggle: each side states which theme it selects, so
 * the control never has to be read as "what does pressing this do?". Selection is
 * shown by fill and by ink, not by colour hue alone.
 */
export function ThemeSwitch() {
  /* Dark to begin with -- the dashboard's long-standing look -- so neither side is
     ever momentarily unselected before the effect below reads the OS. */
  const [mode, setMode] = useState('dark');

  // matchMedia does not exist while server-rendering, so it is read in an effect
  // rather than during render.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    setMode(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.querySelector('.mon-root');
    if (root) root.setAttribute('data-mon-theme', mode);
  }, [mode]);

  return (
    <div className="mon-theme">
      {/* aria-label on the group rather than aria-labelledby + a static id: the id
          would be duplicated the moment two headers rendered at once. */}
      <span className="mon-theme-label">Theme</span>
      <div className="mon-theme-seg" role="group" aria-label="Theme">
        <button
          type="button"
          className="mon-theme-opt"
          aria-pressed={mode === 'light'}
          aria-label="Light theme"
          title="Light theme"
          onClick={() => setMode('light')}
        >
          <SunIcon />
        </button>
        <button
          type="button"
          className="mon-theme-opt"
          aria-pressed={mode === 'dark'}
          aria-label="Dark theme"
          title="Dark theme"
          onClick={() => setMode('dark')}
        >
          <MoonIcon />
        </button>
      </div>
    </div>
  );
}

/* ---------------- Header ---------------- */

export function MonitorHeader({ eyebrow, title, subtitle, syncState = 'synced' }) {
  const { date, time } = nowStamp();
  const saving = syncState === 'saving';

  return (
    <>
      <div className="mon-head">
        <div>
          <p className="mon-eyebrow">{eyebrow}</p>
          <h1 className="mon-title">{title}</h1>
          {subtitle ? <p className="mon-subtitle">{subtitle}</p> : null}
        </div>
        {/* SYNCED, with the theme switch directly beneath it. */}
        {/* Theme control on top, then the SYNCED stamp. */}
        <div className="mon-sync-group">
          <ThemeSwitch />
          <div className="mon-sync">
            <span className="mon-dot" data-state={saving ? 'saving' : undefined} aria-hidden="true" />
            <span className="mon-sync-label" data-state={saving ? 'saving' : undefined}>
              {saving ? 'SAVING' : 'SYNCED'}
            </span>
            <span className="mon-sync-stamp">
              {date}, {time}
            </span>
          </div>
        </div>
      </div>
      <div className="mon-rule" />
    </>
  );
}

/* ---------------- Sparkbars ---------------- */

/**
 * Tiny bar sparkline. `heights` sets the silhouette; `pct` decides how many bars
 * are lit, so the shape is decorative but the fill is always data-driven.
 */
export function SparkBars({ pct, color, heights = [16, 24, 30, 22, 12], small = false }) {
  const lit = litBars(pct, heights.length);
  return (
    <div className={small ? 'mon-sparks mon-sparks--sm' : 'mon-sparks'} aria-hidden="true">
      {heights.map((h, i) => (
        <div
          key={i}
          className="mon-spark"
          style={{ height: h, background: i < lit ? color : EMPTY_TRACK }}
        />
      ))}
    </div>
  );
}

/* ---------------- Stat cards ---------------- */

export function StatCards({ items }) {
  return (
    /* The modifier is the column count, so three cards fill the row instead of
       sitting in a four-column grid with a hole at the end. */
    <div className={`mon-stats mon-stats--${Math.min(Math.max(items.length, 3), 5)}`}>
      {items.map((item) => (
        <div className="mon-stat" key={item.label}>
          <p className="mon-stat-value" style={{ color: item.color }}>
            {item.value}
          </p>
          <p className="mon-stat-label">{item.label}</p>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Segmented bar + legend ---------------- */

/** `segments` = [{ label, value, color }]. Zero-value segments are skipped. */
export function SegmentedBar({ segments, total }) {
  const denom = total || segments.reduce((sum, s) => sum + s.value, 0) || 1;
  return (
    <>
      <div
        className="mon-segbar"
        role="img"
        aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(', ')}
      >
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <div key={s.label} style={{ width: `${(s.value / denom) * 100}%`, background: s.color }} />
          ))}
      </div>
      <div className="mon-legend">
        {segments.map((s) => (
          <span className="mon-legend-item" key={s.label}>
            <span className="mon-legend-swatch" style={{ background: s.color }} aria-hidden="true" />
            {s.label}
          </span>
        ))}
      </div>
    </>
  );
}

/** Big headline number with a sparkline above it. One per view. */
export function HeroFigure({ pct, color, caption, heights }) {
  return (
    <div className="mon-hero-left">
      <SparkBars pct={pct} color={color} heights={heights} />
      <p className="mon-hero-figure">{pct}%</p>
      <p className="mon-hero-caption">{caption}</p>
    </div>
  );
}

export function CountBreakdown({ counts }) {
  return (
    <div className="mon-counts">
      {counts.map((c) => (
        <div key={c.label}>
          <p className="mon-count-value" style={{ color: c.color }}>
            {c.value}
          </p>
          <p className="mon-count-label">{c.label}</p>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Filter row ---------------- */

export function SearchBox({ value, onChange, placeholder, icon }) {
  return (
    <div className="mon-search">
      {icon}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </div>
  );
}

export function PillGroup({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className="mon-pill"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

export function Select({ value, onChange, options, label }) {
  return (
    <select
      className="mon-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
    >
      {options.map((o) =>
        typeof o === 'string' ? (
          <option key={o} value={o}>
            {o}
          </option>
        ) : (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        )
      )}
    </select>
  );
}

/* ---------------- Table cells ---------------- */

/** Shown where a metric has no identified source yet -- never a fabricated 0. */
export function NoDataCell({ hint }) {
  return (
    <span className="mon-nodata" title={hint || 'No source table identified yet'}>
      --
    </span>
  );
}

export function ProgressCell({ done, total, pct, color, note, title }) {
  if (pct === null || pct === undefined) {
    return <NoDataCell hint="No media figure in this response" />;
  }
  return (
    <div className="mon-progress" title={title}>
      <div className="mon-progress-nums">
        <span className="mon-progress-done">
          {done}
          <span className="mon-progress-total">/{total}</span>
        </span>
        <span className="mon-progress-pct" style={{ color }}>
          {pct}%
        </span>
      </div>
      <div className="mon-progress-track">
        <div className="mon-progress-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      {note ? <p className="mon-progress-note">{note}</p> : null}
    </div>
  );
}

/**
 * Daily reports. `missedDays` is optional: no table defines the expected
 * reporting cadence, so rather than invent a "days missed" figure from a guessed
 * schedule, the sub-label falls back to the number of days actually reported.
 */
export function ReportsCell({ count, missedDays, reportDays }) {
  if (count === null || count === undefined)
    return <NoDataCell hint="No daily-report figure in this response" />;

  if (missedDays === null || missedDays === undefined) {
    return (
      <div className="mon-reports">
        <span className="mon-reports-value">{count}</span>
        <p className="mon-reports-sub" style={{ color: 'var(--mon-dim)' }}>
          {count === 0
            ? 'none submitted'
            : `on ${reportDays ?? count} day${(reportDays ?? count) === 1 ? '' : 's'}`}
        </p>
      </div>
    );
  }

  return (
    <div className="mon-reports">
      <span className="mon-reports-value">{count}</span>
      <p className="mon-reports-sub" style={{ color: missedDays > 0 ? 'var(--mon-danger)' : 'var(--mon-dim)' }}>
        {missedDays > 0 ? `${missedDays} day${missedDays === 1 ? '' : 's'} missed` : 'no gaps'}
      </p>
    </div>
  );
}

/**
 * Four milestone blocks + an "n/4 milestones" summary.
 *
 * Accepts live milestone objects ({label, pct, done, total, measurable}) or a
 * plain array of percentages. A milestone with `pct === null` is UNMEASURABLE,
 * not 0% -- M1 is document-based with no source, and nodes on a non-standard
 * checklist template have no mapped stages at all. Those render as an empty
 * track with an explanatory tooltip, and are excluded from the "n/4" count so a
 * node is never reported as behind on something that cannot be measured.
 */
/**
 * Milestone blocks: one per M1..M4, from TELAMON-ILA-TRACKER.
 *
 * A block is grey unless the tracker has completion for it. Nothing is inferred from
 * photos any more, so a node where no milestone has been created shows four grey
 * blocks and "0/4 milestones" -- no colour implying progress nobody recorded.
 *
 * The caption counts ALL defined milestones, not just the measurable ones. Counting
 * only measurable ones read "0/0 milestones" on a node with no tracker, and
 * "template not mapped" before that, which described the retired photolist rule
 * rather than anything the client would recognise.
 */
export function MilestoneCell({ milestones, colorFor }) {
  if (!milestones) return <NoDataCell hint="No milestone figures in this response" />;

  const items = milestones.map((m, i) =>
    typeof m === 'number'
      ? { label: `M${i + 1}`, pct: m, measurable: true }
      : { ...m, label: m.label || `M${i + 1}` }
  );

  const measurable = items.filter((m) => m.pct !== null && m.pct !== undefined);
  const done = measurable.filter((m) => m.pct === 100).length;
  const total = items.length;

  const tip = (m) => {
    if (m.pct === null || m.pct === undefined) {
      return `${m.label}${m.name ? ` (${m.name})` : ''}: no tracker tasks recorded`;
    }
    return `${m.label}${m.name ? ` (${m.name})` : ''}: ${m.pct}%${
      m.total ? ` -- ${m.done} of ${m.total} tracker tasks complete` : ''
    }`;
  };

  return (
    <div className="mon-miles">
      <div className="mon-miles-blocks">
        {items.map((m) => (
          <div
            key={m.label}
            className="mon-miles-block"
            title={tip(m)}
            style={{ background: m.pct === null || m.pct === undefined ? EMPTY_TRACK : colorFor(m.pct) }}
          />
        ))}
      </div>
      <p
        className="mon-miles-sub"
        style={{ color: total > 0 && done === total ? 'var(--mon-complete)' : 'var(--mon-dim)' }}
      >
        {total === 0 ? 'no milestones' : `${done}/${total} milestones`}
      </p>
    </div>
  );
}

/**
 * OVERALL: the blend of PHOTOS, DAILY REPORTS and MILESTONES.
 *
 * The columns that went in are named IN THE TOOLTIP, not in a caption under the
 * figure. The caption was a third line of small print in a row that already has two,
 * and on most rows it repeated what the neighbouring cells already show.
 */
export function OverallCell({ pct, color, parts = [] }) {
  if (pct === null || pct === undefined) {
    return <NoDataCell hint="No photo, report or milestone figures for this site" />;
  }

  const named = parts.filter((p) => p && p.label);
  const figures = named.map((p) => `${p.label} ${p.pct}%`).join(', ');
  const missing = 3 - named.length;
  const tip = !named.length
    ? undefined
    : missing === 0
      ? `${pct}% = the mean of ${figures}. All three columns are measured for this site.`
      : `${pct}% = ${named.length === 1 ? figures : `the mean of ${figures}`}. The other ` +
        `${missing === 1 ? 'column has' : `${missing} columns have`} no data for this site, so ` +
        `${missing === 1 ? 'it is' : 'they are'} left out rather than counted as zero.`;

  return (
    <div className="mon-overall" title={tip}>
      <SparkBars pct={pct} color={color} heights={[6, 10, 14, 9]} small />
      <span className="mon-overall-pct" style={{ color }}>
        {pct}%
      </span>
    </div>
  );
}

export function StatusPill({ status }) {
  return (
    <span className="mon-status" style={{ background: statusTint(status), color: statusColor(status) }}>
      {status}
    </span>
  );
}
