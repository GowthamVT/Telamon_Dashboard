/**
 * S3Document: what counts as a document, and what "missing" can mean.
 *
 * The Site Monitor's TOTAL DOCUMENTS / UPLOADED % / MISSING cards read this
 * collection. It holds 153,929 rows database-wide and 3,466 for Telamon, but most
 * of those are not documents anyone uploaded.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS EXCLUDED, AND WHY -- measured, not assumed.
 *
 *   SITE_SUMMARY_JSONS folder   2,686 of Telamon's 3,466 rows. Machine-written
 *                               site summaries, authored by PYGLOBAL, pyservice
 *                               and ECSITE-ADMIN-3. Counting them would report
 *                               2,686 "documents" on nodes where a crew uploaded
 *                               nothing at all.
 *   typeOfDocument 'folder'     4 rows. A folder is not a file.
 *   'required_placeholder'      An expectation, not an upload -- see below.
 *   isDeleted: true             328 rows.
 *
 * That leaves 448 real documents across 84 of 202 nodes.
 *
 * KEPT DELIBERATELY: 81 rows whose typeOfDocument is a mangled mime string
 * ("pdf;base64,JVBERi0xL", "octet-stream;base64,QXBwUmVnI"). The category field was
 * corrupted on write, but these are genuine uploads by named people
 * (chelsea.mclaughlin@telamon.com, amybeth.moe@telamon.com,
 * anthonywilliams@intechtn.com), so dropping them would undercount real work.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * WHY "MISSING" IS NULL FOR TELAMON TODAY
 *
 * A document can only be missing if something says it was expected. ECSite has
 * exactly that feature: a row with typeOfDocument 'required_placeholder' and
 * properties.requiredPlaceholder = true, generated from a document template
 * (requiredTemplateId / requiredFileId). It is a real mechanism in active use --
 * 642 placeholders exist, 341 for META and 301 for mortenson.com.
 *
 * TELAMON HAS ZERO. Nothing in the source states which documents a Telamon node
 * ought to have, and no collection defines an expected set: DocumentType,
 * RequiredDocument, DocumentChecklist, DocumentTemplate and eight other candidate
 * names were all probed and are absent or empty. `list[].type` on
 * FormBuilderQuestions is null on all 44,379 fields, so document fields cannot be
 * told apart from photo fields either, and ProgressStats covers only photolist
 * stage forms.
 *
 * So MISSING and UPLOADED % report null -- rendered "--" -- rather than a number
 * derived from a rule we invented. The alternative considered and rejected was to
 * treat the observed type catalogue (COP_Docs, CD, Electrical_Permit, Fiber
 * Results, RFDS, Other_Docs) as the expected set, which would have been our rule
 * and not the client's. That mistake has already been made once on this dashboard
 * with the M1-M4 stage mapping.
 *
 * The code below computes both figures properly the moment placeholders appear, so
 * configuring required documents in the portal is all that is needed.
 * ---------------------------------------------------------------------------
 */

/** Marks a row as the app's "this document is required but absent" placeholder. */
const REQUIRED_PLACEHOLDER_TYPE = 'required_placeholder';

/**
 * Machine-written summaries, keyed by the S3 folder in `tag`.
 *
 * Matched on the tag path rather than on createdBy: service accounts also upload
 * legitimate documents (ECSITE-ADMIN-3 authored the Cable Routing and Cross
 * Reference reports), so filtering by author would discard real files.
 */
const SYSTEM_FOLDER_PATTERN = /SITE_SUMMARY_JSONS/;

/*
 * These are aggregation EXPRESSIONS, for use inside $cond -- not query predicates.
 * Both counts have to come from one $group pass over the same rows, so a $match
 * cannot do the filtering: `{ tag: { $not: /.../ } }` is a query form and is
 * silently meaningless inside $cond.
 */

/** True when the row is a document a person uploaded. */
const NOT_A_DOCUMENT_EXPR = {
  $and: [
    {
      $not: {
        $regexMatch: { input: { $ifNull: ['$tag', ''] }, regex: SYSTEM_FOLDER_PATTERN },
      },
    },
    { $not: { $in: [{ $ifNull: ['$typeOfDocument', ''] }, ['folder', REQUIRED_PLACEHOLDER_TYPE]] } },
  ],
};

/** True when the row records an expectation rather than an upload. */
const IS_PLACEHOLDER_EXPR = {
  $or: [
    { $eq: ['$typeOfDocument', REQUIRED_PLACEHOLDER_TYPE] },
    {
      $regexMatch: { input: { $ifNull: ['$properties', ''] }, regex: /requiredPlaceholder/ },
    },
  ],
};

/**
 * Upload percentage.
 *
 * Null when nothing declares an expectation -- with no denominator the honest
 * answer is "unknown", and 100% would be the most misleading possible reading of
 * "no required documents configured".
 */
function documentPct({ uploaded, required }) {
  const expected = Number(uploaded || 0) + Number(required || 0);
  if (!required || expected <= 0) return null;
  return Math.min(100, Math.round((Number(uploaded || 0) / expected) * 100));
}

module.exports = {
  REQUIRED_PLACEHOLDER_TYPE,
  SYSTEM_FOLDER_PATTERN,
  NOT_A_DOCUMENT_EXPR,
  IS_PLACEHOLDER_EXPR,
  documentPct,
};
