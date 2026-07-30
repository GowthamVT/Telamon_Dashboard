import { useMemo } from 'react';

/**
 * Company > Site > Node scope selector.
 *
 * Selecting a level clears the levels BELOW it: a nodeId that belonged to the
 * previous site would otherwise survive the change and silently contradict the
 * new selection.
 *
 * The status KPI card deliberately does not shrink as you drill -- it is a
 * company-level figure. Only the header and (later) the per-node metrics follow
 * the selection.
 */
const NO_COMPANIES = [];

export function ScopePicker({ tree, scope, onChange, loading, error }) {
  // Stable identity: `tree?.companies || []` would allocate a new array on every
  // render and invalidate the memos below.
  const companies = tree?.companies ?? NO_COMPANIES;

  const selectedCompany = useMemo(
    () => companies.find((c) => c.companyId === scope.companyId) || null,
    [companies, scope.companyId]
  );

  // With no company chosen, offer every site across the group so the picker is
  // never a dead end.
  const sites = useMemo(() => {
    if (selectedCompany) return selectedCompany.sites;
    return companies.flatMap((c) => c.sites);
  }, [companies, selectedCompany]);

  const selectedSite = useMemo(
    () => sites.find((s) => s.siteId === scope.siteId) || null,
    [sites, scope.siteId]
  );

  const nodes = selectedSite ? selectedSite.nodes : [];

  if (error) {
    return (
      <div className="mon-scopebar">
        <span className="mon-scope-note" style={{ color: '#F0576E' }}>
          Hierarchy unavailable — {error.message}
        </span>
      </div>
    );
  }

  return (
    <div className="mon-scopebar" role="group" aria-label="Company, site and node scope">
      <label className="mon-scope-field">
        <span className="mon-scope-label">COMPANY</span>
        <select
          className="mon-select"
          value={scope.companyId || ''}
          disabled={loading}
          onChange={(e) =>
            // Clearing site+node: they belong to the old company.
            onChange({ companyId: e.target.value || undefined, siteId: undefined, nodeId: undefined })
          }
        >
          <option value="">All Telamon ({tree?.totals?.companies ?? '…'})</option>
          {companies.map((c) => (
            <option key={c.companyId} value={c.companyId}>
              {c.companyName} ({c.nodeCount} nodes)
            </option>
          ))}
        </select>
      </label>

      <span className="mon-scope-sep" aria-hidden="true">
        ›
      </span>

      <label className="mon-scope-field">
        <span className="mon-scope-label">SITE / ROUTE</span>
        <select
          className="mon-select"
          value={scope.siteId || ''}
          disabled={loading || sites.length === 0}
          onChange={(e) =>
            onChange({ ...scope, siteId: e.target.value || undefined, nodeId: undefined })
          }
        >
          <option value="">All sites ({sites.length})</option>
          {sites.map((s) => (
            <option key={s.siteId} value={s.siteId}>
              {s.siteName} ({s.nodes.length})
            </option>
          ))}
        </select>
      </label>

      <span className="mon-scope-sep" aria-hidden="true">
        ›
      </span>

      <label className="mon-scope-field">
        <span className="mon-scope-label">NODE</span>
        <select
          className="mon-select"
          value={scope.nodeId || ''}
          disabled={loading || nodes.length === 0}
          onChange={(e) => onChange({ ...scope, nodeId: e.target.value || undefined })}
        >
          <option value="">{selectedSite ? `All nodes (${nodes.length})` : 'Select a site first'}</option>
          {nodes.map((n) => (
            <option key={n.nodeId} value={n.nodeId}>
              {n.nodeName}
            </option>
          ))}
        </select>
      </label>

      {tree?.totals ? (
        <span className="mon-scope-note">
          {tree.totals.companies} companies · {tree.totals.sites} sites · {tree.totals.nodes} nodes
        </span>
      ) : null}
    </div>
  );
}
