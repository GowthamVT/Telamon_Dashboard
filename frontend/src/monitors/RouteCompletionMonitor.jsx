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
  milestoneColor,
  pctColor,
  STATUS,
  STATUS_COLORS,
  statusColor,
} from './lib/status';
import { loadRouteMonitor } from './data/routeMock';

/**
 * The date under a site name means a different thing in each status, so the word in
 * front of it changes with the status rather than being left to the reader to guess.
 */
const DATE_WORD = {
  completed: 'Completed ',
  inProgress: 'In progress ',
  start: 'Started ',
};

const DATE_TITLE = {
  completed: (d) => `COP approved ${d}`,
  inProgress: (d) => `In progress since ${d}`,
  start: (d) => `Site start date ${d}`,
};

/*
 * Resolve the kind DEFENSIVELY. A row without `startKind` -- the sample data had none --
 * previously indexed these maps with undefined and called it, which threw and left the
 * whole tab blank. A missing label must degrade to "Started", never take the page down.
 */
function dateKind(kind) {
  return DATE_WORD[kind] ? kind : 'start';
}

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

  /*
   * "sites", not "nodes" -- the picker's vocabulary. routeCount counts routes and
   * nodeCount counts sites; see the note in ScopePicker on why the field names stay
   * one step out of step with the labels.
   */
  const subtitle = live?.route
    ? isAggregate
      ? `${live.route.routeCount} routes · ${live.route.nodeCount} sites · ${companyLabel}`
      : `${live.route.nodeCount} sites · ${companyLabel}`
    : `${summary.total} sites`;


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
        photoPct: summary.avgPhotoPct,
      };
    }
    const withReports = rows.filter((r) => r.reports !== null && r.reports !== undefined);
    // Pooled (total covered / total applicable), not a mean of per-node percentages:
    // averaging would weight a 1-field node the same as a 380-field one.
    const covered = rows.reduce((sum, r) => sum + (r.photosUploaded || 0), 0);
    const defined = rows.reduce((sum, r) => sum + (r.photosTotal || 0), 0);

    return {
      reports: withReports.reduce((sum, r) => sum + r.reports, 0),
      reportDays: withReports.reduce((sum, r) => sum + (r.reportDays || 0), 0),
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
        {/* Card label removed by request. The header above already names the company
            and the node count, and the picker says which scope is selected. */}
        <div className="mon-hero">
          <HeroFigure
            pct={totals.photoPct === null ? 0 : totals.photoPct}
            color={pctColor(totals.photoPct === null ? 0 : totals.photoPct)}
            /*
             * Label only -- the raw counts used to be appended here
             * ("(4379/24091)") and read as clutter at company scope. The
             * per-node PHOTOS column and its tooltip still carry the numbers for
             * anyone who needs to audit the percentage.
             */
            caption="ROUTE AVG. PHOTO COMPLETION"
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
            {/* Sub-note removed by request. NOTE: it was the only place stating that
                nodes with no status history are counted as Yet to Start. */}
          </div>
        </div>
      </div>

      <StatCards
        items={[
          // Live: the number of nodes in the current Company > Site > Node scope,
          // so it tracks the selection (198 all Telamon -> 16 one route -> 1 node).
          { label: 'TOTAL SITES', value: kpiTotal, color: 'var(--mon-text-bright)' },
          {
            label: 'PHOTOS UPLOADED %',
            value: totals.photoPct === null ? '--' : `${totals.photoPct}%`,
            color: totals.photoPct === null ? 'var(--mon-dim)' : pctColor(totals.photoPct),
          },
          // Live: summed from the rows in scope.
          { label: 'DAILY REPORTS SUBMITTED', value: totals.reports, color: 'var(--mon-text-bright)' },
          /* MISSED REPORT DAYS removed by request. The per-row DAILY REPORTS cell
             still shows each site's missed days, so the figure is not lost. */
        ]}
      />

      {/* One filter row scoping everything below it. */}
      <div className="mon-filters">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search site name..."
          icon={<Search size={15} color="var(--mon-dim)" aria-hidden="true" />}
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
                <p className="mon-cell-sub" title={DATE_TITLE[dateKind(site.startKind)](site.start)}>
                  {/* The word matters: these are three different moments and a bare date
                      cannot tell them apart. */}
                  {DATE_WORD[dateKind(site.startKind)]}
                  {site.start}
                  {site.duration ? ` · ${site.duration}` : ''}
                </p>
                {showRouteOnRows && site.routeName ? (
                  <p className="mon-cell-sub" style={{ color: 'var(--mon-notstarted)' }}>
                    {site.routeName}
                  </p>
                ) : null}
              </div>
              <ProgressCell
                done={site.photosUploaded}
                total={site.photosTotal}
                pct={site.photosPct}
                color={statusColor(site.status)}
                /* No sub-note: the raw photo count duplicated the denominator's story
                   and is in the tooltip, which also carries the approval figures. */
                note={null}
                title={
                  site.photoCount === null
                    ? undefined
                    : `${site.photosUploaded} of ${site.photosTotal} photo fields need no photo` +
                      (site.naFields
                        ? ` (${site.naFields} of them marked N/A, which count as satisfied).`
                        : '.') +
                      ` ${site.photoCount} photos in total, ${site.approvedMedia} approved` +
                      (site.mediaApprovedPct === null ? '.' : ` (${site.mediaApprovedPct}%).`) +
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
