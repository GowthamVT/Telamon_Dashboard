/**
 * S3Document: what counts as a document, and what "missing" can mean.
 *
 * The Site Monitor's TOTAL DOCUMENTS / UPLOADED % / MISSING cards read this
 * collection. It holds 153,929 rows database-wide and 3,466 for Telamon, but most
 * of those are not documents anyone uploaded.
 *
 * ---------------------------------------------------------------------------
 * A DOCUMENT IS AN UNTAGGED ROW. Anything with a `tag` belongs to another view.
 *
 * `tag` holds the S3 folder a row was filed under, and the portal's Node Documents
 * page lists only rows with no tag at all. Verified on Knolls, where the portal
 * header reports both a count and a size:
 *
 *     portal   FILES 5 / 1000     SIZE 1.60 MB / 2.00 GB
 *     untagged rows               5 files, 1.60 MB
 *
 * Two independent quantities agreeing is what makes this the portal's rule rather
 * than a coincidence. Knolls' 30 live rows break down as:
 *
 *     tag SITE_SUMMARY_JSONS   23   machine-written summaries, author PYGLOBAL
 *     tag COP                   2   KNOLLS_PHOTOS.zip / .pdf, close-out package
 *     no tag                    5   the five the portal lists
 *
 * The COP pair is why an earlier version reported 7 against the portal's 5. They
 * are real files uploaded by real people (marc.hungerford@telamon.com,
 * amybeth.moe@telamon.com) but they live in the portal's COP area, not under Node
 * Documents, so counting them here double-counts a different screen's contents.
 * Excluding only the JSON folder was not enough.
 *
 * Also excluded: form-field attachments (see documentLevel below), typeOfDocument
 * 'folder' (a folder is not a file), 'required_placeholder' (an expectation, not an
 * upload -- see below), and isDeleted rows.
 *
 * That leaves 220 documents estate-wide across 51 of 202 nodes, narrowed twice:
 * 448 with the JSON-only rule, 301 once tagged rows went, 220 once form attachments
 * did. Per node: Knolls 5, Basile 4, Wadley 6, GBII > Bowling Green 0.
 *
 * VERIFIED against the portal on two nodes, each of which caught a different bug:
 *   Knolls              FILES 5 / 1000, SIZE 1.60 MB   -> 5 files, 1.60 MB
 *   GBII > Bowling Green 0 documents                   -> 0
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
 * `documentsRequired` is therefore 0 everywhere, and no card reports it. The
 * alternative considered and rejected was to treat the observed type catalogue
 * (COP_Docs, CD, Electrical_Permit, Fiber Results, RFDS, Other_Docs) as the expected
 * set, which would have been our rule and not the client's -- the same mistake as
 * the retired M1-M4 stage mapping.
 *
 * The two cards that once waited on this now read figures the portal publishes:
 *   UPLOADED %   files against the per-node allowance   (see documentUsagePct)
 *   MISSING      "Total Fields without Media"           (metrics.incompleteFields)
 *
 * The count is still collected, so a required-document template configured in the
 * portal starts reporting immediately rather than needing new queries.
 * ---------------------------------------------------------------------------
 */

/** Marks a row as the app's "this document is required but absent" placeholder. */
const REQUIRED_PLACEHOLDER_TYPE = 'required_placeholder';

/*
 * These are aggregation EXPRESSIONS, for use inside $cond -- not query predicates.
 * Both counts have to come from one $group pass over the same rows, so a $match
 * cannot do the filtering: `{ tag: { $not: /.../ } }` is a query form and is
 * silently meaningless inside $cond.
 */

/**
 * True when the row is a document the portal lists under Node Documents.
 *
 * TWO conditions, each learned from a node where the dashboard disagreed with the
 * portal:
 *
 * 1. NO TAG. `tag` is the S3 folder a row was filed under, and a filed row belongs
 *    to another screen -- SITE_SUMMARY_JSONS to nothing user-facing, COP to the
 *    close-out package area. Matching only the JSON folder let Knolls' two COP files
 *    through and reported 7 where the portal says 5.
 *
 * 2. documentLevel === 'node'. Rows with no documentLevel are FORM-FIELD
 *    ATTACHMENTS -- a file uploaded against a question inside a form, carrying
 *    answerSetId, formId and questionId. The portal shows those under the form, not
 *    under Node Documents, which is why GBII > Bowling Green reads 0 documents while
 *    holding two such files ("Bowling Green - Permit V2.pdf", "5874 ATS WELDING ILA
 *    HUT BG CTR 2.pdf", both by chelsea.mclaughlin@telamon.com).
 *
 * The split is exact across every untagged Telamon row -- 220 with
 * documentLevel 'node' and no answer linkage, 81 with an answerSetId and no
 * documentLevel, and nothing in between. `documentLevel: 'site'` also exists and is
 * excluded for the same reason: a site document is not a node document.
 *
 * The tag test covers a missing key, an explicit null and an empty string; all
 * three occur in the data.
 */
const NOT_A_DOCUMENT_EXPR = {
  $and: [
    { $in: [{ $ifNull: ['$tag', null] }, [null, '']] },
    { $eq: ['$documentLevel', 'node'] },
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
 * UPLOADED % -- the portal's own figure: files against the per-node file allowance.
 *
 *     portal    FILES 5 / 1000    0.5%
 *     ours      5 / 1000       -> 0.5%
 *
 * BE CLEAR ABOUT WHAT THIS MEASURES. It is allowance consumed, not work completed.
 * 0.5% does not mean 0.5% of the required documents are in; it means the node is
 * using 0.5% of the 1,000 files it may store. A node could be finished and still
 * read 0.5%. The portal shows it beside a storage bar where that reading is obvious;
 * on a completion dashboard the label carries more weight than it can bear.
 *
 * It is reported because it was asked for and it reproduces the portal exactly. The
 * completion reading it invites is not available from this source -- see the note
 * above on required-document templates.
 *
 * One decimal place, matching the portal: 5/1000 is 0.5%, and rounding to whole
 * percent would show 0% and look like nothing had been uploaded.
 */
function documentUsagePct({ uploaded, limit }) {
  const cap = Number(limit || 0);
  if (cap <= 0) return null;
  const used = Number(uploaded || 0);
  if (!Number.isFinite(used)) return null;
  return Math.round((used / cap) * 1000) / 10;
}

module.exports = {
  REQUIRED_PLACEHOLDER_TYPE,
  NOT_A_DOCUMENT_EXPR,
  IS_PLACEHOLDER_EXPR,
  documentUsagePct,
};
