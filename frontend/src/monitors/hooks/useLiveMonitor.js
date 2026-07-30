import { useEffect, useState } from 'react';
import { monitorApi } from '../data/monitorApi';

/**
 * Fetches the parts of each monitor that are wired to Snowflake today: the
 * header names and the status KPI card.
 *
 * Everything else on the page is still sample data. That split is surfaced
 * deliberately (see `liveFields`) so a real figure and a placeholder are never
 * presented as if they carry the same weight.
 */
export function useLiveMonitor(kind, scope = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const key = JSON.stringify({ kind, scope });

  useEffect(() => {
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));

    const fetcher = kind === 'site' ? monitorApi.site : monitorApi.route;

    fetcher(scope, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ data, error: null, loading: false });
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setState({ data: null, error: err, loading: false });
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on serialised scope
  }, [key]);

  return state;
}
