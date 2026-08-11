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
    return {
      ...site,
      status,
      photosUploaded: 0,
      photosPct: 0,
      reports: 0,
      milestones: [0, 0, 0, 0],
    };
  }

  return {
    ...site,
    status,
    photosPct: percent(site.photosUploaded, site.photosTotal),
    milestones: [site.m1, site.m2, site.m3, site.m4],
  };
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
    return {
      nodeId: node.nodeId,
      name: node.nodeName,
      start: node.startDate || '--',
      duration: node.nodeCode || '',
      rawStatus: node.workStatus || null,
      status: mapNodeStatus(node.workStatus),
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
       * PHOTOS column = photo fields covered / photo fields that APPLY.
       *
       * Not photos/fields: a field takes many photos, so that ratio can exceed
       * 100% (554 photos across 154 fields = 360%).
       *
       * The denominator is coverageDenominator, which excludes fields the app
       * marks N/A -- the same denominator the Site Monitor uses. Dividing by the
       * raw photoFields instead understates coverage badly wherever N/A is
       * common: LUMEN_ILA_SALT_LAKE_CITY_SACRAMENTO has 539 N/A fields of 2668,
       * so it read 328/2668 = 12% where the truth is 328/2130 = 15%. Falls back
       * to photoFields for any node with no ProgressStats documents.
       */
      photosUploaded: m ? m.fieldsCovered : null,
      photosTotal: m ? (m.coverageDenominator ?? m.photoFields) : null,
      /** Kept so the tooltip can show what was excluded and why. */
      photoFieldsDefined: m ? m.photoFields : null,
      naFields: m ? m.naFields || 0 : null,
      photosPct: m ? m.photoPct : null,
      photoCount: m ? m.photos : null,
      photoPctApproximate: m ? m.photoPctApproximate === true : false,

      // Working days inside the observed reporting window that had no report.
      // NULL where the node never reported -- no window, so nothing to measure.
      missedDays: m ? m.missedDays : null,
    };
  });
}

export const SORTS = {
  // `?? -1` keeps NULL metrics from sorting as 0 and appearing "best".
  'Site name': (a, b) => a.name.localeCompare(b.name),
  Overall: (a, b) => (b.photosPct ?? -1) - (a.photosPct ?? -1),
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
