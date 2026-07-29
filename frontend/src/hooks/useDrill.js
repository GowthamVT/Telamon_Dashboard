import { useCallback, useMemo, useState } from 'react';

/**
 * Drill state.
 *
 * The model is a stack of crumbs: [{ dimension, label, value }]. It drives three
 * interactions with one data structure:
 *
 *   drill DOWN     push a crumb -> group by the next dimension in the path
 *   drill UP       truncate the stack at any crumb (that is what the breadcrumb
 *                  bar clicks do), which is why "up" needs no separate history
 *   drill THROUGH  keep the crumbs, switch the view to raw rows
 *
 * Crumbs convert directly into ordinary API filters, so the server stays
 * stateless: every level is just another cached query with more WHERE clauses.
 *
 * State lives in memory only -- no localStorage, no history.pushState. Both
 * break or misbehave in a cross-origin iframe (storage partitioning; a shared
 * top-level history stack). See the notes in api/client.js.
 */
export function useDrill(drillPath = []) {
  const [crumbs, setCrumbs] = useState([]);
  const [detailOpen, setDetailOpen] = useState(false);

  /** Dimension to group by at the current depth; null once the path is exhausted. */
  const currentDimension = useMemo(() => {
    if (drillPath.length === 0) return null;
    return crumbs.length < drillPath.length ? drillPath[crumbs.length] : null;
  }, [drillPath, crumbs.length]);

  const canDrillDeeper = crumbs.length < drillPath.length - 1;

  /** Crumbs as API filters: { dimensionKey: [value] }. */
  const drillFilters = useMemo(() => {
    const filters = {};
    for (const crumb of crumbs) filters[crumb.dimension] = [crumb.value];
    return filters;
  }, [crumbs]);

  const drillDown = useCallback(
    (crumb) => {
      // Guard against a click on the deepest level pushing past the path.
      setCrumbs((prev) => (prev.length >= drillPath.length ? prev : [...prev, crumb]));
    },
    [drillPath.length]
  );

  /** Truncate to `depth` crumbs. depth 0 returns to the top level. */
  const drillUpTo = useCallback((depth) => {
    setCrumbs((prev) => (depth >= prev.length ? prev : prev.slice(0, depth)));
    setDetailOpen(false);
  }, []);

  const reset = useCallback(() => {
    setCrumbs([]);
    setDetailOpen(false);
  }, []);

  return {
    crumbs,
    currentDimension,
    canDrillDeeper,
    drillFilters,
    drillDown,
    drillUpTo,
    reset,
    detailOpen,
    openDetail: useCallback(() => setDetailOpen(true), []),
    closeDetail: useCallback(() => setDetailOpen(false), []),
  };
}
