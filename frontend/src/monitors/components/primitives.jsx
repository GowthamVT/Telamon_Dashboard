/**
 * Presentational primitives shared by both monitors.
 *
 * Every one of these is pure: it takes already-derived numbers and renders them.
 * No component here fetches, so swapping mock data for Snowflake later touches
 * only the container modules.
 */
import { EMPTY_TRACK, litBars, nowStamp, statusColor, statusTint } from '../lib/status';

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
    <div className={`mon-stats mon-stats--${items.length >= 5 ? 5 : 4}`}>
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

export function ProgressCell({ done, total, pct, color }) {
  if (pct === null || pct === undefined) return <NoDataCell hint="Photo counts: source not yet identified" />;
  return (
    <div className="mon-progress">
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
    </div>
  );
}

export function ReportsCell({ count, missedDays }) {
  if (count === null || count === undefined)
    return <NoDataCell hint="Daily reports: source not yet identified" />;
  return (
    <div className="mon-reports">
      <span className="mon-reports-value">{count}</span>
      <p className="mon-reports-sub" style={{ color: missedDays > 0 ? '#F0576E' : '#5A6478' }}>
        {missedDays > 0 ? `${missedDays} day${missedDays === 1 ? '' : 's'} missed` : 'no gaps'}
      </p>
    </div>
  );
}

/** Four milestone blocks + an "n/4 milestones" summary. */
export function MilestoneCell({ milestones, colorFor }) {
  if (!milestones) return <NoDataCell hint="Milestones: source not yet identified" />;
  const done = milestones.filter((m) => m === 100).length;
  return (
    <div className="mon-miles">
      <div className="mon-miles-blocks">
        {milestones.map((pct, i) => (
          <div
            key={i}
            className="mon-miles-block"
            title={`M${i + 1}: ${pct}%`}
            style={{ background: colorFor(pct) }}
          />
        ))}
      </div>
      <p
        className="mon-miles-sub"
        style={{ color: done === milestones.length ? '#34E0A1' : '#5A6478' }}
      >
        {done}/{milestones.length} milestones
      </p>
    </div>
  );
}

export function OverallCell({ pct, color }) {
  if (pct === null || pct === undefined) return <NoDataCell hint="Derived from photo counts" />;
  return (
    <div className="mon-overall">
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
