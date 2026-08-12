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

/** Filter pills use the same words as the STATUS column. */
const ITEM_FILTERS = ['All', 'Complete', 'In Progress', 'Not Started'];


/** m1 < m2 < m3 < m4 < m5 < unmapped, so unmapped tasks read as an appendix. */
function milestoneRank(key) {
  return key ? Number(String(key).replace(/[^0-9]/g, '')) || 99 : 99;
}

/**
 * Tracker task statuses, and how each one looks.
 *
 * These come from the tracker's own sign-off chain -- Lumen Accept/Reject, Final
 * Complete Date, then the partner and estimated dates -- not from "a photo
 * exists". Colour is never the only signal; the word and the icon ship with it.
 */
const ITEM_STATUS_PRESENTATION = {
  complete: { color: '#34E0A1', label: 'Complete', Icon: CircleCheck },
  inProgress: { color: '#F5B133', label: 'In Progress', Icon: Circle },
  /*
   * "Not Started", not "N/A".
   *
   * N/A now has one confirmed meaning on this screen -- the portal's Not Applicable,
   * 69 photo fields on Knolls -- and it is a different quantity from a tracker task
   * with no recorded date. Two figures under one word contradict each other.
   */
  notStarted: { color: '#5A6478', label: 'Not Started', Icon: Circle },
  rejected: { color: '#F0576E', label: 'Rejected', Icon: CircleMinus },
  // Retained so a stale payload cannot blank the column.
  missing: { color: '#5A6478', label: 'Not Started', Icon: Circle },
  na: { color: '#9098A9', label: 'N/A', Icon: CircleMinus },
};

/**
 * One TELAMON-ILA-TRACKER task.
 *
 * The MILESTONE chip is the client's own assignment (their Milestone column, or
 * the Task ID group where they left it blank). STATUS is their sign-off chain.
 * Nothing here is derived from a rule of ours.
 */
function ChecklistRow({ item }) {
  const { color, label, Icon } =
    ITEM_STATUS_PRESENTATION[item.status] || ITEM_STATUS_PRESENTATION.notStarted;

  const rollup = item.aggregated === true && item.nodeCount > 1;

  const detail = [
    item.taskId ? `Task ${item.taskId}` : null,
    item.responsibleParty || null,
    rollup ? `across ${item.nodeCount} nodes` : null,
    item.finalCompleteDate ? `final ${item.finalCompleteDate}` : null,
    item.partnerCompleteDate ? `partner ${item.partnerCompleteDate}` : null,
    item.lumenAcceptReject ? `Lumen: ${item.lumenAcceptReject}` : null,
    !rollup && item.statusReason ? item.statusReason : null,
    item.milestone && !item.milestoneExplicit ? 'milestone from Task ID' : null,
  ]
    .filter(Boolean)
    .join(' \u2014 ');

  return (
    <div className="mon-grid mon-trow mon-trow--tight" role="row">
      <span className="mon-chip">{item.milestone ? item.milestone.toUpperCase() : '--'}</span>
      <div className="mon-doc">
        <p className="mon-doc-label">{item.task || item.taskId || '(untitled task)'}</p>
        {detail ? <p className="mon-doc-sub">{detail}</p> : null}
      </div>
      <div className="mon-docstatus" style={{ color }}>
        <Icon size={16} aria-hidden="true" />
        <span>{rollup ? `${item.completeCount} of ${item.nodeCount} complete` : label}</span>
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
 * Site Completion Monitor: TELAMON-ILA-TRACKER tasks and milestones for a site.
 *
 * The table and the MILESTONE PROGRESS card both read the tracker, which is the
 * client's own M1..M5 definition. Photo coverage and daily reports are separate
 * cards fed by the photolist, and they are unaffected.
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

  /*
   * Header label. With no node picked the scope spans many, so the title says
   * "ALL SITES" instead of naming whichever node came back first. The cards
   * below still describe one node -- `detailName` -- and the subtitle says which.
   */
  const isAggregate = live?.site?.aggregate === true;
  const siteName = isAggregate ? 'ALL SITES' : live?.site?.name || data.site.name;
  const routeName =
    live?.site?.route ||
    (isAggregate && live?.site ? `All routes (${live.site.routeCount})` : data.site.route);
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

  /**
   * The table lists TELAMON-ILA-TRACKER tasks.
   *
   * Section headings are dropped -- ">>> Drawings Completed" and the column-owner
   * label rows are grid chrome, not work.
   *
   * EXPECT EMPTY. The tracker is configured on 63 Telamon nodes and filled in on
   * one, so almost every node shows nothing. That is the honest state: the client
   * has not used the tracker, and the portal agrees -- Basile reads
   * "TELAMON-ILA-TRACKER (0)".
   *
   * NEVER FALL BACK TO THE MOCK. `live.tracker` can be absent -- a stale server
   * process, a scope that matches no node, a deploy skew between the two halves.
   * `live?.tracker || null` returned null in those cases, which made the table
   * render loadSiteMonitor()'s SAMPLE rows: "CD Approved -- Complete" and friends,
   * indistinguishable on screen from real work. An empty live table is honest; a
   * fabricated full one is not. So the mock is reachable only when there is no
   * live payload at all, i.e. the standalone design preview.
   */
  const checklist = useMemo(() => {
    if (!live) return null;
    return (live.tracker || []).filter((t) => !t.isSectionHeader);
  }, [live]);

  /**
   * The payload carried no `tracker` field at all.
   *
   * Different from an empty tracker, and worth saying so: an empty tracker is the
   * data telling the truth, whereas a missing field means the API answering is
   * older than this page -- a server that was not restarted, or a half-finished
   * deploy. Reporting "the client has not filled in the tracker" there would state
   * something about the data that we have not actually been told.
   */
  const trackerAbsent = Boolean(live) && live.tracker === undefined;

  const milestoneView = useMemo(() => {
    // Same rule as the table: once there is a live payload the mock is off the
    // table, so a missing `metrics` shows "--" rather than the sample's 100%/75%.
    if (!live) return null;
    // With no metrics, still name the milestones from the payload's own defs so the
    // card shows M1..M5 at "--" instead of collapsing to a blank strip.
    const items =
      liveMs?.milestones ||
      (live.milestoneDefs || []).map((d) => ({ ...d, pct: null, done: 0, total: 0, inProgress: 0 }));
    const measurable = items.filter((m) => m.pct !== null && m.pct !== undefined);
    // Pooled across TASKS, not a mean of percentages: M4 holds 124 tracker tasks
    // and M5 holds 2, so averaging their percentages would over-weight M5 by 60x.
    const done = measurable.reduce((sum, m) => sum + (m.done || 0), 0);
    const total = measurable.reduce((sum, m) => sum + (m.total || 0), 0);
    return {
      items,
      measurable,
      overallPct: total > 0 ? Math.round((done / total) * 100) : null,
      stagesDone: done,
      stagesTotal: total,
      complete: measurable.filter((m) => m.pct === 100).length,
      // A milestone counts as in flight when work has been signed off part-way OR
      // when a task carries a date but no completion -- the tracker distinguishes
      // the two, so 0% does not automatically mean untouched.
      inProgress: measurable.filter((m) => (m.pct > 0 && m.pct < 100) || (m.pct === 0 && m.inProgress > 0))
        .length,
      notStarted: measurable.filter((m) => m.pct === 0 && !m.inProgress).length,
      mapped: Boolean(liveMs) && liveMs.milestonesMapped !== false,
    };
  }, [live, liveMs]);

  /** Tracker tasks for the table, driven by the filter controls above it. */
  const visibleItems = useMemo(() => {
    if (!checklist) return null;
    const q = query.trim().toLowerCase();
    const WANTED = { Complete: 'complete', 'In Progress': 'inProgress', 'Not Started': 'notStarted' };

    let out = checklist.filter((it) => {
      const text = `${it.task || ''} ${it.taskId || ''}`.toLowerCase();
      if (q && !text.includes(q)) return false;
      if (WANTED[status] && it.status !== WANTED[status]) return false;
      if (milestone !== 'All milestones' && (it.milestone || '').toUpperCase() !== milestone) {
        return false;
      }
      return true;
    });

    // Task IDs are "group-index", so sort them numerically, not as strings:
    // "11-2" must follow "9-30", which a string sort gets wrong.
    const taskKey = (t) => {
      const parts = String(t.taskId || '').split('-');
      return [Number(parts[0]) || 999, Number(parts[1]) || 999];
    };
    const byTaskId = (a, b) => {
      const ka = taskKey(a);
      const kb = taskKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1];
    };

    const rank = { complete: 0, inProgress: 1, notStarted: 2, rejected: 3 };
    if (sort === 'Status') {
      out = [...out].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || byTaskId(a, b));
    } else if (sort === 'Name') {
      out = [...out].sort((a, b) => String(a.task).localeCompare(String(b.task)));
    } else {
      out = [...out].sort(
        (a, b) => milestoneRank(a.milestone) - milestoneRank(b.milestone) || byTaskId(a, b)
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
    // The sample is reachable only with no live payload at all. A live payload
    // whose metrics are missing shows "--", never the sample's figures.
    if (!live) {
      const pct = percent(data.photos.uploaded, data.photos.total);
      return {
        pct,
        color: statusColor(overallStatus),
        label: `${data.photos.uploaded}/${data.photos.total} · ${pct}%`,
        note: null,
      };
    }
    if (!liveMs) return { pct: 0, color: '#5A6478', label: '--', note: null };
    const pct = liveMs.photoPct ?? 0;
    /*
     * The denominator must be the SAME one the percentage used. It excludes N/A
     * fields, so showing fieldsCovered/photoFields here while the percentage is
     * fieldsCovered/(photoFields - naFields) would put two contradictory figures
     * on one line -- Wadley would read "117/166 - 80%" when 117/166 is 70%.
     */
    const denominator = liveMs.coverageDenominator ?? liveMs.photoFields;
    return {
      pct,
      color: pctColor(pct),
      label: `${liveMs.fieldsCovered}/${denominator} · ${pct}%`,
      // Sub-label removed by request. The label beside the bar already carries
      // covered/applicable and the percentage.
      note: null,
    };
  }, [live, liveMs, data.photos, overallStatus]);

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
    if (!live) {
      return {
        submitted: data.reports.submitted,
        submittedNote: null,
        missedDays: data.reports.missedDays,
        missedNote: null,
      };
    }
    if (!liveMs) {
      return { submitted: null, submittedNote: null, missedDays: null, missedNote: null };
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
      /*
       * Definition note removed by request. "no reporting window" is kept for the
       * null case, because a blank there is indistinguishable from zero and the
       * two mean different things: never reported, versus missed nothing.
       */
      missedNote:
        liveMs.missedDays === null || liveMs.missedDays === undefined
          ? 'no reporting window'
          : null,
    };
  }, [live, liveMs, data.reports]);

  /**
   * The portal's "Node Media" figures, in its order and its wording.
   *
   * Reproduced exactly on Knolls (0/2/0 · 101 · 106 · 69 · 59) and on Basile
   * (0/0/0 · 165 · 122 · 0 · 149), so a reviewer can hold the two screens side by
   * side without translating between them.
   *
   * NOT APPLICABLE here is the photo-field N/A -- the count the portal shows. It is
   * a different quantity from a tracker task with no recorded date, which is why
   * the two must not share a label.
   */
  const mediaFigures = useMemo(() => {
    if (!liveMs) return null;
    const n = (v) => (v === null || v === undefined ? '--' : v);
    return [
      { label: 'Approved', value: n(liveMs.approvedMedia) },
      { label: 'Rejected', value: n(liveMs.rejectedMedia), color: liveMs.rejectedMedia > 0 ? DANGER : undefined },
      { label: 'Ignored', value: n(liveMs.ignoredMedia) },
      { label: 'Fields', value: n(liveMs.fieldsApplicable ?? liveMs.photoFields) },
      { label: 'Media', value: n(liveMs.photos) },
      { label: 'Not applicable', value: n(liveMs.naFields), color: '#9098A9' },
      { label: 'Fields w/o media', value: n(liveMs.incompleteFields) },
    ];
  }, [liveMs]);

  /*
   * All five cards read the payload's own figures -- four from the portal's Node
   * Media block, one from the tracker rollup. Nothing is recounted from the table
   * rows here, so there is no second implementation to drift.
   */

  /*
   * The first three cards describe DOCUMENTS, from S3Document -- not the tracker
   * table below them and nothing to do with milestones.
   *
   * UPLOADED % and MISSING read "--" because nothing in the source says which
   * documents a Telamon node ought to have. ECSite has the feature (a
   * required-document template writes placeholder rows) and other companies use it,
   * but no template is configured for Telamon, so there is no denominator. Both
   * figures start reporting the moment one is set up -- see config/documents.js.
   */
  /*
   * Read every document figure through `docNum`, which treats undefined and null
   * alike.
   *
   * A server older than this page sends no `documents` field at all, so the value is
   * UNDEFINED rather than null. A `!== null` check passed on undefined and put
   * "undefined%" on screen. Any absent-or-unknown figure must degrade to "--", and
   * the two cases have to be handled by one expression so they cannot drift apart.
   */
  const docNum = (field) => {
    const v = liveMs ? liveMs[field] : null;
    return v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
  };
  const docTotal = docNum('documents');
  const docPct = docNum('documentsPct');
  /** The portal's "Total Fields without Media" and "Not Applicable". */
  const docMissing = docNum('incompleteFields');
  const docNa = docNum('naFields');

  const cards = live
    ? [
        {
          label: 'TOTAL DOCUMENTS',
          value: docTotal === null ? '--' : docTotal,
          color: '#F7F8FB',
        },
        {
          /*
           * The portal's own figure: files against the node's 1,000-file allowance,
           * so Knolls' 5 files read 0.5% exactly as the portal shows.
           *
           * NOT coloured by pctColor. That ramp treats a low percentage as bad, which
           * is right for completion and backwards here -- 0.5% of the allowance used
           * is healthy, and painting it red would invent an alarm. Neutral until the
           * cap is actually close.
           */
          label: 'UPLOADED %',
          value: docPct === null ? '--' : `${docPct}%`,
          color:
            docPct === null
              ? '#5A6478'
              : docPct >= 95
                ? DANGER
                : docPct >= 80
                  ? '#F5B133'
                  : '#F7F8FB',
        },
        {
          /*
           * The portal's "Total Fields without Media" -- 59 on Knolls.
           *
           * NOT the outstanding required-document count, which has no source: no
           * required-document template is configured for Telamon, so that figure was
           * permanently "--". This is a real number the portal publishes, and it
           * answers the same question a reader asks of a MISSING card.
           *
           * N/A fields are already excluded from it upstream, so MISSING and N/A never
           * count the same field twice.
           */
          label: 'MISSING',
          value: docMissing === null ? '--' : docMissing,
          color: docMissing ? DANGER : statusColor(STATUS.COMPLETE),
        },
        {
          /*
           * The portal's "Not Applicable" -- 69 on Knolls. Photo fields the app marks
           * N/A, which is the only N/A the source actually records.
           *
           * Grey, not red: not-applicable is a neutral state and must not read as an
           * alarm.
           */
          label: 'N/A',
          value: docNa === null ? '--' : docNa,
          color: '#9098A9',
        },
        {
          label: 'MILESTONES DONE',
          value: milestoneView
            ? `${milestoneView.complete}/${milestoneView.measurable.length}`
            : `${summary.milestonesDone}/${summary.milestoneCount}`,
          color: statusColor(STATUS.COMPLETE),
        },
      ]
    : [
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
      ];

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
            ? isAggregate
              ? `${live.nodeCount} sites · ${
                  live.site.companyName || `${live.site.companyCount} companies`
                } · figures below are pooled across all of them`
              : `Started ${startDate} · ${live.site.companyName} · node status ${live.site.workStatus}`
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
            {/* Names what the big figure is: completion across M1..M5, not the count
                of milestones or of tasks, both of which also appear on this card. */}
            <p className="mon-hero-caption">MILESTONE COMPLETION</p>
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
                  /*
                   * "Not Started", NOT "N/A" -- these three count MILESTONES, while the
                   * N/A on the stat cards and in the STATUS column counts tracker TASKS.
                   * A milestone with no completed task has genuinely not started; it is
                   * not inapplicable, so it must not borrow the other word.
                   */
                  label: 'Not Started',
                  value: milestoneView ? milestoneView.notStarted : summary.milestonesNotStarted,
                  color: statusColor(STATUS.YET_TO_START),
                },
              ]}
            />
            <div className="mon-mrows">
              {(milestoneView ? milestoneView.items : summary.progress).map((m, i) => {
                // pct === null means NO TRACKER TASKS for this milestone, not zero.
                // Render "--" on a grey track so an unsourced milestone is never
                // read as "no progress made".
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
                        ? m.note || 'no tracker tasks recorded for this milestone'
                        : `${m.done} of ${m.total} tracker tasks complete`}
                    </span>
                  </div>
                );
              })}
            </div>
            {milestoneView && !milestoneView.mapped ? (
              <p className="mon-cell-sub" style={{ marginTop: 10, color: '#F5A623' }}>
                No TELAMON-ILA-TRACKER tasks for this selection, so M1&ndash;M5 percentages are
                withheld rather than shown as 0%. Milestones come from that tracker, which the
                client has not filled in here. The photo stage list below is still live.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <StatCards items={cards} />
      {/* Explanatory note removed by request. */}

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
              <p className="mon-pr-num">{reportsCard.submitted === null ? '--' : reportsCard.submitted}</p>
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

        {/* The portal's Node Media block, reproduced figure for figure.
            All seven verified against the portal on Knolls and Basile. */}
        {mediaFigures ? (
          <div className="mon-media">
            {mediaFigures.map((f) => (
              <div className="mon-media-item" key={f.label}>
                <p className="mon-media-num" style={f.color ? { color: f.color } : undefined}>
                  {f.value}
                </p>
                <p className="mon-media-label">{f.label}</p>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mon-filters">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={checklist ? 'Search task or Task ID...' : 'Search document name...'}
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
          options={SORT_OPTIONS}
          label={checklist ? 'Sort tasks by' : 'Sort documents by'}
        />
      </div>

      <div className="mon-table">
        {/* Column widths live on the scroll container so the header and every row
            inherit one definition and can never drift apart. */}
        <div className="mon-table-scroll" style={{ '--mon-cols': COLS, '--mon-min': '640px' }}>
          <div className="mon-grid mon-thead" role="row">
            <div role="columnheader">MILESTONE</div>
            <div role="columnheader">TASK</div>
            <div role="columnheader">STATUS</div>
          </div>

          {visibleItems
            ? visibleItems.map((it, i) => (
                /* answerSetId is unique per task row, but pooled rows have none, so
                   fall back to the Task ID and finally the index. */
                <ChecklistRow key={`${it.answerSetId || it.taskId || 'row'}:${i}`} item={it} />
              ))
            : visible.map((item) => <DocumentRow key={item.id} item={item} />)}

          {(visibleItems || visible).length === 0 ? (
            <div className="mon-empty-row">
              {/*
                Distinguish "your filters excluded everything" from "there is nothing
                here at all". The second case is the COMMON one: the tracker is empty
                on almost every node, so the table is blank before any filter is
                applied. Saying "no tasks match your filters" there would blame the
                reader for a property of the data.
              */}
              {!visibleItems || (checklist && checklist.length > 0) ? (
                'No tasks match your filters.'
              ) : (
                <>
                  No records to display.
                  {/*
                    The reason line is shown ONLY when the response actually carried a
                    tracker that was empty. With no tracker field at all we cannot say
                    why -- that would assert something about the data the response
                    never told us -- so the neutral line stands alone.
                  */}
                  {trackerAbsent ? null : (
                    <span className="mon-empty-note">
                      No TELAMON-ILA-TRACKER tasks have been recorded for this selection.
                    </span>
                  )}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <p className="mon-foot">
        {visibleItems ? (
          <>
            {visibleItems.length} of {checklist.length} tracker tasks shown ·{' '}
            {checklist.filter((i) => i.status === 'complete').length} Complete,{' '}
            {checklist.filter((i) => i.status === 'inProgress').length} In Progress,{' '}
            {checklist.filter((i) => i.status === 'notStarted').length} Not Started
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
