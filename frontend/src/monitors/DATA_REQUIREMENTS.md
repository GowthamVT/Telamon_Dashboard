# Monitor data requirements

What each visual needs, so the Snowflake tables can be mapped to it. The frontend
is finished and renders from mock data; wiring is a matter of replacing two
functions.

- `data/routeMock.js` → `loadRouteMonitor()` returns `{ route, sites[] }`
- `data/siteMock.js` → `loadSiteMonitor()` returns `{ site, photos, reports, milestones, completion }`

Both are pure functions today. Point them at `api.*` (see `src/api/client.js`) and
nothing in the components changes.

---

## Route Completion Monitor

**Grain: one row per site on a route.** Everything on the page is derived from
this one result set — there is no second query.

| Field | Type | Feeds |
|---|---|---|
| `name` | TEXT | SITE column, search filter |
| `start` | DATE | SITE sub-label, "Start date" sort |
| `duration` | TEXT | SITE sub-label (e.g. `8mo`) |
| `photosUploaded` | INT | PHOTOS column, OVERALL %, route hero figure |
| `photosTotal` | INT | PHOTOS denominator |
| `reports` | INT | DAILY REPORTS column, `DAILY REPORTS SUBMITTED` tile |
| `missedDays` | INT | DAILY REPORTS sub-label, `MISSED REPORT DAYS` tile, **status** |
| `m1`–`m4` | INT 0–100 | MILESTONES blocks |

### Derived, not stored (`lib/routeModel.js`)

- **Status** — `photosPct === 100 && missedDays === 0` → Complete;
  `missedDays >= 5` → Yet to Start; otherwise In Progress.
- **Yet-to-Start rows are zeroed** for display (photos, reports, milestones), so a
  site that never started cannot show partial progress. `missedDays` is kept from
  the raw row — that gap is real and hiding it would understate the problem.
- **Route avg %** is the mean of per-site percentages, *not* `SUM(uploaded)/SUM(total)`.
  This is deliberate: a totalled ratio lets one large site dominate the route figure.

If you'd rather these rules live in SQL, `summarise()` is the one place to move
them from.

---

## Site Completion Monitor

**Two different kinds of data**, worth keeping separate:

### 1. Checklist definition (reference/config)

`milestones[]` — which documents a site *owes* at each milestone. Rarely changes,
identical across sites. Either a small Snowflake dimension table or left in code.

| Field | Feeds |
|---|---|
| `label` | `M1`…`M4` chip + milestone filter |
| `name` | milestone filter option text |
| `items[].id` | join key to the measured state |
| `items[].label` | DOCUMENT column |
| `items[].section` / `hint` | DOCUMENT sub-label |
| `items[].type` | `file` \| `text` — decides what "satisfied" means |

### 2. Measured state (per site — this is the Snowflake part)

`completion` — what actually exists for this site:

| Field | Type | Meaning |
|---|---|---|
| `files[itemId]` | `{ fileName, uploadedAt }` | a `file` item is satisfied when present |
| `values[itemId]` | TEXT | a `text` item is satisfied when non-empty |
| `notApplicable[itemId]` | BOOL | excluded from completion entirely |

Plus site-level scalars:

| Field | Feeds |
|---|---|
| `site.name` / `site.route` / `site.start` | header, ROUTE card |
| `photos.uploaded` / `photos.total` | PHOTOS & DAILY REPORTS panel |
| `reports.submitted` / `reports.missedDays` | same panel |

### Derived, not stored (`lib/siteModel.js`)

- **N/A items are excluded from both numerator and denominator.** Counting them as
  incomplete would permanently cap a site under 100%; counting them as complete
  would inflate it. So "12 of 14 documents" can legitimately read 100%.
- A milestone whose every item is N/A is **100%**, not 0% — vacuously complete.
- `UPLOADED %` is document completion across applicable items, which is why it
  differs from the photo percentage in the panel below it.

---

## Open questions to resolve when tables are chosen

1. **Is the Site Monitor read-only?** It is built read-only. The reference mockup
   let the user upload files and toggle N/A, persisting to `localStorage` — that
   silently diverges per viewer and is partitioned/blocked in a cross-origin
   iframe, so it was not carried over. If those toggles must be editable, they
   need a real write endpoint plus auth, not browser storage.
2. **Where does `notApplicable` come from?** It changes per site and per document.
   If it is a human judgement rather than derived data, it needs somewhere to be
   recorded.
3. **Does the Site Monitor need a site picker?** It currently renders one site.
   Drilling from a Route Monitor row into that site's monitor is the obvious link
   and is a small addition once the site key is known.
4. **Milestone count** is assumed to be 4 (`m1`–`m4`, four blocks). If it varies by
   route, the MILESTONES cell and the `m1..m4` columns should become a nested list.
5. **Photo/report expectations** (`photosTotal`, expected report days) — are these
   stored per site, or computed from a schedule? They are the denominators for
   every percentage on both pages.
