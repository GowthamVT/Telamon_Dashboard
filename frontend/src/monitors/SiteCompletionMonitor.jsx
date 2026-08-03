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
  describeStatusScope,
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

/** Grey track for an unmeasurable value -- visually distinct from 0%, which is red. */
const EMPTY_TRACK = '#2A3142';

/** Stage-table filters. A stage counts as Started once any photo exists against it. */
const STAGE_FILTERS = ['All', 'Started', 'Not started', 'Unmapped'];
const STAGE_SORTS = ['Milestone order', 'Photos', 'Name'];

/** m1 < m2 < m3 < m4 < unmapped, so unmapped stages read as an appendix. */
function milestoneRank(key) {
  return key ? Number(String(key).replace(/[^0-9]/g, '')) || 99 : 99;
}

/**
 * One checklist stage of the node's photolist template.
 *
 * "Started" is the only completion signal available: a stage has photos or it
 * does not. There is no per-stage sign-off column anywhere in the warehouse, so
 * this deliberately does not claim a stage is *finished*.
 */
function StageRow({ stage }) {
  const started = stage.photos > 0;
  const color = stage.milestone ? (started ? '#34E0A1' : '#5A6478') : '#9098A9';
  const Icon = stage.milestone ? (started ? CircleCheck : Circle) : CircleMinus;
  const detail = [
    stage.photoFields + ' photo field' + (stage.photoFields === 1 ? '' : 's'),
    stage.lastPhoto ? 'last photo ' + stage.lastPhoto : null,
    stage.milestone ? null : 'not part of a milestone',
  ]
    .filter(Boolean)
    .join(' \u2014 ');

  return (
    <div className="mon-grid mon-trow mon-trow--tight" role="row">
      <span className="mon-chip">{stage.milestone ? stage.milestone.toUpperCase() : '--'}</span>
      <div className="mon-doc">
        <p className="mon-doc-label">{stage.stage}</p>
        <p className="mon-doc-sub">{detail}</p>
      </div>
      <div className="mon-docstatus" style={{ color }}>
        <Icon size={16} aria-hidden="true" />
        <span>
          {started
            ? stage.photos + ' photos'
            : stage.milestone
              ? 'Not started'
              : 'N/A'}
        </span>
      </div>
    </div>
  );
}

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
  const scopeNote = describeStatusScope(kpi);

  /**
   * Live milestone progress for THIS node.
   *
   * Falls back to the sample milestones only when the API has not answered.
   * `measurable` excludes M1 (document-based, no source) and every milestone on
   * a node whose checklist template is not mapped -- those render "--" rather
   * than 0%, so a node is never shown as behind on something unmeasurable.
   */
  const liveMs = live?.metrics || null;
  const stages = live?.stages || null;

  const milestoneView = useMemo(() => {
    if (!liveMs) return null;
    const items = liveMs.milestones || [];
    const measurable = items.filter((m) => m.pct !== null && m.pct !== undefined);
    // Pooled across stages, not a mean of percentages: M2 has 6 stages and M4
    // has 2, so averaging their percentages would over-weight the small one.
    const done = measurable.reduce((sum, m) => sum + (m.done || 0), 0);
    const total = measurable.reduce((sum, m) => sum + (m.total || 0), 0);
    return {
      items,
      measurable,
      overallPct: total > 0 ? Math.round((done / total) * 100) : null,
      stagesDone: done,
      stagesTotal: total,
      complete: measurable.filter((m) => m.pct === 100).length,
      inProgress: measurable.filter((m) => m.pct > 0 && m.pct < 100).length,
      notStarted: measurable.filter((m) => m.pct === 0).length,
      mapped: liveMs.milestonesMapped !== false,
    };
  }, [liveMs]);

  /** Stage rows for the table, driven by the same filter controls as the mock list. */
  const visibleStages = useMemo(() => {
    if (!stages) return null;
    const q = query.trim().toLowerCase();
    let out = stages.filter((st) => {
      if (q && !st.stage.toLowerCase().includes(q)) return false;
      if (status === 'Started' && st.photos === 0) return false;
      if (status === 'Not started' && !(st.milestone && st.photos === 0)) return false;
      if (status === 'Unmapped' && st.milestone) return false;
      if (milestone !== 'All milestones' && (st.milestone || '').toUpperCase() !== milestone) {
        return false;
      }
      return true;
    });

    if (sort === 'Photos') out = [...out].sort((a, b) => b.photos - a.photos);
    else if (sort === 'Name') out = [...out].sort((a, b) => a.stage.localeCompare(b.stage));
    else {
      out = [...out].sort(
        (a, b) => milestoneRank(a.milestone) - milestoneRank(b.milestone) || b.photos - a.photos
      );
    }
    return out;
  }, [stages, query, status, milestone, sort]);

  const milestoneOptions = [
    'All milestones',
    ...(milestoneView ? milestoneView.items : summary.progress).map((m) => ({
      value: m.label,
      label: `${m.label} — ${m.name}`,
    })),
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

      {/* Live status KPI. Company-scoped by design, so it is kept visually separate
          from the per-node milestone card below -- two scopes, never conflated. */}
      {kpi ? (
        <div className="mon-card">
          <p className="mon-card-label mon-card-label--lg">
            NODE STATUS — {String(scopeNote.label || 'company').toUpperCase()} · {scopeNote.total}{' '}
            NODES ({scopeNote.level})
          </p>
          <CountBreakdown
            counts={[
              { label: 'Complete', value: kpi.complete, color: statusColor(STATUS.COMPLETE) },
              { label: 'In Progress', value: kpi.inProgress, color: statusColor(STATUS.IN_PROGRESS) },
              { label: 'Yet to Start', value: kpi.yetToStart, color: statusColor(STATUS.YET_TO_START) },
            ]}
          />
          <p className="mon-cell-sub">
            Latest status per node, {scopeNote.level}
            {scopeNote.noHistory > 0
              ? ` · ${scopeNote.noHistory} of ${scopeNote.total} nodes have no status history and are counted as Yet to Start`
              : ''}
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
              {(milestoneView ? milestoneView.items : summary.progress).map((m, i) => (
                <div
                  key={m.key || m.id || i}
                  className="mon-spark"
                  style={{
                    height: 8 + ((m.pct ?? 0) / 100) * 26,
                    background: m.pct === null || m.pct === undefined ? EMPTY_TRACK : progressColor(m.pct),
                  }}
                />
              ))}
            </div>
            <p className="mon-hero-figure">
              {milestoneView
                ? milestoneView.overallPct === null
                  ? '--'
                  : `${milestoneView.overallPct}%`
                : `${summary.overallPct}%`}
            </p>
            <p className="mon-hero-caption">
              {milestoneView && milestoneView.stagesTotal
                ? `STAGES COMPLETE (${milestoneView.stagesDone}/${milestoneView.stagesTotal})`
                : 'MILESTONE COMPLETION'}
            </p>
          </div>

          <div className="mon-hero-right">
            <CountBreakdown
              counts={[
                {
                  label: 'Milestones Complete',
                  value: milestoneView ? milestoneView.complete : summary.milestonesDone,
                  color: statusColor(STATUS.COMPLETE),
                },
                {
                  label: 'In Progress',
                  value: milestoneView ? milestoneView.inProgress : summary.milestonesInProgress,
                  color: statusColor(STATUS.IN_PROGRESS),
                },
                {
                  label: 'Not Started',
                  value: milestoneView ? milestoneView.notStarted : summary.milestonesNotStarted,
                  color: statusColor(STATUS.YET_TO_START),
                },
              ]}
            />
            <div className="mon-mrows">
              {(milestoneView ? milestoneView.items : summary.progress).map((m, i) => {
                // pct === null means UNMEASURABLE, not zero -- M1 is document-based
                // and CLOUD_ECSITE_S3DOCUMENT is empty. Render "--" on a grey track
                // so an unsourced milestone is never read as "no progress made".
                const unmeasured = m.pct === null || m.pct === undefined;
                return (
                  <div className="mon-mrow" key={m.key || m.id || i}>
                    <span className="mon-mrow-label">{m.label}</span>
                    <div className="mon-mrow-track">
                      <div
                        className="mon-mrow-fill"
                        style={{
                          width: unmeasured ? '100%' : `${m.pct}%`,
                          background: unmeasured ? EMPTY_TRACK : progressColor(m.pct),
                        }}
                      />
                    </div>
                    <span
                      className="mon-mrow-pct"
                      style={{ color: unmeasured ? '#5A6478' : progressColor(m.pct) }}
                      title={unmeasured ? m.note || 'No source for this milestone' : undefined}
                    >
                      {unmeasured ? '--' : `${m.pct}%`}
                    </span>
                    <span className="mon-visually-hidden">
                      {m.name}:{' '}
                      {unmeasured
                        ? m.note || 'not measurable from the available data'
                        : `${m.done} of ${m.total} stages started`}
                    </span>
                  </div>
                );
              })}
            </div>
            {milestoneView && !milestoneView.mapped ? (
              <p className="mon-cell-sub" style={{ marginTop: 10, color: '#F5A623' }}>
                This node&rsquo;s checklist template is not mapped to M1&ndash;M4 yet, so milestone
                percentages are withheld. The stage list below is still live.
              </p>
            ) : null}
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
        <PillGroup
          options={stages ? STAGE_FILTERS : STATUS_FILTERS}
          value={status}
          onChange={setStatus}
          label="Filter by status"
        />
        <Select value={milestone} onChange={setMilestone} options={milestoneOptions} label="Filter by milestone" />
        <Select
          value={sort}
          onChange={setSort}
          options={stages ? STAGE_SORTS : SORT_OPTIONS}
          label={stages ? 'Sort stages by' : 'Sort documents by'}
        />
      </div>

      <div className="mon-table">
        {/* Column widths live on the scroll container so the header and every row
            inherit one definition and can never drift apart. */}
        <div className="mon-table-scroll" style={{ '--mon-cols': COLS, '--mon-min': '640px' }}>
          <div className="mon-grid mon-thead" role="row">
            <div role="columnheader">MILESTONE</div>
            <div role="columnheader">{visibleStages ? 'STAGE' : 'DOCUMENT'}</div>
            <div role="columnheader">{visibleStages ? 'PHOTOS' : 'STATUS'}</div>
          </div>

          {visibleStages
            ? visibleStages.map((st) => <StageRow key={st.stage} stage={st} />)
            : visible.map((item) => <DocumentRow key={item.id} item={item} />)}

          {(visibleStages || visible).length === 0 ? (
            <div className="mon-empty-row">
              No {visibleStages ? 'stages' : 'documents'} match your filters.
            </div>
          ) : null}
        </div>
      </div>

      <p className="mon-foot">
        {visibleStages ? (
          <>
            {visibleStages.length} of {stages.length} checklist stages shown · a stage counts as
            started once any photo is uploaded against it
          </>
        ) : (
          <>
            {visible.length} of {summary.totalDocuments} documents shown · {summary.naCount}{' '}
            marked N/A and excluded from completion
          </>
        )}
      </p>
    </div>
  );
}
