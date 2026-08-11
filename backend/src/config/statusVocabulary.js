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
 * RETIRED. This matched item names for "if applicable" / "If Required" and
 * marked them N/A when they had no evidence.
 *
 * It was removed because it contradicted the source. The portal reports
 * "Not Applicable" = 0 for Basile, taken from the per-FIELD flag
 * (ProgressStats.n_a, also 0), while this rule produced 2 -- "Fencing & Gates -
 * if applicable" and "Utility Construction (If Required)". A number the reader
 * compares against the portal must come from the same place the portal gets it,
 * not from a guess about wording.
 *
 * Kept exported so anything still importing it fails loudly rather than silently
 * getting undefined.
 */
const OPTIONAL_ITEM = null;

/**
 * Collapse a checklist item to the three statuses the dashboard reports:
 * Complete / Missing / N/A.
 *
 * N/A now has exactly ONE meaning at item level: the item is not part of this
 * node's checklist. It exists on the node as a form but was never required of the
 * crew, so "Missing" would be a false accusation. That is a fact about the data,
 * not an inference.
 *
 * The previous wording-based rule ("if applicable" -> N/A) has been removed; see
 * OPTIONAL_ITEM above for why.
 *
 * An item with evidence is Complete regardless -- work that was actually done is
 * never reported as not-applicable.
 *
 * The per-FIELD N/A flag (ProgressStats.n_a) is a different thing at a different
 * grain, and drives the photo-coverage denominator. Do not conflate the two.
 */
function classifyItemStatus({ name, done, inChecklist }) {
  if (done) return { status: 'complete', statusReason: null };
  if (!inChecklist) {
    return { status: 'na', statusReason: 'not required by this node’s checklist' };
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
