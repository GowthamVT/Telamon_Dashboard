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

      {/*
        Only the states the reader must act on.
        The steady-state "Partially live" banner is gone: it listed what was and
        was not sourced, and had drifted out of date twice -- it still named
        CLOUD_ECSITE_S3DOCUMENT and claimed the N/A flag was unsourced after both
        had changed. A caveat that goes stale is worse than none, and the
        remaining ones now live next to the figures they qualify.

        The error state stays. A live figure and a placeholder must never look
        equally trustworthy, so the reader has to be told when they are seeing
        sample data.
      */}
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
            Querying the ECSite MongoDB cluster.
          </div>
        </div>
      ) : null}

      <Active live={live} />
    </div>
  );
}
