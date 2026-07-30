import { useState } from 'react';
import './monitor.css';
import RouteCompletionMonitor from './RouteCompletionMonitor';
import SiteCompletionMonitor from './SiteCompletionMonitor';
import { useLiveMonitor } from './hooks/useLiveMonitor';

/**
 * Shell for the two completion monitors.
 *
 * View state is in memory only -- no history.pushState, because an iframe shares
 * the top-level back/forward stack and pushing an entry per tab click would
 * hijack the parent page's back button.
 */
const VIEWS = [
  { id: 'site', label: 'SITE MONITOR', Component: SiteCompletionMonitor, kind: 'site' },
  { id: 'route', label: 'ROUTE MONITOR', Component: RouteCompletionMonitor, kind: 'route' },
];

/**
 * Resolve the starting view from ?view=site|route so each dashboard has its own
 * openable URL. Read once on mount; never written back (see note above).
 */
function initialViewFromUrl(fallback) {
  if (typeof window === 'undefined') return fallback;
  const requested = new URLSearchParams(window.location.search).get('view');
  return VIEWS.some((v) => v.id === requested) ? requested : fallback;
}

/** Scope params can be deep-linked too: ?siteId=... / ?nodeId=... / ?companyId=... */
function scopeFromUrl() {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const scope = {};
  for (const key of ['companyId', 'siteId', 'nodeId']) {
    const value = params.get(key);
    if (value) scope[key] = value;
  }
  return scope;
}

export default function MonitorApp({ initialView = 'site' }) {
  const [view, setView] = useState(() => initialViewFromUrl(initialView));
  const [scope] = useState(scopeFromUrl);

  const active = VIEWS.find((v) => v.id === view) || VIEWS[0];
  const Active = active.Component;

  const { data: live, error, loading } = useLiveMonitor(active.kind, scope);

  return (
    <div className="mon-root">
      <nav className="mon-nav" aria-label="Monitor views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className="mon-nav-btn"
            aria-current={v.id === view ? 'page' : undefined}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </nav>

      {/* Never let a live figure and a placeholder look equally trustworthy. */}
      {error ? (
        <div className="mon-notice" style={{ borderLeftColor: '#F0576E' }}>
          <div>
            <strong>Live data unavailable — showing sample data</strong>
            {error.message} Start the API with <code>cd backend &amp;&amp; npm run dev</code>.
          </div>
        </div>
      ) : loading ? (
        <div className="mon-notice">
          <div>
            <strong>Loading live Telamon data…</strong>
            Querying <code>ECSITE.ANALYTICS</code>.
          </div>
        </div>
      ) : (
        <div className="mon-notice" style={{ borderLeftColor: '#34E0A1' }}>
          <div>
            <strong>Partially live</strong>
            <span style={{ color: '#34E0A1' }}>LIVE from Snowflake:</span> header names (
            <code>Node Name</code> / <code>Site Name</code>), start date, company, and the status KPI
            card. <span style={{ color: '#F5B133' }}>Still sample data:</span> photos, daily reports,
            milestones and the document checklist — those need the source tables identified.
          </div>
        </div>
      )}

      <Active live={live} />
    </div>
  );
}
