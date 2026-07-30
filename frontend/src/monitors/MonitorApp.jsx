import { useState } from 'react';
import './monitor.css';
import RouteCompletionMonitor from './RouteCompletionMonitor';
import SiteCompletionMonitor from './SiteCompletionMonitor';

/**
 * Shell for the two completion monitors.
 *
 * View state is in memory only -- no history.pushState, because an iframe shares
 * the top-level back/forward stack and pushing an entry per tab click would
 * hijack the parent page's back button.
 */
const VIEWS = [
  { id: 'route', label: 'ROUTE MONITOR', Component: RouteCompletionMonitor },
  { id: 'site', label: 'SITE MONITOR', Component: SiteCompletionMonitor },
];

export default function MonitorApp({ showDataNotice = true }) {
  const [view, setView] = useState('route');
  const active = VIEWS.find((v) => v.id === view) || VIEWS[0];
  const Active = active.Component;

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

      {showDataNotice ? (
        <div className="mon-notice">
          <div>
            <strong>Rendering from mock data</strong>
            Layout and all derived figures are final. Point each visual at Snowflake by replacing{' '}
            <code>loadRouteMonitor()</code> / <code>loadSiteMonitor()</code> in{' '}
            <code>src/monitors/data/</code> — see <code>src/monitors/DATA_REQUIREMENTS.md</code> for the
            fields each visual needs.
          </div>
        </div>
      ) : null}

      <Active />
    </div>
  );
}
