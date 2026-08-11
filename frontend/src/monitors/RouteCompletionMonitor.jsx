import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import {
  CountBreakdown,
  HeroFigure,
  MilestoneCell,
  MonitorHeader,
  OverallCell,
  PillGroup,
  ProgressCell,
  ReportsCell,
  SearchBox,
  SegmentedBar,
  Select,
  StatCards,
  StatusPill,
} from './components/primitives';
import { filterSites, rowsFromNodes, summarise } from './lib/routeModel';
import {
  DANGER,
  describeStatusScope,
  milestoneColor,
  pctColor,
  STATUS,
  STATUS_COLORS,
  statusColor,
} from './lib/status';
import { loadRouteMonitor } from './data/routeMock';

/** Column widths for the site table, matching the reference layout. */
const COLS = '1.8fr 1.1fr 1.1fr 1.1fr 1fr 1.1fr';

const STATUS_FILTERS = ['All', STATUS.COMPLETE, STATUS.IN_PROGRESS, STATUS.YET_TO_START];
const SORT_OPTIONS = ['Site name', 'Overall', 'Start date'];

/**
 * Route Completion Monitor: one row per site across a route.
 *
 * `data` is injectable so this renders identically from mock data or from the
 * API. Everything below the header is derived in lib/routeModel.js.
 */
export default function RouteCompletionMonitor({ data = loadRouteMonitor(), live = null }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('All');
  const [sort, setSort] = useState('Site name');

  const summary = useMemo(() => summarise(data.sites), [data.sites]);

  // Live CLOUD_NODE rows when available, sample rows otherwise. Live rows carry
  // real name/date/status; their unsourced metrics stay NULL and render as "--".
  const isLive = Array.isArray(live?.nodes) && live.nodes.length > 0;
  const rows = useMemo(
    () => (isLive ? rowsFromNodes(live.nodes) : summary.sites),
    [isLive, live, summary.sites]
  );

  const visible = useMemo(
    () => filterSites(rows, { query, status, sort }),
    [rows, query, status, sort]
  );

  /**
   * Node names are NOT unique across Telamon -- "Alexander City" exists on two
   * routes, "Greensburg" on five, "Bowling Green" on three. When the current
   * scope spans more than one route, show the route on each row so identically
   * named nodes can be told apart.
   */
  const showRouteOnRows = useMemo(
    () => new Set(rows.map((r) => r.routeName).filter(Boolean)).size > 1,
    [rows]
  );

  /*
   * Header label. When the picker is on "All sites" there is no single route to
   * name, so the title says so rather than naming whichever route came back
   * first -- the backend sends name:null in that case.
   */
  const isAggregate = live?.route?.aggregate === true;
  const routeName = isAggregate ? 'ALL SITES' : live?.route?.name || data.route.name;
  const kpi = live?.statusCounts || null;
  const complete = kpi ? kpi.complete : summary.complete;
  const inProgress = kpi ? kpi.inProgress : summary.inProgress;
  const yetToStart = kpi ? kpi.yetToStart : summary.yetToStart;
  const kpiTotal = kpi ? kpi.total : summary.total;

  const companyLabel = live?.route
    ? live.route.companyName || `${live.route.companyCount} companies`
    : null;

  const subtitle = live?.route
    ? isAggregate
      ? `${live.route.routeCount} sites · ${live.route.nodeCount} nodes · ${companyLabel}`
      : `${live.route.nodeCount} nodes · ${companyLabel}`
    : `${summary.total} sites`;

  const scopeNote = describeStatusScope(kpi);

  /**
   * Card totals, summed from the SAME rows the table renders, so the card can
   * never disagree with the list beneath it.
   *
   * Summed over all rows in scope rather than the filtered `visible` set, to
   * match how TOTAL SITES behaves -- the cards describe the selection, the
   * search box only narrows what is listed.
   */
  const totals = useMemo(() => {
    if (!isLive) {
      return {
        reports: summary.totalReports,
        missedDays: summary.totalMissedDays,
        photoPct: summary.avgPhotoPct,
      };
    }
    const withReports = rows.filter((r) => r.reports !== null && r.reports !== undefined);
    const withMissed = rows.filter((r) => r.missedDays !== null && r.missedDays !== undefined);
    // Photo % is pooled (total covered / total defined), not a mean of per-node
    // percentages: averaging percentages would weight a 1-field node the same as
    // a 165-field one.
    const covered = rows.reduce((sum, r) => sum + (r.photosUploaded || 0), 0);
    const defined = rows.reduce((sum, r) => sum + (r.photosTotal || 0), 0);

    return {
      reports: withReports.reduce((sum, r) => sum + r.reports, 0),
      reportDays: withReports.reduce((sum, r) => sum + (r.reportDays || 0), 0),
      // Summed only over nodes that HAVE a reporting window; nodes that never
      // reported contribute nothing rather than a fabricated zero.
      missedDays: withMissed.length ? withMissed.reduce((sum, r) => sum + r.missedDays, 0) : null,
      nodesWithWindow: withMissed.length,
      nodesReporting: withReports.filter((r) => r.reports > 0).length,
      photoPct: defined > 0 ? Math.round((covered / defined) * 100) : null,
      photoCovered: covered,
      photoDefined: defined,
    };
  }, [isLive, rows, summary]);

  return (
    <div className="mon-shell">
      <MonitorHeader
        eyebrow="ROUTE COMPLETION MONITOR"
        title={routeName}
        subtitle={subtitle}
      />

      {/* Hero: route-average completion + node status breakdown. */}
      <div className="mon-card">
        {scopeNote ? (
          <p className="mon-card-label">
            NODE STATUS — {String(scopeNote.label || 'company').toUpperCase()} · {scopeNote.total}{' '}
            NODES ({scopeNote.level})
          </p>
        ) : null}
        <div className="mon-hero">
          <HeroFigure
            pct={totals.photoPct === null ? 0 : totals.photoPct}
            color={pctColor(totals.photoPct === null ? 0 : totals.photoPct)}
            caption={
              totals.photoDefined
                ? `PHOTO FIELDS COVERED (${totals.photoCovered}/${totals.photoDefined})`
                : 'ROUTE AVG. PHOTO COMPLETION'
            }
          />
          <div className="mon-hero-right">
            <CountBreakdown
              counts={[
                { label: 'Complete', value: complete, color: statusColor(STATUS.COMPLETE) },
                { label: 'In Progress', value: inProgress, color: statusColor(STATUS.IN_PROGRESS) },
                { label: 'Yet to Start', value: yetToStart, color: statusColor(STATUS.YET_TO_START) },
              ]}
            />
            <SegmentedBar
              total={kpiTotal}
              segments={[
                { label: 'Complete', value: complete, color: STATUS_COLORS[STATUS.COMPLETE].fg },
                { label: 'In Progress', value: inProgress, color: STATUS_COLORS[STATUS.IN_PROGRESS].fg },
                { label: 'Yet to Start', value: yetToStart, color: STATUS_COLORS[STATUS.YET_TO_START].fg },
              ]}
            />
            {scopeNote ? (
              <p className="mon-cell-sub" style={{ marginTop: 10 }}>
                Latest status per node, {scopeNote.level}
                {scopeNote.noHistory > 0
                  ? ` · ${scopeNote.noHistory} of ${scopeNote.total} nodes have no status history and are counted as Yet to Start`
                  : ''}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <StatCards
        items={[
          // Live: the number of nodes in the current Company > Site > Node scope,
          // so it tracks the selection (198 all Telamon -> 16 one route -> 1 node).
          { label: 'TOTAL SITES', value: kpiTotal, color: '#F7F8FB' },
          {
            label: 'PHOTOS UPLOADED %',
            value: totals.photoPct === null ? '--' : `${totals.photoPct}%`,
            color: totals.photoPct === null ? '#5A6478' : pctColor(totals.photoPct),
          },
          // Live: summed from the rows in scope.
          { label: 'DAILY REPORTS SUBMITTED', value: totals.reports, color: '#F7F8FB' },
          {
            label: 'MISSED REPORT DAYS',
            value: totals.missedDays === null ? '--' : totals.missedDays,
            color:
              totals.missedDays === null
                ? '#5A6478'
                : totals.missedDays > 0
                  ? DANGER
                  : statusColor(STATUS.COMPLETE),
          },
        ]}
      />

      {/* One filter row scoping everything below it. */}
      <div className="mon-filters">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search site name..."
          icon={<Search size={15} color="#5A6478" aria-hidden="true" />}
        />
        <PillGroup options={STATUS_FILTERS} value={status} onChange={setStatus} label="Filter by status" />
        <Select value={sort} onChange={setSort} options={SORT_OPTIONS} label="Sort sites by" />
      </div>

      <div className="mon-table">
        {/* Column widths live on the scroll container so the header and every row
            inherit one definition and can never drift apart. */}
        <div className="mon-table-scroll" style={{ '--mon-cols': COLS }}>
          <div className="mon-grid mon-thead" role="row">
            <div role="columnheader">SITE</div>
            <div role="columnheader">PHOTOS</div>
            <div role="columnheader">DAILY REPORTS</div>
            <div role="columnheader">MILESTONES</div>
            <div role="columnheader">OVERALL</div>
            <div role="columnheader">STATUS</div>
          </div>

          {visible.map((site) => (
            <div className="mon-grid mon-trow" key={site.nodeId || site.name} role="row">
              <div>
                <p className="mon-cell-title">{site.name}</p>
                <p className="mon-cell-sub">
                  {site.start}
                  {site.duration ? ` · ${site.duration}` : ''}
                  {site.rawStatus ? ` · ${site.rawStatus}` : ''}
                </p>
                {showRouteOnRows && site.routeName ? (
                  <p className="mon-cell-sub" style={{ color: '#4C8DFF' }}>
                    {site.routeName}
                  </p>
                ) : null}
              </div>
              <ProgressCell
                done={site.photosUploaded}
                total={site.photosTotal}
                pct={site.photosPct}
                color={statusColor(site.status)}
                note={site.photoCount === null ? null : `${site.photoCount} photos`}
                title={
                  site.photoCount === null
                    ? undefined
                    : `${site.photoCount} photos uploaded. ${site.photosUploaded} of ${site.photosTotal} photo fields complete` +
                      (site.naFields
                        ? ` (${site.naFields} of ${site.photoFieldsDefined} marked N/A and excluded).`
                        : '.') +
                      (site.photoPctApproximate
                        ? ' Coverage is approximate for this node -- no per-field data.'
                        : '')
                }
              />
              <ReportsCell
                count={site.reports}
                missedDays={site.missedDays}
                reportDays={site.reportDays}
              />
              <MilestoneCell
                milestones={site.milestones}
                colorFor={milestoneColor}
                mapped={site.milestonesMapped !== false}
              />
              <OverallCell pct={site.photosPct} color={statusColor(site.status)} />
              <div>
                <StatusPill status={site.status} />
              </div>
            </div>
          ))}

          {visible.length === 0 ? (
            <div className="mon-empty-row">
              No sites match {query ? `"${query}"` : 'the current filters'}.
            </div>
          ) : null}
        </div>
      </div>

      <p className="mon-foot">
        {/* Denominator is the rows actually in scope, not the sample count. */}
        {visible.length} of {rows.length} sites shown
      </p>
    </div>
  );
}
