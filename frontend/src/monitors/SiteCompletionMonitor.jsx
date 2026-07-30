import { useMemo, useState } from 'react';
import { Circle, CircleCheck, CircleMinus, Search } from 'lucide-react';
import {
  CountBreakdown,
  MonitorHeader,
  PillGroup,
  SearchBox,
  Select,
  StatCards,
} from './components/primitives';
import { filterItems, ITEM_STATUS, siteStatus, summarise } from './lib/siteModel';
import {
  DANGER,
  pctColor,
  progressColor,
  STATUS,
  statusColor,
  percent,
} from './lib/status';
import { loadSiteMonitor } from './data/siteMock';

const COLS = '0.55fr 3fr 1.2fr';

const STATUS_FILTERS = ['All', 'Complete', 'Incomplete', 'NA'];
const SORT_OPTIONS = ['Milestone order', 'Status', 'Name'];

/** Icon + colour per document status. Never colour alone -- the label ships too. */
const STATUS_PRESENTATION = {
  [ITEM_STATUS.COMPLETE]: { color: '#34E0A1', label: 'Complete', Icon: CircleCheck },
  [ITEM_STATUS.MISSING]: { color: '#5A6478', label: 'Missing', Icon: Circle },
  [ITEM_STATUS.NA]: { color: '#9098A9', label: 'N/A', Icon: CircleMinus },
};

function DocumentRow({ item }) {
  const { color, label, Icon } = STATUS_PRESENTATION[item.status];
  const detail = [item.section, item.hint].filter(Boolean).join(' — ');

  return (
    <div className="mon-grid mon-trow mon-trow--tight" role="row">
      <span className="mon-chip">{item.milestone}</span>
      <div className="mon-doc">
        <p className="mon-doc-label">{item.label}</p>
        {detail ? <p className="mon-doc-sub">{detail}</p> : null}
      </div>
      <div className="mon-docstatus" style={{ color }}>
        <Icon size={16} aria-hidden="true" />
        <span>{label}</span>
      </div>
    </div>
  );
}

/**
 * Site Completion Monitor: milestone/document checklist for a single site.
 *
 * Read-only by design. The reference mockup let the user upload files and toggle
 * N/A, persisting to localStorage -- but this dashboard is embedded in a
 * cross-origin iframe where storage is partitioned or blocked, and the real
 * source of truth is the warehouse. Status is therefore derived from data.
 *
 * TODO(write-path): if uploads/N-A toggles need to be editable here, that needs a
 * backend endpoint (POST /api/site/:id/document) plus auth -- not browser
 * storage, which would silently diverge per viewer and vanish when embedded.
 */
export default function SiteCompletionMonitor({ data = loadSiteMonitor(), live = null }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('All');
  const [milestone, setMilestone] = useState('All milestones');
  const [sort, setSort] = useState('Milestone order');

  const summary = useMemo(
    () => summarise({ milestones: data.milestones, completion: data.completion }),
    [data.milestones, data.completion]
  );

  const visible = useMemo(
    () => filterItems(summary.items, { query, status, milestone, sort }),
    [summary.items, query, status, milestone, sort]
  );

  const overallStatus = siteStatus(summary);
  const photoPct = percent(data.photos.uploaded, data.photos.total);

  // Live values win where they exist; sample data fills the rest.
  const siteName = live?.site?.name || data.site.name;
  const routeName = live?.site?.route || data.site.route;
  const startDate = live?.site?.start || data.site.start;
  const kpi = live?.statusCounts || null;

  const milestoneOptions = [
    'All milestones',
    ...summary.progress.map((m) => ({ value: m.label, label: `${m.label} — ${m.name}` })),
  ];

  return (
    <div className="mon-shell">
      <MonitorHeader
        eyebrow="SITE COMPLETION MONITOR"
        title={siteName.toUpperCase()}
        subtitle={
          live?.site
            ? `Started ${startDate} · ${live.site.companyName} · node status ${live.site.nodeStatus}`
            : `Started ${startDate}`
        }
      />

      <div className="mon-card">
        <p className="mon-card-label">ROUTE</p>
        <p className="mon-route-value">{routeName}</p>
      </div>

      {/* Live status KPI. Separate from the milestone card below, which is still
          sample data -- so a real figure never sits unlabelled beside a mock one. */}
      {kpi ? (
        <div className="mon-card">
          <p className="mon-card-label mon-card-label--lg">
            SITE STATUS — LIVE FROM CLOUD_SITE_STATUS_HISTORY_WITH_COUNTS
          </p>
          <CountBreakdown
            counts={[
              { label: 'Complete', value: kpi.complete, color: statusColor(STATUS.COMPLETE) },
              { label: 'In Progress', value: kpi.inProgress, color: statusColor(STATUS.IN_PROGRESS) },
              { label: 'Yet to Start', value: kpi.yetToStart, color: statusColor(STATUS.YET_TO_START) },
            ]}
          />
          <p className="mon-cell-sub">
            {kpi.total} site{kpi.total === 1 ? '' : 's'} in scope, counted by latest status
            {kpi.complete === 0 ? ' · no "Complete" status exists in the source data' : ''}
          </p>
        </div>
      ) : null}

      {/* Milestone progress: hero figure + per-milestone bars */}
      <div className="mon-card">
        <p className="mon-card-label mon-card-label--lg">MILESTONE PROGRESS</p>
        <div className="mon-hero">
          <div className="mon-hero-left">
            {/* One spark bar per milestone, each scaled by its own completion. */}
            <div className="mon-sparks" aria-hidden="true">
              {summary.progress.map((m) => (
                <div
                  key={m.id}
                  className="mon-spark"
                  style={{ height: 8 + (m.pct / 100) * 26, background: progressColor(m.pct) }}
                />
              ))}
            </div>
            <p className="mon-hero-figure">{summary.overallPct}%</p>
            <p className="mon-hero-caption">MILESTONE COMPLETION</p>
          </div>

          <div className="mon-hero-right">
            <CountBreakdown
              counts={[
                { label: 'Milestones Complete', value: summary.milestonesDone, color: statusColor(STATUS.COMPLETE) },
                { label: 'In Progress', value: summary.milestonesInProgress, color: statusColor(STATUS.IN_PROGRESS) },
                { label: 'Not Started', value: summary.milestonesNotStarted, color: statusColor(STATUS.YET_TO_START) },
              ]}
            />
            <div className="mon-mrows">
              {summary.progress.map((m) => (
                <div className="mon-mrow" key={m.id}>
                  <span className="mon-mrow-label">{m.label}</span>
                  <div className="mon-mrow-track">
                    <div
                      className="mon-mrow-fill"
                      style={{ width: `${m.pct}%`, background: progressColor(m.pct) }}
                    />
                  </div>
                  <span className="mon-mrow-pct" style={{ color: progressColor(m.pct) }}>
                    {m.pct}%
                  </span>
                  <span className="mon-visually-hidden">
                    {m.name}: {m.done} of {m.total} documents
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <StatCards
        items={[
          { label: 'TOTAL DOCUMENTS', value: summary.totalDocuments, color: '#F7F8FB' },
          { label: 'UPLOADED %', value: `${summary.overallPct}%`, color: pctColor(summary.overallPct) },
          {
            label: 'MISSING',
            value: summary.missing,
            color: summary.missing > 0 ? DANGER : statusColor(STATUS.COMPLETE),
          },
          { label: 'N/A', value: summary.naCount, color: '#9098A9' },
          {
            label: 'MILESTONES DONE',
            value: `${summary.milestonesDone}/${summary.milestoneCount}`,
            color: statusColor(STATUS.COMPLETE),
          },
        ]}
      />

      {/* Photos & daily reports */}
      <div className="mon-card">
        <p className="mon-card-label mon-card-label--lg">PHOTOS &amp; DAILY REPORTS</p>
        <div className="mon-pr">
          <div className="mon-pr-main">
            <div className="mon-pr-head">
              <span className="mon-pr-caption">Photos uploaded</span>
              <span className="mon-pr-value" style={{ color: statusColor(overallStatus) }}>
                {data.photos.uploaded}/{data.photos.total} · {photoPct}%
              </span>
            </div>
            <div className="mon-pr-track">
              <div
                className="mon-pr-fill"
                style={{ width: `${photoPct}%`, background: statusColor(overallStatus) }}
              />
            </div>
          </div>
          <div className="mon-pr-side">
            <div>
              <p className="mon-pr-num">{data.reports.submitted}</p>
              <p className="mon-pr-sub">Daily reports submitted</p>
            </div>
            <div>
              <p
                className="mon-pr-num"
                style={{ color: data.reports.missedDays > 0 ? DANGER : statusColor(STATUS.COMPLETE) }}
              >
                {data.reports.missedDays}
              </p>
              <p className="mon-pr-sub">Days missed</p>
            </div>
          </div>
        </div>
      </div>

      <div className="mon-filters">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search document name..."
          icon={<Search size={15} color="#5A6478" aria-hidden="true" />}
        />
        <PillGroup options={STATUS_FILTERS} value={status} onChange={setStatus} label="Filter by status" />
        <Select value={milestone} onChange={setMilestone} options={milestoneOptions} label="Filter by milestone" />
        <Select value={sort} onChange={setSort} options={SORT_OPTIONS} label="Sort documents by" />
      </div>

      <div className="mon-table">
        {/* Column widths live on the scroll container so the header and every row
            inherit one definition and can never drift apart. */}
        <div className="mon-table-scroll" style={{ '--mon-cols': COLS, '--mon-min': '640px' }}>
          <div className="mon-grid mon-thead" role="row">
            <div role="columnheader">MILESTONE</div>
            <div role="columnheader">DOCUMENT</div>
            <div role="columnheader">STATUS</div>
          </div>

          {visible.map((item) => (
            <DocumentRow key={item.id} item={item} />
          ))}

          {visible.length === 0 ? (
            <div className="mon-empty-row">No documents match your filters.</div>
          ) : null}
        </div>
      </div>

      <p className="mon-foot">
        {visible.length} of {summary.totalDocuments} documents shown · {summary.naCount} marked N/A and
        excluded from completion
      </p>
    </div>
  );
}
