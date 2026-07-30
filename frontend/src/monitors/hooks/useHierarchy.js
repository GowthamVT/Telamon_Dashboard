import { useEffect, useState } from 'react';
import { monitorApi } from '../data/monitorApi';

/**
 * Loads the Company > Site > Node tree once, for the scope pickers.
 *
 * Fetched at company scope (not the current selection) so the pickers always
 * offer every sibling -- otherwise drilling into a site would remove the other
 * sites from the dropdown and strand the user there.
 */
export function useHierarchy(companyPattern) {
  const [state, setState] = useState({ tree: null, error: null, loading: true });

  useEffect(() => {
    const controller = new AbortController();
    const scope = companyPattern ? { company: companyPattern } : {};

    monitorApi
      .hierarchy(scope, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ tree: data, error: null, loading: false });
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setState({ tree: null, error: err, loading: false });
      });

    return () => controller.abort();
  }, [companyPattern]);

  return state;
}
