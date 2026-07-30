/**
 * MOCK DATA for the Site Completion Monitor.
 *
 * MILESTONES is the *checklist definition* -- which documents a site owes at each
 * milestone. That is reference/config data, not measurements, so it may well end
 * up as a small Snowflake dimension table (or stay in code if it rarely changes).
 *
 * `completion` is the *measured state* -- which of those documents actually
 * exist. That is what comes from Snowflake per site.
 *
 * Item types:
 *   file  satisfied when a document has been uploaded (fileName present)
 *   text  satisfied when a non-empty value has been captured (textValue present)
 *
 * See ../DATA_REQUIREMENTS.md for the mapping notes.
 */

export const SITE = {
  name: 'Bowling Green',
  route: 'LUMEN_HD_LOUISVILLE_INDIANAPOLIS',
  start: '2026-07-10',
};

export const PHOTOS = { uploaded: 18, total: 60 };
export const REPORTS = { submitted: 4, missedDays: 2 };

export const MILESTONES = [
  {
    id: 1,
    label: 'M1',
    name: 'CD Drawings',
    items: [
      { id: 'm1-cd-approved', label: 'CD Approved', type: 'file' },
      { id: 'm1-electrical-drawings', label: 'Electrical or One Line Drawings Approved', type: 'file' },
      { id: 'm1-final-planning', label: 'Submitted Final Planning', type: 'file' },
      { id: 'm1-pe-stamped', label: 'Construction Drawings PE Stamped', type: 'file' },
      { id: 'm1-lien-waiver', label: 'Conditional Lien Waiver for GC and Subtrades', hint: 'Milestone 1 tasks', type: 'file' },
    ],
  },
  {
    id: 2,
    label: 'M2',
    name: 'Permitting & Foundation',
    items: [
      { id: 'm2-building-permit', label: 'Building permit pulled if required', section: 'Permitting', type: 'file' },
      { id: 'm2-electrical-permit', label: 'Electrical permit pulled if applicable', section: 'Permitting', type: 'file' },
      { id: 'm2-zoning-package', label: 'Zoning packages if applicable', hint: 'ZD, application, approved permit, fee documentation', section: 'Permitting', type: 'file' },
      { id: 'm2-construction-permit', label: 'Construction permit package', hint: 'Applications, approved permits, fee documentation', section: 'Permitting', type: 'file' },
      { id: 'm2-application-number', label: 'Application number', section: 'Utility', type: 'text' },
      { id: 'm2-account-number', label: 'Account number', section: 'Utility', type: 'text' },
      { id: 'm2-copy-application', label: 'Copy of Application', section: 'Utility', type: 'file' },
      { id: 'm2-inspection-test', label: 'Inspection and test documents', hint: 'Rebar, grounding, alike', section: 'Rebar Cage & Inspection', type: 'file' },
      { id: 'm2-concrete-test', label: 'Concrete test document or slump test', section: 'Concrete Foundation', type: 'file' },
    ],
  },
  {
    id: 3,
    label: 'M3',
    name: 'Shelter, Fencing & Electrical',
    items: [
      { id: 'm3-rigging-plan', label: 'Copy of authorized lifting rigging plan prior to shelter pick', section: 'Shelter Placement', type: 'file' },
      { id: 'm3-fence-drawing', label: 'Provide drawing of fence or gate if applicable', section: 'Fencing & Gates', type: 'file' },
      { id: 'm3-lien-waiver', label: 'Conditional lien waiver for GC and subtrades', hint: 'Milestone 3', section: 'Electrical', type: 'file' },
    ],
  },
  {
    id: 4,
    label: 'M4',
    name: 'Commissioning & Signoff',
    items: [
      { id: 'm4-hazmat', label: 'Inspection reports and hazmat signage', section: 'Generator', type: 'file' },
      { id: 'm4-load-bank', label: 'Load bank testing documentation', section: 'Generator', type: 'file' },
      { id: 'm4-ground-test', label: 'Ground test results', section: 'Inside Plant', type: 'file' },
      { id: 'm4-fiber-test', label: 'Fiber test results MH0 into shelter at OSX', section: 'Inside Plant', type: 'file' },
      { id: 'm4-otdr', label: 'OTDR results', section: 'Inside Plant', type: 'file' },
      { id: 'm4-commission-utility', label: 'Commission Utility', section: 'Commissioning Activities', type: 'file' },
      { id: 'm4-noc', label: 'NOC', section: 'Back Office Review', type: 'file' },
      { id: 'm4-cits', label: 'CITS', section: 'Back Office Review', type: 'file' },
      { id: 'm4-fops', label: 'FOPS', section: 'Back Office Review', type: 'file' },
      { id: 'm4-ticket-numbers', label: 'Ticket Numbers', section: 'Back Office Review', type: 'file' },
      { id: 'm4-ahj-signoff', label: 'Inspection or permit sign off AHJ', section: 'Permit Signoff', type: 'file' },
      { id: 'm4-cert-occupancy', label: 'Certificate of Occupancy if required', section: 'Permit Signoff', type: 'file' },
      { id: 'm4-lumen-cm-signoff', label: 'Lumen CM sign off', section: 'Permit Signoff', type: 'file' },
    ],
  },
];

/** Measured state: which documents exist, which values are captured, what is N/A. */
export const COMPLETION = {
  files: {
    'm1-cd-approved': { fileName: 'CD_Set_Rev3.pdf', uploadedAt: '2026-07-10' },
    'm1-electrical-drawings': { fileName: 'Electrical_OneLine_Approved.pdf', uploadedAt: '2026-07-10' },
    'm1-final-planning': { fileName: 'Final_Planning_Submittal.pdf', uploadedAt: '2026-07-10' },
    'm1-pe-stamped': { fileName: 'CD_PE_Stamped.pdf', uploadedAt: '2026-07-10' },
    'm1-lien-waiver': { fileName: 'Lien_Waiver_M1.pdf', uploadedAt: '2026-07-10' },
    'm2-building-permit': { fileName: 'Building_Permit.pdf', uploadedAt: '2026-07-12' },
    'm2-electrical-permit': { fileName: 'Electrical_Permit.pdf', uploadedAt: '2026-07-12' },
    'm2-zoning-package': { fileName: 'Zoning_Package.zip', uploadedAt: '2026-07-14' },
    'm2-construction-permit': { fileName: 'Construction_Permit_Package.zip', uploadedAt: '2026-07-14' },
    'm2-inspection-test': { fileName: 'Rebar_Ground_Inspection.pdf', uploadedAt: '2026-07-18' },
    'm3-rigging-plan': { fileName: 'Rigging_Plan_Shelter.pdf', uploadedAt: '2026-07-20' },
  },
  values: {
    'm2-application-number': 'APP-2026-00142',
    'm2-account-number': '8834021',
  },
  /** Explicitly not applicable for this site -- excluded from the denominator. */
  notApplicable: {
    'm2-zoning-package': true,
    'm4-cert-occupancy': true,
  },
};

/** Swap this for an API call once the source tables are known. */
export function loadSiteMonitor() {
  return { site: SITE, photos: PHOTOS, reports: REPORTS, milestones: MILESTONES, completion: COMPLETION };
}
