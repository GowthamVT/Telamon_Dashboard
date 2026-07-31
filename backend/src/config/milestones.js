/**
 * Stage -> Milestone (M1..M4) mapping.
 *
 * This is a BUSINESS RULE, not warehouse data. No Snowflake table maps a
 * construction stage to a milestone; the grouping comes from the dashboard
 * design, cross-checked against the `section` labels in the Site Monitor's
 * document checklist (which match the Snowflake stage names almost exactly).
 *
 * Keys are stage names NORMALISED to lowercase alphanumerics, so that
 * "Rebar Cage & Inspection - Shelter/Generator" and
 * "Rebar Cage & Inspection - Shelter / Generator" both resolve to one key.
 * Matching is exact-on-normalised, never substring: "Electrical" and
 * "Excavation (Fiber and Electrical trenches)" would otherwise collide.
 *
 * ---------------------------------------------------------------------------
 * COVERAGE WARNING -- measured, not assumed.
 *
 * Of 182 Telamon nodes carrying photolist stages, this mapping matches only 65
 * (the standard LUMEN construction template). The other 117 use unrelated
 * checklists and match ZERO stages:
 *     "0MH PHOTOS"                    87 nodes  <- most common stage in the data
 *     "C01.04.xx" / "C01.05.xx" (WBS) 14 nodes
 *     Roof / Main Level n / Parking Garage n  (in-building DAS sites)
 *     "Site Photos", "None"
 *
 * Those nodes must render as "template not mapped", NOT as 0%. Reporting 0%
 * would say the work is undone when in truth it cannot be measured -- the same
 * distinction applied to M1 below. `classifyStage` returns null for them and
 * the service reports `mapped: false`, so it is visible rather than silent.
 * ---------------------------------------------------------------------------
 */

/** Milestone definitions, in display order. */
const MILESTONES = [
  {
    key: 'm1',
    label: 'M1',
    name: 'CD Drawings',
    /**
     * Intentionally empty. M1 is entirely document-based (CD Approved, One-Line
     * Drawings, Final Planning, PE Stamped, Lien Waiver) and no photo stage maps
     * to it. Its only possible source is document uploads, and
     * RAW_HEVO.CLOUD_ECSITE_S3DOCUMENT is empty (0 rows since March 2025), so M1
     * is unmeasurable today and reports as "no data" rather than 0%.
     */
    stages: [],
    unmeasurable: true,
    unmeasurableReason: 'Document-based; no photo stages and CLOUD_ECSITE_S3DOCUMENT is empty',
  },
  {
    key: 'm2',
    label: 'M2',
    name: 'Permitting & Foundation',
    stages: [
      'permitting',
      'constructionstarted', // assigned to M2 per decision (groundworks start)
      'siteprep',
      'excavationfiberandelectricaltrenches',
      'rebarcageinspectionsheltergenerator',
      'concretefoundationsheltergenerator',
      'utilityconstructionifrequired',
    ],
  },
  {
    key: 'm3',
    label: 'M3',
    name: 'Shelter, Fencing & Electrical',
    stages: ['shelterplacement', 'fencinggatesifapplicable', 'electrical'],
  },
  {
    key: 'm4',
    label: 'M4',
    name: 'Commissioning & Signoff',
    stages: ['generator', 'insideplant'],
  },
];

/**
 * Stages deliberately excluded from every milestone.
 *
 * "Supplemental Photos" is an open-ended catch-all: counting it would let a node
 * complete a milestone by uploading miscellaneous photos while real commissioning
 * work is outstanding.
 */
const EXCLUDED_STAGES = ['supplementalphotos'];

/** Normalise a raw stage name to its mapping key. */
function normaliseStage(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Milestone key for a stage name, or null if unmapped/excluded. */
function classifyStage(name) {
  const norm = normaliseStage(name);
  if (!norm || EXCLUDED_STAGES.includes(norm)) return null;
  const found = MILESTONES.find((m) => m.stages.includes(norm));
  return found ? found.key : null;
}

/** All normalised stage names that count toward any milestone. */
const MAPPED_STAGES = MILESTONES.flatMap((m) => m.stages);

/**
 * Guard: every stage key must be a bare lowercase alphanumeric token, because
 * these are interpolated into SQL IN-lists. They are authored here rather than
 * received from a request, but validating makes that guarantee explicit instead
 * of implicit.
 */
for (const stage of [...MAPPED_STAGES, ...EXCLUDED_STAGES]) {
  if (!/^[a-z0-9]+$/.test(stage)) {
    throw new Error(`Invalid stage key in milestones config: ${JSON.stringify(stage)}`);
  }
}

/** Minimum mapped stages for a node to be considered "on the standard template". */
const MIN_MAPPED_STAGES = 1;

module.exports = {
  MILESTONES,
  EXCLUDED_STAGES,
  MAPPED_STAGES,
  MIN_MAPPED_STAGES,
  normaliseStage,
  classifyStage,
};
