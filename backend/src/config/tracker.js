/**
 * TELAMON-ILA-TRACKER: the client's own milestone definition.
 *
 * The tracker is the form the portal exposes under Form Answers, with columns
 * Task ID, Task, Milestone, Responsible Party, Estimated Complete Date, Partner
 * Complete Date, Conditional Approved Date, Final Complete Date, Lumen
 * Accept/Reject, Notes.
 *
 * This is where milestones actually live. Nothing else in the source carries a
 * milestone field -- all 122 MongoDB collections were sampled and none has one --
 * so the previous approach mapped photolist STAGE NAMES to milestones using a
 * rule written here in config. That rule was ours, not the client's. The tracker
 * is theirs.
 *
 * -------------------------------------------------------------------------
 * MILESTONES M1..M4
 *
 * Four, by request. The portal's dropdown offers Milestone 1..5 plus Signature, and
 * the one populated tracker (LUMEN-ILA-SANDBOX, 251 rows) tags two tasks "Milestone
 * 5" -- those two now resolve to no milestone and show a "--" chip rather than being
 * folded into M4.
 *
 * IMPORTANT: that tracker holds the task DEFINITIONS and their milestones, and no
 * completion data at all. Across all 251 rows there is not one date-like value in
 * any of the four date columns, and no Lumen acceptance. So it can tell us which
 * milestone a task belongs to, but not whether anything is done.
 * -------------------------------------------------------------------------
 */

const TRACKER_FORM_NAME = 'TELAMON-ILA-TRACKER';

/** Field labels on the tracker form, in the order the portal shows them. */
const TRACKER_FIELDS = [
  'Task ID',
  'Task',
  'Milestone',
  'Responsible Party',
  'Estimated Complete Date',
  'Partner Complete Date',
  'Conditional Approved Date',
  'Final Complete Date',
  'Lumen Accept/Reject',
  /*
   * ADDED LATER BY THE CLIENT, and now the primary signal. A Dropdown whose
   * options are "Inprogress", "Completed", "Yet to start". Stored as an option
   * KEY (a GUID), so the value is translated back to its label before it gets
   * here -- see optionLabel() in monitorService.getNodeTracker.
   */
  'Status',
  'Notes',
];

const TRACKER_MILESTONES = [
  { key: 'm1', label: 'M1', name: 'Drawings Completed' },
  { key: 'm2', label: 'M2', name: 'Design, Engineering & General Construction' },
  { key: 'm3', label: 'M3', name: 'Shelter, Fencing & Electrical' },
  { key: 'm4', label: 'M4', name: 'Commissioning, ISP & Signoff' },
];

/**
 * Task ID group -> milestone, read off the populated sandbox tracker.
 *
 * Task IDs are `group-index` ("7-6", "11-15"). Grouping the sandbox's 233
 * milestone-tagged tasks by that prefix gives a clean, contiguous mapping:
 *
 *   group  1              -> M1   (5 tasks)
 *   groups 2,3,4,5,6,7,8  -> M2   (38 tasks)
 *   groups 9,10,11        -> M3   (57 tasks)
 *   groups 12..17         -> M4   (120 tasks)
 *   group  18             -> M5   (2 tasks)
 *
 * Used only as a FALLBACK. Where a task carries an explicit Milestone value that
 * value wins, because it is what the crew selected.
 *
 * On the sandbox the fallback is never needed -- all 223 real tasks carry an
 * explicit Milestone. It exists for the case where a crew fills in a task without
 * choosing one, which the free-text date columns show is possible.
 */
const GROUP_TO_MILESTONE = {
  1: 'm1',
  2: 'm2', 3: 'm2', 4: 'm2', 5: 'm2', 6: 'm2', 7: 'm2', 8: 'm2',
  9: 'm3', 10: 'm3', 11: 'm3',
  12: 'm4', 13: 'm4', 14: 'm4', 15: 'm4', 16: 'm4', 17: 'm4',
};

/**
 * "Milestone 3" | "M3" | "3" -> 'm3'. Null when unrecognised.
 *
 * The range is 1-4 by request. The sandbox tracker does contain two tasks tagged
 * "Milestone 5" (Task IDs in group 18); they now resolve to null, so they still
 * appear in the table with a "--" chip but count towards no milestone bar. Nothing
 * is hidden and nothing is folded into M4, which would be a mapping we invented.
 */
function milestoneFromValue(value) {
  if (!value) return null;
  const n = String(value).match(/([1-4])\s*$/);
  if (!n) return null;
  return 'm' + n[1];
}

/** "11-15" -> 'm3', via the group prefix. */
function milestoneFromTaskId(taskId) {
  if (!taskId) return null;
  const group = String(taskId).split('-')[0].trim();
  if (!/^\d+$/.test(group)) return null;
  return GROUP_TO_MILESTONE[Number(group)] || null;
}

/**
 * Milestone for one tracker task. The explicit selection wins; the Task ID group
 * is the fallback.
 */
function milestoneForTask({ milestone, taskId }) {
  return milestoneFromValue(milestone) || milestoneFromTaskId(taskId) || null;
}

/**
 * Status of one tracker task.
 *
 * There is a real sign-off chain here, which the stage-name model never had:
 *   Lumen Accept/Reject  -> accepted or rejected by the customer
 *   Final Complete Date  -> partner declares it finished
 *   Partner / Conditional dates, Estimated date -> in flight
 *
 * "complete" therefore means an actual date or acceptance, not "a photo exists".
 */
/**
 * Does a value actually look like a date?
 *
 * REQUIRED, not defensive. The tracker's date columns are free Short_Text, and
 * the sandbox contains rows where they hold the literal words "Partner", "Lumen"
 * and "Notes" -- column-owner labels, not dates. Treating any non-empty string as
 * a date marked 18 of those rows Complete and reported false progress.
 *
 * Across the whole sandbox tracker there are ZERO date-like values in any of the
 * four date columns, so this predicate currently rejects everything -- which is
 * the correct answer, not a bug.
 */
function looksLikeDate(value) {
  if (!value) return false;
  const v = String(value).trim();
  // 2026-08-11 | 8/11/2026 | 11-08-26 ... and nothing else.
  if (!/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(v)) return false;
  return !Number.isNaN(new Date(v.replace(/\./g, '/')).getTime());
}

/**
 * The crew's own Status dropdown -> a task state.
 *
 * "Inprogress" is the portal's spelling, one word; "Yet to start" is theirs too.
 * Matched loosely so "In Progress" and "Not started" also land correctly, and
 * anything unrecognised returns null so the sign-off chain still decides.
 */
function crewStatusFromValue(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith('complet')) return 'complete';
  if (v.startsWith('reject')) return 'rejected';
  if (v.replace(/[\s_-]/g, '').startsWith('inprogress')) return 'inProgress';
  if (v.startsWith('yet to start') || v.startsWith('not start') || v.startsWith('notstart')) {
    return 'notStarted';
  }
  return null;
}

function trackerTaskStatus(task) {
  /*
   * THE STATUS COLUMN WINS when it is set.
   *
   * It is a person stating where the task stands, which beats anything inferred
   * from the date columns -- and on this data those columns cannot be trusted
   * anyway: every non-empty value in them is a column-owner label ("Partner",
   * "Lumen"), never a date. Where Status is empty, the sign-off chain below is
   * unchanged, so nodes without the column behave exactly as before.
   */
  const crew = crewStatusFromValue(task.crewStatus);
  if (crew) return { status: crew, reason: `Status: ${String(task.crewStatus).trim()}` };

  const accept = String(task.lumenAcceptReject || '').trim().toLowerCase();
  if (accept.startsWith('reject')) return { status: 'rejected', reason: 'Lumen rejected' };
  if (accept.startsWith('accept') || accept === 'yes' || accept === 'approved') {
    return { status: 'complete', reason: 'Lumen accepted' };
  }
  if (looksLikeDate(task.finalCompleteDate)) {
    return { status: 'complete', reason: 'final complete date set' };
  }
  if (looksLikeDate(task.conditionalApprovedDate)) {
    return { status: 'inProgress', reason: 'conditionally approved' };
  }
  if (looksLikeDate(task.partnerCompleteDate)) {
    return { status: 'inProgress', reason: 'partner complete' };
  }
  if (looksLikeDate(task.estimatedCompleteDate)) {
    return { status: 'inProgress', reason: 'estimated date set' };
  }
  return { status: 'notStarted', reason: null };
}

/**
 * Section headers inside the task list.
 *
 * The sandbox contains rows whose Task text begins ">>>" (">>> Drawings
 * Completed") and rows with no Task ID at all. They are headings, not work, and
 * must not be counted in a denominator.
 */
function isSectionHeader(task) {
  const text = String(task.task || '').trim();
  if (text.startsWith('>>>')) return true;
  if (!task.taskId && text.endsWith(':')) return true;

  /*
   * The grid also contains COLUMN-OWNER label rows: Task reads "1 - CD Drawings"
   * with no Task ID, and the date columns literally hold "Partner" / "Lumen" /
   * "Notes". They describe who owns each column, so they are chrome, not work.
   */
  const owners = [task.partnerCompleteDate, task.finalCompleteDate, task.conditionalApprovedDate]
    .filter(Boolean)
    .map((v) => String(v).trim().toLowerCase());
  if (!task.taskId && owners.length && owners.every((v) => v === 'partner' || v === 'lumen')) {
    return true;
  }
  return false;
}

module.exports = {
  TRACKER_FORM_NAME,
  looksLikeDate,
  TRACKER_FIELDS,
  TRACKER_MILESTONES,
  GROUP_TO_MILESTONE,
  milestoneFromValue,
  milestoneFromTaskId,
  milestoneForTask,
  crewStatusFromValue,
  trackerTaskStatus,
  isSectionHeader,
};
