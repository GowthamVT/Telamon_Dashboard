import { useState } from 'react';
import './monitor.css';
import RouteCompletionMonitor from './RouteCompletionMonitor';
import SiteCompletionMonitor from './SiteCompletionMonitor';
import { ScopePicker } from './components/ScopePicker';
import { useHierarchy } from './hooks/useHierarchy';
import { useLiveMonitor } from './hooks/useLiveMonitor';

/**
 * Shell for the two completion monitors.
 *
 * View and scope state are in memory only -- no history.pushState, because an
 * iframe shares the top-level back/forward stack and pushing an entry per
 * selection would hijack the parent page's back button. URLs are read on load
 * for deep-linking, never written back.
 */
const VIEWS = [
  { id: 'site', label: 'SITE MONITOR', Component: SiteCompletionMonitor, kind: 'site' },
  { id: 'route', label: 'ROUTE MONITOR', Component: RouteCompletionMonitor, kind: 'route' },
];

function initialViewFromUrl(fallback) {
  if (typeof window === 'undefined') return fallback;
  const requested = new URLSearchParams(window.location.search).get('view');
  return VIEWS.some((v) => v.id === requested) ? requested : fallback;
}

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
  const [scope, setScope] = useState(scopeFromUrl);

  const active = VIEWS.find((v) => v.id === view) || VIEWS[0];
  const Active = active.Component;

  const hierarchy = useHierarchy();
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

      <ScopePicker
        tree={hierarchy.tree}
        scope={scope}
        onChange={setScope}
        loading={hierarchy.loading}
        error={hierarchy.error}
      />

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
            <span style={{ color: '#34E0A1' }}>LIVE:</span> header names, start date, company, the
            Company&nbsp;›&nbsp;Site&nbsp;›&nbsp;Node hierarchy, and the status KPI (company-level —
            it does not shrink as you drill).{' '}
            <span style={{ color: '#F5B133' }}>Sample data:</span> photos, daily reports, milestones
            and the document checklist — still need source tables.
          </div>
        </div>
      )}

      <Active live={live} />
    </div>
  );
}
