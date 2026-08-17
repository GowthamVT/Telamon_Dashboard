/**
 * Route Completion Monitor derivation.
 *
 * All business rules live here, isolated from rendering, so they can be moved
 * into SQL later without touching the UI -- and so they are testable.
 */
import { percent, STATUS } from './status';

/**
 * A site's status is DERIVED, never stored:
 *   - every expected photo uploaded AND no missed report days  -> Complete
 *   - 5 or more missed report days                             -> Yet to Start
 *   - anything in between                                      -> In Progress
 *
 * The 5-day threshold treats a long reporting gap as "never actually started"
 * rather than "in progress", which is what the reference behaviour does.
 */
export function deriveStatus(site) {
  const pct = percent(site.photosUploaded, site.photosTotal);
  if (pct === 100 && site.missedDays === 0) return STATUS.COMPLETE;
  if (site.missedDays >= 5) return STATUS.YET_TO_START;
  return STATUS.IN_PROGRESS;
}

/**
 * Normalise a raw site row for display.
 *
 * A "Yet to Start" site is zeroed out: if it never started, any partial photo or
 * milestone figure is noise that would otherwise imply progress that isn't real.
 */
export function decorateSite(site) {
  const status = deriveStatus(site);

  if (status === STATUS.YET_TO_START) {
    const row = {
      ...site,
      status,
      startKind: site.startKind || 'start',
      photosUploaded: 0,
      photosPct: 0,
      reports: 0,
      milestones: [0, 0, 0, 0],
    };
    return { ...row, ...overallFrom(row) };
  }

  const row = {
    ...site,
    status,
    /* The sample rows carry a plain start date, so they say so -- the live path sets
       this per status in rowsFromNodes. */
    startKind: site.startKind || 'start',
    photosPct: percent(site.photosUploaded, site.photosTotal),
    milestones: [site.m1, site.m2, site.m3, site.m4],
  };
  return { ...row, ...overallFrom(row) };
}

/** Route-level rollup used by the hero figure and the stat cards. */
export function summarise(sites) {
  const decorated = sites.map(decorateSite);

  const complete = decorated.filter((s) => s.status === STATUS.COMPLETE).length;
  const yetToStart = decorated.filter((s) => s.status === STATUS.YET_TO_START).length;

  return {
    sites: decorated,
    total: decorated.length,
    complete,
    yetToStart,
    inProgress: decorated.length - complete - yetToStart,
    // Average of per-site percentages -- deliberately NOT total photos / total
    // expected, so a single huge site cannot dominate the route figure.
    avgPhotoPct: decorated.length
      ? Math.round(decorated.reduce((sum, s) => sum + s.photosPct, 0) / decorated.length)
      : 0,
    totalReports: decorated.reduce((sum, s) => sum + s.reports, 0),
    // Missed days come from the RAW rows: a site that never started still has
    // real missed days, and hiding them would understate the problem.
    totalMissedDays: sites.reduce((sum, s) => sum + s.missedDays, 0),
  };
}

/**
 * Map CLOUD_NODE."Node Status" onto the dashboard's three buckets.
 *
 * COP = Certificate of Provisioning. "Sent" is submitted but not yet signed off,
 * so it is still in flight; approval is the finish line -- CLOUD_NODE carries
 * matching "COP Approved Date"/"COP Completed Date" columns, which is the
 * evidence for reading approval as complete.
 */
const NODE_STATUS_MAP = {
  'cop approved': STATUS.COMPLETE,
  'cop completed': STATUS.COMPLETE,
  complete: STATUS.COMPLETE,
  completed: STATUS.COMPLETE,
  'in progress': STATUS.IN_PROGRESS,
  'in-progress': STATUS.IN_PROGRESS,
  'cop sent': STATUS.IN_PROGRESS,
  'cop rejected': STATUS.IN_PROGRESS,
  'yet to start': STATUS.YET_TO_START,
  inactive: STATUS.YET_TO_START,
};

/**
 * Elapsed time since a node started, as the sample's "8mo" label.
 *
 * COMPLETE calendar months, floored, which is what the reference figures are:
 * 2025-11-18 reads 8mo on 2026-08-13 because the ninth month is not finished
 * (13 < 18). Counting by 30-day blocks would say 9 and drift a day per month.
 *
 * `duration` used to hold node.nodeCode, which is why the column read
 * "2026-03-30 - BOLIGEE" instead of an age.
 *
 * Null when there is no start date -- the label is then just the date, rather than
 * an age computed from nothing. Clamped at 0 for a start date in the future.
 */
export function monthsSince(iso, today = new Date()) {
  if (!iso) return null;
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return null;

  let months =
    (today.getFullYear() - start.getFullYear()) * 12 + (today.getMonth() - start.getMonth());
  // Not a whole month yet if the day-of-month has not come round again.
  if (today.getDate() < start.getDate()) months -= 1;
  return `${Math.max(months, 0)}mo`;
}

/* ---------------------------------------------------------------------------
 * OVERALL = one pooled ratio across the three metric columns.
 *
 * It used to be `photosPct` verbatim, so OVERALL and PHOTOS printed the same number
 * on every row. It was then the mean of the three columns' percentages, which gave a
 * small column the same say as a large one -- 4 milestone blocks weighing as much as
 * 176 photo fields.
 *
 * NOW THE COUNTS ARE POOLED, which is the client's formula: add the three numerators,
 * add the three denominators, divide once.
 *
 *   OVERALL = (photo fields settled + days reported + milestones done)
 *             ----------------------------------------------------------
 *             (photo fields all + days in the window + milestone blocks)
 *
 * Worked through the row this was specified against -- 11/20 photos, 2 reports with
 * 4 days missed, 0/4 milestones:
 *
 *   (11 + 2 + 0) / (20 + (2 + 4) + 4) = 13/30 = 43%
 *
 * This is the same "pool, never average percentages" rule the route KPI already
 * follows, so a site's OVERALL cannot be swung by its smallest column.
 *
 * WHAT EACH COLUMN CONTRIBUTES
 *
 *   PHOTOS        fieldsSettled / fieldsAll -- the PHOTOS cell's own two numbers.
 *   DAILY REPORTS reportDays / (reportDays + missedDays) -- days carrying a report
 *                 over the working days in the observed window. A site that has
 *                 never reported has NO window, so it adds 0 to both sides and
 *                 cannot be scored against a reporting target nobody has stated.
 *   MILESTONES    done / 4, counted the way the MILESTONES caption counts it: the
 *                 blocks at 100% over all four blocks.
 *
 * ON MILESTONES BEING COUNTED WHILE UNCONFIGURED. The four blocks stay in the
 * denominator even where TELAMON-ILA-TRACKER holds no task for the site -- as
 * specified, "0/4" contributes 0 and 4. This is worth knowing when reading the
 * figure: with the tracker filled in on 1 of 202 sites, almost every row is carrying
 * 4 unearned denominator, which pulls it a few points below its photo figure. The
 * tooltip prints all three fractions so the pull is visible rather than mysterious.
 * ------------------------------------------------------------------------- */
const OVERALL_LABELS = { photos: 'photos', reports: 'reports', milestones: 'milestones' };

/** A finite number, or null. Guards against undefined from a stale server. */
function numOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Photo fields: settled over all, the two numbers the PHOTOS cell prints. */
export function photoCounts(row) {
  const done = numOrNull(row.photosUploaded);
  const total = numOrNull(row.photosTotal);
  if (done === null || total === null || total <= 0) return null;
  return { done, total };
}

/**
 * Reporting: days reported over the working days in the observed window.
 *
 * NULL where the site never reported -- missedDays is null there, meaning no window
 * exists, which is not the same as a window with nothing in it.
 */
export function reportCounts(row) {
  const done = numOrNull(row.reportDays);
  const missed = numOrNull(row.missedDays);
  if (done === null || missed === null) return null;
  const total = done + missed;
  if (total <= 0) return null;
  return { done, total };
}

/**
 * Milestones: blocks at 100% over all blocks.
 *
 * Counted exactly as MilestoneCell's "0/4 milestones" caption counts it, so the two
 * cells in the same row can never tell different stories.
 */
export function milestoneCounts(row) {
  if (!Array.isArray(row.milestones) || !row.milestones.length) return null;
  const figures = row.milestones.map((m) => numOrNull(typeof m === 'number' ? m : m && m.pct));
  return {
    done: figures.filter((n) => n === 100).length,
    total: row.milestones.length,
    // Whether the tracker actually says anything here, as opposed to four grey blocks.
    measured: figures.some((n) => n !== null),
  };
}

/** A column's own percentage, for the tooltip. */
function share({ done, total }) {
  return Math.round((done / total) * 100);
}

/**
 * Pool the columns that have counts. Returns overallPct null when none do, so the
 * cell shows "--" instead of a confident 0.
 */
export function overallFrom(row) {
  const parts = [
    { key: 'photos', counts: photoCounts(row) },
    { key: 'reports', counts: reportCounts(row) },
    { key: 'milestones', counts: milestoneCounts(row) },
  ]
    .filter((part) => part.counts !== null)
    .map((part) => ({
      key: part.key,
      label: OVERALL_LABELS[part.key],
      done: part.counts.done,
      total: part.counts.total,
      pct: share(part.counts),
      measured: part.counts.measured !== false,
    }));

  if (!parts.length) return { overallPct: null, overallParts: [] };

  /*
   * "--", not 0%, when NOTHING is measured.
   *
   * The four milestone blocks are always in the denominator, so a site with no photo
   * fields, no reports and no tracker tasks would otherwise pool to 0/4 and print a
   * confident 0% -- reporting no progress on a site nobody has measured. A grey
   * milestone column contributes its denominator, but it cannot be the sole basis for
   * a figure.
   */
  if (!parts.some((part) => part.measured)) return { overallPct: null, overallParts: [] };

  const done = parts.reduce((sum, part) => sum + part.done, 0);
  const total = parts.reduce((sum, part) => sum + part.total, 0);
  if (total <= 0) return { overallPct: null, overallParts: [] };

  return {
    overallPct: Math.round((done / total) * 100),
    overallParts: parts,
    overallDone: done,
    overallTotal: total,
  };
}

export function mapNodeStatus(raw) {
  if (!raw) return STATUS.YET_TO_START;
  return NODE_STATUS_MAP[String(raw).trim().toLowerCase()] || STATUS.IN_PROGRESS;
}

/**
 * Build table rows from live CLOUD_NODE records.
 *
 * Name, start date and status are real. The photo / report / milestone metrics
 * are left NULL rather than filled with sample numbers: now that each row names
 * a real node, inventing its photo count would attribute fake figures to a real
 * site, which is worse than showing nothing. The cells render as "--" until
 * those sources are identified.
 */
export function rowsFromNodes(nodes = []) {
  return nodes.map((node) => {
    const m = node.metrics || null;
    const row = {
      nodeId: node.nodeId,
      name: node.nodeName,
      status: mapNodeStatus(node.workStatus),

      /*
       * The date under the site name is WHEN THE SITE WENT IN PROGRESS -- one moment,
       * for both statuses that have reached it:
       *
       *   In Progress   -> since when it has been in progress
       *   Completed     -> since when it went in progress (NOT its completion date)
       *   Yet to Start  -> "--", because it has no in-progress moment at all
       *
       * NO FALLBACK TO THE START DATE. A start date is when work was scheduled to
       * begin, not when it began, and printing one here would answer a different
       * question than the column asks. Where the transition was never recorded the
       * cell says "--" and the tooltip says why.
       *
       * THAT IS MOST COMPLETED SITES: 33 of 39 have no In Progress entry in their
       * status log, and the nodeStatus.updateDate fallback cannot stand in for them --
       * on a completed node that stamp is when it was marked COMPLETE, not when work
       * started. 107 of 124 in-progress sites do have a date.
       */
      ...(() => {
        const mapped = mapNodeStatus(node.workStatus);
        const since = mapped === STATUS.YET_TO_START ? null : node.inProgressSince || null;

        return {
          start: since || '--',
          startKind: mapped === STATUS.YET_TO_START ? 'notStarted' : since ? 'inProgress' : 'unrecorded',
          // No date means no age to measure; "0mo" would read as "started this month".
          duration: since ? monthsSince(since) : null,
        };
      })(),

      routeName: node.routeName,
      companyName: node.companyName,

      // LIVE: milestone progress and daily reports.
      milestones: m ? m.milestones : null,
      milestonesMapped: m ? m.milestonesMapped : false,
      reports: m ? m.reports : null,
      reportDays: m ? m.reportDays : null,
      lastReport: m ? m.lastReport : null,
      stagePhotos: m ? m.stagePhotos : null,

      /**
       * PHOTOS column = (all photo fields - fields without media) / all photo fields.
       *
       * The client's formula, given against Eureka: (150 fields + 18 N/A - 112 without
       * media) / (150 + 18) = 56/168 = 33%. Both figures come from the backend, and the
       * Site Monitor's "Photos uploaded" bar reads the same two, so one node cannot show
       * two numbers across the tabs.
       *
       * The numerator counts N/A and Not Required fields as satisfied -- nobody has to
       * photograph them -- which is why it can exceed the count of fields with media.
       *
       * Not photos/fields: a field takes many photos, so that ratio can exceed 100%
       * (554 photos across 154 fields = 360%).
       *
       * Approved media over total media (48/709 = 7% on Boligee) was the headline here
       * briefly. That is a reviewer sign-off rate rather than upload progress; it stays
       * in this cell's tooltip and in the Site Monitor's Node Media strip.
       */
      photosUploaded: m ? m.fieldsSettled : null,
      photosTotal: m ? m.fieldsAll : null,
      photosPct: m ? m.coveragePct : null,

      /** Media approval, kept for the tooltip: it is a different question. */
      approvedMedia: m ? m.approvedMedia : null,
      mediaApprovedPct: m ? m.mediaApprovedPct : null,
      photoFieldsDefined: m ? m.photoFields : null,
      naFields: m ? m.naFields || 0 : null,
      photoCount: m ? m.photos : null,
      photoPctApproximate: m ? m.photoPctApproximate === true : false,

      // Working days inside the observed reporting window that had no report.
      // NULL where the node never reported -- no window, so nothing to measure.
      missedDays: m ? m.missedDays : null,
    };

    // OVERALL blends the three columns above; it needs the finished row to read them.
    return { ...row, ...overallFrom(row) };
  });
}

export const SORTS = {
  // `?? -1` keeps NULL metrics from sorting as 0 and appearing "best".
  'Site name': (a, b) => a.name.localeCompare(b.name),
  Overall: (a, b) => (b.overallPct ?? -1) - (a.overallPct ?? -1),
  'Start date': (a, b) => String(a.start).localeCompare(String(b.start)),
};

export function filterSites(sites, { query, status, sort }) {
  let rows = sites;

  if (query.trim()) {
    const needle = query.trim().toLowerCase();
    rows = rows.filter((s) => s.name.toLowerCase().includes(needle));
  }
  if (status !== 'All') {
    rows = rows.filter((s) => s.status === status);
  }

  // Copy before sorting so the caller's array is never mutated.
  return [...rows].sort(SORTS[sort] || SORTS['Site name']);
}
