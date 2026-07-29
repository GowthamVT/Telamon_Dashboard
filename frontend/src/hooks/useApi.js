import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fetch-on-dependency-change hook with three behaviours the dashboard needs:
 *
 *  - Aborts the in-flight request when deps change, so fast filter clicks cannot
 *    land out of order and paint a stale result over a newer one.
 *  - Keeps the previous data during a refetch (`isRefetching`) so the UI can dim
 *    the old render instead of flashing a skeleton and jumping layout.
 *  - Never sets state after unmount.
 *
 * `deps` is serialised to JSON for comparison, which lets callers pass request
 * objects inline without memoising them by hand.
 */
export function useApi(fetcher, deps, { enabled = true } = {}) {
  const [state, setState] = useState({
    data: null,
    error: null,
    isLoading: enabled,
    isRefetching: false,
    cacheHit: false,
  });

  const key = JSON.stringify(deps ?? null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const mounted = useRef(true);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState((s) => ({ ...s, isLoading: false, isRefetching: false }));
      return undefined;
    }

    const controller = new AbortController();

    setState((s) => ({
      ...s,
      // First load shows a real loading state; later loads dim the old data.
      isLoading: s.data === null,
      isRefetching: s.data !== null,
      error: null,
    }));

    fetcherRef
      .current({ signal: controller.signal })
      .then(({ data, cacheHit }) => {
        if (!mounted.current || controller.signal.aborted) return;
        setState({ data, error: null, isLoading: false, isRefetching: false, cacheHit });
      })
      .catch((err) => {
        if (!mounted.current || err.name === 'AbortError') return;
        setState((s) => ({
          ...s,
          error: err,
          isLoading: false,
          isRefetching: false,
        }));
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on serialised deps
  }, [key, enabled, reloadToken]);

  const refetch = useCallback(() => setReloadToken((t) => t + 1), []);

  return { ...state, refetch };
}
