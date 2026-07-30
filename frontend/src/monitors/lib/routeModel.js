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

export const SORTS = {
  'Site name': (a, b) => a.name.localeCompare(b.name),
  Overall: (a, b) => b.photosPct - a.photosPct,
  'Start date': (a, b) => a.start.localeCompare(b.start),
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
