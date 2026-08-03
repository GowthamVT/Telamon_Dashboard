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

/**
 * Checklist filters. "Extra" means the form exists on the node but is absent from
 * its CLOUD_FORMGOUP_SS checklist -- worth surfacing rather than hiding: Wadley's
 * DAILY REPORT FORM, with 31 submissions, is one of those.
 */
const ITEM_FILTERS = ['All', 'Complete', 'Incomplete', 'Extra'];
const ITEM_SORTS = ['Checklist order', 'Milestone order', 'Evidence', 'Name'];

/** m1 < m2 < m3 < m4 < unmapped, so unmapped stages read as an appendix. */
function milestoneRank(key) {
  return key ? Number(String(key).replace(/[^0-9]/g, '')) || 99 : 99;
}

/** How each checklist item type shows completion, and what evidence to name. */
const KIND_LABEL = {
  photolist: 'photo list',
  ondemand: 'form',
  installTracker: 'tracker',
  single: 'form',
};

/**
 * One item of the node's checklist (CLOUD_FORMGOUP_SS.LIST).
 *
 * Completion is EVIDENCE-BASED and says so: a photo list is done when photos
 * exist, a form when a submission exists. No table in the warehouse carries a
 * per-item sign-off, so nothing here claims approval.
 */
function ChecklistRow({ item }) {
  const isPhotos = item.kind === 'photolist';
  const color = item.done ? '#34E0A1' : item.inChecklist ? '#5A6478' : '#9098A9';
  const Icon = item.done ? CircleCheck : item.inChecklist ? Circle : CircleMinus;

  const detail = [
    item.section,
    KIND_LABEL[item.kind] || item.kind,
    isPhotos && item.photoFields
      ? `${item.photoFields} photo field${item.photoFields === 1 ? '' : 's'}`
      : null,
    item.lastPhoto ? `last photo ${item.lastPhoto}` : null,
    !isPhotos && item.lastSubmission ? `last ${item.lastSubmission}` : null,
    item.inChecklist ? null : 'not in the node checklist',
  ]
    .filter(Boolean)
    .join(' \u2014 ');

  const evidence = isPhotos
    ? item.photos > 0
      ? `${item.photos} photos`
      : 'No photos'
    : item.submissions > 0
      ? `${item.submissions} submission${item.submissions === 1 ? '' : 's'}`
      : 'None';

  return (
    <div className="mon-grid mon-trow mon-trow--tight" role="row">
      <span className="mon-chip">{item.milestone ? item.milestone.toUpperCase() : '--'}</span>
      <div className="mon-doc">
        <p className="mon-doc-label">
          {item.position ? `${item.position}. ` : ''}
          {item.name}
        </p>
        <p className="mon-doc-sub">{detail}</p>
      </div>
      <div className="mon-docstatus" style={{ color }}>
        <Icon size={16} aria-hidden="true" />
        <span>{evidence}</span>
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
  const checklist = live?.checklist || null;

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

  /** Checklist rows for the table, driven by the filter controls above it. */
  const visibleItems = useMemo(() => {
    if (!checklist) return null;
    const q = query.trim().toLowerCase();
    const evidenceOf = (it) => (it.kind === 'photolist' ? it.photos : it.submissions);

    let out = checklist.filter((it) => {
      if (q && !it.name.toLowerCase().includes(q)) return false;
      if (status === 'Complete' && !it.done) return false;
      if (status === 'Incomplete' && it.done) return false;
      if (status === 'Extra' && it.inChecklist) return false;
      if (milestone !== 'All milestones' && (it.milestone || '').toUpperCase() !== milestone) {
        return false;
      }
      return true;
    });

    if (sort === 'Evidence') out = [...out].sort((a, b) => evidenceOf(b) - evidenceOf(a));
    else if (sort === 'Name') out = [...out].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'Milestone order') {
      out = [...out].sort(
        (a, b) =>
          milestoneRank(a.milestone) - milestoneRank(b.milestone) ||
          (a.sequence ?? 999) - (b.sequence ?? 999)
      );
    } else {
      // Checklist order: the node's own sequence, with the extra forms after it.
      out = [...out].sort(
        (a, b) =>
          Number(b.inChecklist) - Number(a.inChecklist) ||
          (a.sequence ?? 999) - (b.sequence ?? 999) ||
          a.name.localeCompare(b.name)
      );
    }
    return out;
  }, [checklist, query, status, milestone, sort]);

  /**
   * Photo coverage bar.
   *
   * Numerator is `fieldsCovered` (distinct photo fields with media), NOT the raw
   * photo count -- 593 photos across 166 fields is 63% coverage, not 357%. The
   * photo total itself is exact and validated against the portal; coverage is
   * approximate because media rows carry answer-level ids that do not join back
   * to question ids, and because the N/A flag has no source to exclude.
   */
  const photoBar = useMemo(() => {
    if (!liveMs) {
      const pct = percent(data.photos.uploaded, data.photos.total);
      return {
        pct,
        color: statusColor(overallStatus),
        label: `${data.photos.uploaded}/${data.photos.total} · ${pct}%`,
        note: null,
      };
    }
    const pct = liveMs.photoPct ?? 0;
    return {
      pct,
      color: pctColor(pct),
      label: `${liveMs.fieldsCovered}/${liveMs.photoFields} · ${pct}%`,
      note: `${liveMs.photos} photos uploaded (exact)${
        liveMs.photoPctApproximate ? ' · coverage approximate, N/A fields not excluded' : ''
      }`,
    };
  }, [liveMs, data.photos, overallStatus]);

  /**
   * Daily reports for this node.
   *
   * `submitted` counts submissions and `reportDays` counts distinct days, so 31
   * reports over 26 days is normal -- more than one report can land in a day.
   * `missedDays` is weekdays with no report inside the node's own reporting
   * window (first to last report), so a node that never reported has no window
   * and shows "--" rather than a fabricated zero.
   */
  const reportsCard = useMemo(() => {
    if (!liveMs) {
      return {
        submitted: data.reports.submitted,
        submittedNote: null,
        missedDays: data.reports.missedDays,
        missedNote: null,
      };
    }
    const days = liveMs.reportDays;
    return {
      submitted: liveMs.reports,
      submittedNote:
        liveMs.reports === 0
          ? 'none submitted'
          : `on ${days} day${days === 1 ? '' : 's'}${
              liveMs.lastReport ? ` · last ${liveMs.lastReport}` : ''
            }`,
      missedDays: liveMs.missedDays ?? null,
      missedNote:
        liveMs.missedDays === null || liveMs.missedDays === undefined
          ? 'no reporting window'
          : 'weekdays with no report, within this node\u2019s reporting window',
    };
  }, [liveMs, data.reports]);

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

      {/* Photos & daily reports -- same figures as the Route Monitor's row for
          this node, read from the same getNodeMetrics source so the two tabs
          cannot disagree. */}
      <div className="mon-card">
        <p className="mon-card-label mon-card-label--lg">PHOTOS &amp; DAILY REPORTS</p>
        <div className="mon-pr">
          <div className="mon-pr-main">
            <div className="mon-pr-head">
              <span className="mon-pr-caption">Photo fields covered</span>
              <span className="mon-pr-value" style={{ color: photoBar.color }}>
                {photoBar.label}
              </span>
            </div>
            <div className="mon-pr-track">
              <div
                className="mon-pr-fill"
                style={{ width: `${photoBar.pct}%`, background: photoBar.color }}
              />
            </div>
            {photoBar.note ? <p className="mon-cell-sub">{photoBar.note}</p> : null}
          </div>
          <div className="mon-pr-side">
            <div>
              <p className="mon-pr-num">{reportsCard.submitted}</p>
              <p className="mon-pr-sub">Daily reports submitted</p>
              {reportsCard.submittedNote ? (
                <p className="mon-cell-sub">{reportsCard.submittedNote}</p>
              ) : null}
            </div>
            <div>
              <p
                className="mon-pr-num"
                style={{
                  color:
                    reportsCard.missedDays === null
                      ? '#5A6478'
                      : reportsCard.missedDays > 0
                        ? DANGER
                        : statusColor(STATUS.COMPLETE),
                }}
              >
                {reportsCard.missedDays === null ? '--' : reportsCard.missedDays}
              </p>
              <p className="mon-pr-sub">Days missed</p>
              {reportsCard.missedNote ? (
                <p className="mon-cell-sub">{reportsCard.missedNote}</p>
              ) : null}
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
          options={checklist ? ITEM_FILTERS : STATUS_FILTERS}
          value={status}
          onChange={setStatus}
          label="Filter by status"
        />
        <Select value={milestone} onChange={setMilestone} options={milestoneOptions} label="Filter by milestone" />
        <Select
          value={sort}
          onChange={setSort}
          options={checklist ? ITEM_SORTS : SORT_OPTIONS}
          label={checklist ? 'Sort checklist by' : 'Sort documents by'}
        />
      </div>

      <div className="mon-table">
        {/* Column widths live on the scroll container so the header and every row
            inherit one definition and can never drift apart. */}
        <div className="mon-table-scroll" style={{ '--mon-cols': COLS, '--mon-min': '640px' }}>
          <div className="mon-grid mon-thead" role="row">
            <div role="columnheader">MILESTONE</div>
            <div role="columnheader">{visibleItems ? 'CHECKLIST ITEM' : 'DOCUMENT'}</div>
            <div role="columnheader">{visibleItems ? 'EVIDENCE' : 'STATUS'}</div>
          </div>

          {visibleItems
            ? visibleItems.map((it) => <ChecklistRow key={it.formId} item={it} />)
            : visible.map((item) => <DocumentRow key={item.id} item={item} />)}

          {(visibleItems || visible).length === 0 ? (
            <div className="mon-empty-row">
              No {visibleItems ? 'checklist items' : 'documents'} match your filters.
            </div>
          ) : null}
        </div>
      </div>

      <p className="mon-foot">
        {visibleItems ? (
          <>
            {visibleItems.length} of {checklist.length} checklist items shown ·{' '}
            {checklist.filter((i) => i.inChecklist).length} defined in this node&rsquo;s checklist,{' '}
            {checklist.filter((i) => !i.inChecklist).length} additional forms found on the node ·
            complete means evidence exists (photos for a photo list, a submission for a form), not
            sign-off
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
