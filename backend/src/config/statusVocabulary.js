/**
 * Status and item-status vocabulary for the Completion Monitors.
 *
 * These are BUSINESS RULES, not source data: how the warehouse's status strings
 * map onto the three words the dashboard reports, and when a checklist item
 * counts as Complete / Missing / N/A. They lived in the Snowflake service and
 * were imported from there by the MongoDB one; now that MongoDB is the only
 * source they belong in config, next to the milestone definitions.
 */

/** Default tenant scope until per-user auth is wired. */
const DEFAULT_COMPANY_PATTERN = '%Telamon%';

/** Bucket for nodes that carry no status at all. */
const NO_HISTORY = '(no status history)';

/**
 * Status vocabulary translation.
 *
 * The dashboards speak Complete / In Progress / Yet to Start. The source's node
 * status holds six values, verified against the live data:
 *   IN PROGRESS (108)  COP APPROVED (39)  YET TO START (36)
 *   COP SENT (9)       INACTIVE (6)       COP REJECTED (4)
 *
 * COP = Certificate of Provisioning. "Sent" means submitted but not yet signed
 * off, so it is still in flight; approval is the finish line -- the node record
 * carries matching COP Approved / COP Completed dates, which is the evidence for
 * treating approval as complete.
 *
 * Unmapped values are returned under `unmapped` by the caller rather than being
 * dropped, so a new status shows up as a visible gap instead of quietly
 * vanishing from the totals.
 */
const STATUS_MAP = {
  // Work under way.
  'in-progress': 'inProgress',
  'in progress': 'inProgress',
  inprogress: 'inProgress',
  'cop sent': 'inProgress',
  'cop rejected': 'inProgress',
  // Finished.
  'cop approved': 'complete',
  'cop completed': 'complete',
  // Not started.
  'yet to start': 'yetToStart',
  yettostart: 'yetToStart',
  inactive: 'yetToStart',
  [NO_HISTORY]: 'yetToStart',
  // Generic spellings, kept so a renamed status still lands somewhere sensible.
  complete: 'complete',
  completed: 'complete',
  closed: 'complete',
};

function classifyStatus(raw) {
  if (!raw) return null;
  return STATUS_MAP[String(raw).trim().toLowerCase()] || null;
}

/**
 * Items the checklist itself marks as conditional. This is the client's own
 * wording -- "Fencing & Gates - if applicable", "Utility Construction (If
 * Required)" -- so it is read from real data, not invented.
 */
const OPTIONAL_ITEM = /\b(if\s+applicable|if\s+required|optional)\b/i;

/**
 * Collapse a checklist item to the three statuses the dashboard reports:
 * Complete / Missing / N/A.
 *
 * ITEM-LEVEL N/A IS INFERRED. There is no per-item N/A flag in the source, so
 * N/A here comes from two signals, both defensible but neither authoritative:
 *
 *   1. The item is not part of this node's checklist at all. It exists on the
 *      node as a form but was never required of the crew, so "missing" would be
 *      a false accusation.
 *   2. The item's own name marks it conditional ("if applicable", "If
 *      Required"). The crew is not expected to complete it unless the site calls
 *      for it, so counting it as missing overstates the gap.
 *
 * An item with evidence is Complete regardless of either signal -- work that was
 * actually done is never reported as not-applicable.
 *
 * NOTE: a per-FIELD N/A flag DOES exist -- ProgressStats.n_a -- and it drives the
 * photo-coverage denominator. It is field-level, so it cannot decide the status
 * of a whole checklist item. Do not conflate the two.
 */
function classifyItemStatus({ name, done, inChecklist }) {
  if (done) return { status: 'complete', statusReason: null };
  if (!inChecklist) {
    return { status: 'na', statusReason: 'not required by this node’s checklist' };
  }
  if (OPTIONAL_ITEM.test(name || '')) {
    return { status: 'na', statusReason: 'the checklist marks this item conditional' };
  }
  return { status: 'missing', statusReason: null };
}

module.exports = {
  DEFAULT_COMPANY_PATTERN,
  NO_HISTORY,
  STATUS_MAP,
  classifyStatus,
  OPTIONAL_ITEM,
  classifyItemStatus,
};
