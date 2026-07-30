/**
 * MOCK DATA for the Route Completion Monitor.
 *
 * This is the seam where Snowflake plugs in. Replace `loadRouteMonitor()` with a
 * call to the API and nothing in the components changes -- they consume the
 * shape documented below.
 *
 * Required shape per site (one row per site on the route):
 *   name          TEXT     site label
 *   start         DATE     ISO yyyy-mm-dd, shown under the name
 *   duration      TEXT     planned duration label, e.g. "8mo"
 *   photosUploaded INT     photos actually uploaded
 *   photosTotal    INT     photos expected
 *   reports        INT     daily reports submitted
 *   missedDays     INT     days with no report submitted
 *   m1..m4         INT     0-100 completion per milestone
 *
 * See ../DATA_REQUIREMENTS.md for the per-visual mapping notes.
 */

export const ROUTE = { name: 'LUMEN_ILA_SALT_LAKE_CITY_SACRAMENTO' };

export const SITES = [
  { name: 'Auburn', start: '2025-11-18', duration: '8mo', photosUploaded: 130, photosTotal: 130, reports: 30, missedDays: 0, m1: 100, m2: 100, m3: 100, m4: 100 },
  { name: 'Susanville', start: '2025-12-02', duration: '7mo', photosUploaded: 120, photosTotal: 120, reports: 28, missedDays: 0, m1: 100, m2: 100, m3: 100, m4: 100 },
  { name: 'Winnemucca', start: '2026-01-05', duration: '6mo', photosUploaded: 140, photosTotal: 140, reports: 32, missedDays: 0, m1: 100, m2: 100, m3: 100, m4: 100 },
  { name: 'Bowling Green', start: '2026-07-10', duration: '1mo', photosUploaded: 18, photosTotal: 60, reports: 4, missedDays: 2, m1: 100, m2: 78, m3: 33, m4: 0 },
  { name: 'Blue Canyon', start: '2026-04-15', duration: '3mo', photosUploaded: 95, photosTotal: 130, reports: 22, missedDays: 1, m1: 100, m2: 100, m3: 60, m4: 20 },
  { name: 'Truckee', start: '2026-04-15', duration: '3mo', photosUploaded: 88, photosTotal: 120, reports: 20, missedDays: 3, m1: 100, m2: 90, m3: 55, m4: 10 },
  { name: 'Lovelock', start: '2026-04-15', duration: '3mo', photosUploaded: 60, photosTotal: 110, reports: 15, missedDays: 4, m1: 100, m2: 80, m3: 45, m4: 0 },
  { name: 'Mill City', start: '2026-04-15', duration: '3mo', photosUploaded: 100, photosTotal: 120, reports: 24, missedDays: 2, m1: 100, m2: 100, m3: 70, m4: 25 },
  { name: 'Snow Gulch', start: '2026-04-15', duration: '3mo', photosUploaded: 40, photosTotal: 100, reports: 9, missedDays: 4, m1: 100, m2: 65, m3: 30, m4: 0 },
  { name: 'Eureka', start: '2026-04-15', duration: '3mo', photosUploaded: 105, photosTotal: 130, reports: 26, missedDays: 1, m1: 100, m2: 100, m3: 50, m4: 15 },
  { name: 'Elko', start: '2026-04-15', duration: '3mo', photosUploaded: 70, photosTotal: 110, reports: 17, missedDays: 3, m1: 100, m2: 85, m3: 35, m4: 0 },
  { name: 'Oasis', start: '2026-04-15', duration: '3mo', photosUploaded: 50, photosTotal: 100, reports: 12, missedDays: 4, m1: 100, m2: 70, m3: 20, m4: 0 },
  { name: 'Fallon', start: '2026-01-15', duration: '6mo', photosUploaded: 0, photosTotal: 150, reports: 0, missedDays: 9, m1: 0, m2: 0, m3: 0, m4: 0 },
  { name: 'Hunter', start: '2026-01-15', duration: '6mo', photosUploaded: 0, photosTotal: 120, reports: 0, missedDays: 7, m1: 0, m2: 0, m3: 0, m4: 0 },
];

/** Swap this for an API call once the source tables are known. */
export function loadRouteMonitor() {
  return { route: ROUTE, sites: SITES };
}
