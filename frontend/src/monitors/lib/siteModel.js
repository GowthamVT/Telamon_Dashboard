/**
 * Site Completion Monitor derivation.
 *
 * The key rule: N/A items are excluded from BOTH numerator and denominator.
 * Counting them as incomplete would permanently cap a site below 100%; counting
 * them as complete would inflate it. Excluding them is the only honest option,
 * so "12 of 14 documents" can legitimately mean 100%.
 */
import { percent } from './status';

export const ITEM_STATUS = {
  COMPLETE: 'Complete',
  MISSING: 'Missing',
  NA: 'NA',
};

/** Is a single checklist item satisfied by the measured state? */
export function isSatisfied(item, completion) {
  if (item.type === 'text') {
    const value = completion.values?.[item.id];
    return typeof value === 'string' && value.trim().length > 0;
  }
  return Boolean(completion.files?.[item.id]);
}

export function itemStatus(item, completion) {
  if (completion.notApplicable?.[item.id]) return ITEM_STATUS.NA;
  return isSatisfied(item, completion) ? ITEM_STATUS.COMPLETE : ITEM_STATUS.MISSING;
}

/** Flatten the checklist definition into one list of documents with status. */
export function flattenItems(milestones, completion) {
  return milestones.flatMap((milestone) =>
    milestone.items.map((item) => ({
      ...item,
      milestone: milestone.label,
      milestoneName: milestone.name,
      status: itemStatus(item, completion),
      fileName: completion.files?.[item.id]?.fileName || null,
      value: completion.values?.[item.id] || null,
    }))
  );
}

/** Per-milestone progress, with N/A items removed from the denominator. */
export function milestoneProgress(milestones, completion) {
  return milestones.map((milestone) => {
    const applicable = milestone.items.filter((item) => !completion.notApplicable?.[item.id]);
    const done = applicable.filter((item) => isSatisfied(item, completion)).length;
    return {
      ...milestone,
      done,
      total: applicable.length,
      // A milestone whose every item is N/A is vacuously complete, not 0%.
      pct: applicable.length === 0 ? 100 : percent(done, applicable.length),
    };
  });
}

export function summarise({ milestones, completion }) {
  const items = flattenItems(milestones, completion);
  const progress = milestoneProgress(milestones, completion);

  const naCount = items.filter((i) => i.status === ITEM_STATUS.NA).length;
  const applicable = items.length - naCount;
  const complete = items.filter((i) => i.status === ITEM_STATUS.COMPLETE).length;

  const milestonesDone = progress.filter((m) => m.pct === 100).length;
  const milestonesNotStarted = progress.filter((m) => m.pct === 0).length;

  return {
    items,
    progress,
    totalDocuments: items.length,
    naCount,
    applicable,
    complete,
    missing: applicable - complete,
    overallPct: applicable === 0 ? 100 : percent(complete, applicable),
    milestonesDone,
    milestonesNotStarted,
    milestonesInProgress: progress.length - milestonesDone - milestonesNotStarted,
    milestoneCount: progress.length,
  };
}

/** Overall site status, mirroring the route monitor's vocabulary. */
export function siteStatus(summary) {
  if (summary.milestonesDone === summary.milestoneCount) return 'Complete';
  if (summary.milestonesNotStarted === summary.milestoneCount) return 'Yet to Start';
  return 'In Progress';
}

const STATUS_ORDER = { [ITEM_STATUS.MISSING]: 0, [ITEM_STATUS.COMPLETE]: 1, [ITEM_STATUS.NA]: 2 };

export function filterItems(items, { query, status, milestone, sort }) {
  let rows = items;

  if (query.trim()) {
    const needle = query.trim().toLowerCase();
    rows = rows.filter((i) => i.label.toLowerCase().includes(needle));
  }
  if (status === 'Complete') rows = rows.filter((i) => i.status === ITEM_STATUS.COMPLETE);
  if (status === 'Incomplete') rows = rows.filter((i) => i.status === ITEM_STATUS.MISSING);
  if (status === 'NA') rows = rows.filter((i) => i.status === ITEM_STATUS.NA);
  if (milestone !== 'All milestones') rows = rows.filter((i) => i.milestone === milestone);

  // Default order is the checklist's own order, which is the order work happens
  // in -- so only sort when the user explicitly asks for something else.
  if (sort === 'Status') {
    rows = [...rows].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  } else if (sort === 'Name') {
    rows = [...rows].sort((a, b) => a.label.localeCompare(b.label));
  }

  return rows;
}
