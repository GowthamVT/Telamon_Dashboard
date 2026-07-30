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
import { filterSites, summarise } from './lib/routeModel';
import {
  DANGER,
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
  const visible = useMemo(
    () => filterSites(summary.sites, { query, status, sort }),
    [summary.sites, query, status, sort]
  );

  // Live values win where they exist; sample data fills the rest.
  const routeName = live?.route?.name || data.route.name;
  const kpi = live?.statusCounts || null;
  const complete = kpi ? kpi.complete : summary.complete;
  const inProgress = kpi ? kpi.inProgress : summary.inProgress;
  const yetToStart = kpi ? kpi.yetToStart : summary.yetToStart;
  const kpiTotal = kpi ? kpi.total : summary.total;

  const subtitle = live?.route
    ? `${live.route.nodeCount} sites · ${live.route.companyName}`
    : `${summary.total} sites`;

  return (
    <div className="mon-shell">
      <MonitorHeader
        eyebrow="ROUTE COMPLETION MONITOR"
        title={routeName}
        subtitle={subtitle}
      />

      {/* Hero: route-average completion + status breakdown.
          The two halves are at DIFFERENT scopes on purpose -- the figure on the
          left is this route, the counts on the right are the whole company -- so
          the right-hand side is labelled explicitly rather than left to inference. */}
      <div className="mon-card">
        {kpi ? (
          <p className="mon-card-label">
            SITE STATUS — {String(kpi.scopeLabel || 'company').toUpperCase()}, ALL {kpiTotal} SITES
          </p>
        ) : null}
        <div className="mon-hero">
          <HeroFigure
            pct={summary.avgPhotoPct}
            color={pctColor(summary.avgPhotoPct)}
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
            {kpi ? (
              <p className="mon-cell-sub" style={{ marginTop: 10 }}>
                Company-level · {kpiTotal} sites by latest status · unaffected by the site/node
                selection
                {kpi.complete === 0 ? ' · no "Complete" status exists in the source data' : ''}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <StatCards
        items={[
          { label: 'TOTAL SITES', value: summary.total, color: '#F7F8FB' },
          { label: 'PHOTOS UPLOADED %', value: `${summary.avgPhotoPct}%`, color: pctColor(summary.avgPhotoPct) },
          { label: 'DAILY REPORTS SUBMITTED', value: summary.totalReports, color: '#F7F8FB' },
          {
            label: 'MISSED REPORT DAYS',
            value: summary.totalMissedDays,
            color: summary.totalMissedDays > 0 ? DANGER : statusColor(STATUS.COMPLETE),
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
            <div className="mon-grid mon-trow" key={site.name} role="row">
              <div>
                <p className="mon-cell-title">{site.name}</p>
                <p className="mon-cell-sub">
                  {site.start} · {site.duration}
                </p>
              </div>
              <ProgressCell
                done={site.photosUploaded}
                total={site.photosTotal}
                pct={site.photosPct}
                color={statusColor(site.status)}
              />
              <ReportsCell count={site.reports} missedDays={site.missedDays} />
              <MilestoneCell milestones={site.milestones} colorFor={milestoneColor} />
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
        {visible.length} of {summary.total} sites shown
      </p>
    </div>
  );
}
