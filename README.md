# Completion Monitor Dashboard

A custom (non-BI-tool) dashboard over **live** ECSite data: Route Completion
Monitor and Site Completion Monitor. Node/Express API + React UI, built to run
standalone now and be embedded via `<iframe>` on an external site later.

**Data source: MongoDB Atlas (the ECSite production cluster), read-only.**
It previously read a Snowflake warehouse; that path has been removed — see
[History: the Snowflake migration](#history-the-snowflake-migration).

```
├── backend/     Express API: pooled MongoDB access, caching, freshness sync
└── frontend/    React + Vite: Route Monitor and Site Monitor
```

---

## Current status

| Piece | State |
|---|---|
| Backend API, caching, freshness, security headers | Done — 26 tests passing |
| Route Monitor + Site Monitor on live data | Done |
| MongoDB as the only source | Done |
| Row-level security (RLS) | Deliberately deferred — see [Deferred: RLS](#deferred-row-level-security-rls) |

**Known gaps, all data-side rather than code-side:**

| Gap | Why |
|---|---|
| Milestones show `--` on 139 of 202 nodes | No milestone field exists in MongoDB. `config/milestones.js` maps the LUMEN ILA stage names; other templates (`0MH PHOTOS`, `C01.04/05` WBS codes, in-building floors) need a mapping only the client can supply |
| M1 CD Drawings never measurable | Document-based, and only 5 documents have ever been uploaded across all of Telamon |
| `TELAMON-ILA-TRACKER` unused | Configured on 63 nodes, 0 submissions. Only the sandbox has data (251 entries) |
| Item-level N/A is inferred | From wording like "if applicable". The per-**field** N/A behind photo coverage is real (`ProgressStats.n_a`) |
| Public holidays count as missed report days | No holiday calendar in the source |

---

## Run it locally

Two terminals.

```bash
# 1. Backend
cd backend
cp .env.example .env         # then fill in MONGO_URI and MONGO_DATABASE
npm install
npm run verify               # connectivity, collections, indexes
npm run dev                  # http://localhost:8080

# 2. Frontend (second terminal)
cd frontend
npm install
npm run dev                  # http://localhost:5173
```

Vite proxies `/api` to port 8080, so no extra configuration is needed.

`MONGO_URI` and `MONGO_DATABASE` are **required** — the API refuses to boot
without them rather than starting and serving an empty dashboard.

### Which source is serving?

```bash
curl http://localhost:8080/api/health        # {"source":"mongodb", ...}
curl http://localhost:8080/api/health/mongo  # real round trip
curl http://localhost:8080/api/status        # pool, cache, freshness
```

### Useful commands

| Command | What it does |
|---|---|
| `npm run verify` (backend) | Connect, check the 9 required collections and the `nodeIdList` indexes |
| `npm test` (backend) | 26 tests: routing, scope/RLS plumbing, caching, read-only guard |
| `npm run build` (frontend) | Production bundle into `frontend/dist` |

---

## How the MongoDB connection is configured

**All credentials come from `backend/.env`, which is gitignored.** Nothing is
hardcoded; `backend/.env.example` documents every setting.

| Setting | Value |
|---|---|
| Cluster | MongoDB Atlas, ECSite production |
| Database | `ecsite` |
| Auth | Username/password in `MONGO_URI`, user holds role **`read` only** |
| Read preference | `secondaryPreferred` |

`readPreference=secondaryPreferred` is the setting that matters most: this is the
same cluster the field portal runs on, so dashboard scans belong on a replica and
never on the primary that crews depend on while uploading photos. `db/mongo.js`
warns at startup if the URI omits it.

### Reads only, enforced twice

1. The Atlas user holds role `read`, so the **server** refuses a write.
2. [`db/mongoReadOnly.js`](backend/src/db/mongoReadOnly.js) validates every
   pipeline first, so a mistake fails loudly in our code with an actionable
   message instead of arriving as a permissions error.

The guard is a **whitelist** of read-only stages, not a blacklist of writers: a
blacklist silently permits whatever it has not heard of. It recurses into
`$lookup`, `$unionWith` and `$facet`, because a `$merge` nested in a sub-pipeline
would slip past a top-level check.

Nothing in this project creates, alters or deletes anything — including indexes.

### The eight collections

| Collection | Supplies |
|---|---|
| `SmallCellNode` | nodes: name, code, status, start date, ids |
| `Site` | route names (join on `siteIdList`, **not** `siteId`, which holds the code) |
| `Company` | company names |
| `FormGroup` | the per-node checklist (`list[]`) |
| `FormBuilderQuestions` | form definitions; `list[].element = 'Photo' / 'File_Upload'` |
| `FormBuilderAnswers` | submission counts (daily reports) |
| `FieldMedia` | uploaded photos, `approvalStatus` |
| `ProgressStats` | per-field completion and the `n_a` flag |

### Connection pooling

One process-wide `MongoClient`, created lazily on first use
([`backend/src/db/mongo.js`](backend/src/db/mongo.js)). The driver maintains its
own internal pool, so a client per request would mean a TLS handshake per request.
Every aggregation carries `maxTimeMS` so a runaway pipeline cannot pin a
connection. The client closes on `SIGINT`/`SIGTERM`.

### Traps worth knowing

- `_id` is an `ObjectId`; the scalar id **fields** (`nodeId`, `siteId`,
  `companyId`) are strings. Joining one to the other silently returns nothing.
- Filter `SmallCellNode` on the `*List` fields — those are indexed, the scalar
  equivalents are not.
- Use `createdAt` (a real `Date`), not `createdDate` (mixed `double`/`long`/null).
- Node names are **not** unique: two nodes are called "Wadley", two "Basile", two
  "South Bay". Always resolve by `nodeId`.

---

## How the data model works

Every query starts from one flat node row. Node, site and company live in three
collections with different shapes, so
[`nodesInScope()`](backend/src/services/monitorService.js) joins them once and the
rest builds on that:

```
SmallCellNode.companyId  ->  Company.companyIdList  ->  companyName
SmallCellNode.siteId     ->  Site.siteIdList        ->  siteName   (the "route")
SmallCellNode.nodeName                                            (the "site")
SmallCellNode.nodeStatus.status                                   (the KPI status)
```

**Naming inversion, carried over from the source:** the database's *site* is what
the dashboards call the **route**, and its *node* is what they call the **site**.
One site contains many nodes. Every query is explicit about which is which.

Three things are business rules in config, not data:

| Rule | Where | Why it is not data |
|---|---|---|
| Stage → milestone (M1–M4) | [`config/milestones.js`](backend/src/config/milestones.js) | No milestone field exists in any of the 122 collections |
| Status vocabulary + item Complete/Missing/N/A | [`config/statusVocabulary.js`](backend/src/config/statusVocabulary.js) | The source has six status strings; the dashboard reports three words |
| Weekday calendar for missed report days | `workingDaysBetween()` | No calendar collection; no holiday list anywhere |

### Why this is also the security boundary

`buildMatch()` in [`monitorService.js`](backend/src/services/monitorService.js) is
the **single chokepoint** every query filters through, so a per-user predicate added
there is inherited by all of them. Two invariants keep the request surface safe:

1. **Collection names** are module constants, never request input.
2. **Scope values** (`companyId`, `siteId`, `nodeId`) are used only as equality
   matches on indexed array fields — never interpolated into a `$where`, and never
   used to build a regex from raw input.

An unresolvable company pattern matches **nothing** rather than everything
(`{ $in: ['__no_company_matched__'] }`), so a failed lookup cannot silently widen
scope to every tenant. There is a test for exactly that.

---

## API

The frontend calls `/api/monitor/*` only.

| Endpoint | Purpose |
|---|---|
| `GET /api/monitor/hierarchy` | Company › Site › Node tree for the scope picker |
| `GET /api/monitor/routes` | Routes in scope, with node counts |
| `GET /api/monitor/nodes` | Nodes in scope (the flat row) |
| `GET /api/monitor/status-counts` | KPI card: Complete / In Progress / Yet to Start |
| `GET /api/monitor/route` | Route Monitor payload: header + KPI + rows with metrics |
| `GET /api/monitor/site` | Site Monitor payload: header, metrics, stages, checklist |
| `GET /api/monitor/node-metrics` | Photos, fields, daily reports, missed days, milestones |
| `GET /api/monitor/node-stages` | Per-stage photo detail |
| `GET /api/monitor/node-checklist` | The node's checklist items |
| `GET /api/health` · `/api/health/mongo` | Liveness (cheap, no query) · real round trip |
| `GET /api/status` | Pool, cache, and freshness telemetry |
| `POST /api/cache/invalidate` | Force a cache flush |
| `POST /api/sync/check` | Run one freshness check now |

Scope params, all optional and all flowing through `buildMatch()`:
`companyId` · `siteId` · `nodeId` · `company` (name pattern, testing only).
Omitting them falls back to the Telamon scope.

```bash
curl "localhost:8080/api/monitor/site?nodeId=692f6fc9ffda99c8f8423306"
```

Responses carry `X-Cache: HIT|MISS`.

### Caching

In-memory TTL + LRU ([`queryCache.js`](backend/src/cache/queryCache.js)), keyed by a
hash of the full logical request (property-order independent, so param order can't
cause a miss). Default TTL 300s, 500 entries.

Invalidation is **generation-based**: bumping a counter logically expires everything
at once in O(1), rather than walking and deleting keys. Stale entries are dropped
lazily on access or by LRU pressure.

Callers only use `get`/`set`/`wrap`/`invalidateAll`, so swapping in Redis later means
reimplementing that interface and nothing else.

### Freshness sync

[`freshnessWatcher.js`](backend/src/sync/freshnessWatcher.js) polls every
`SYNC_POLL_SECONDS` (default 60) for a cheap fingerprint of the source and
invalidates the cache when it changes.

The fingerprint is `estimatedDocumentCount()` across the five collections the
monitors read. That reads collection metadata rather than scanning, so it stays
cheap against multi-million-document collections and adds no meaningful load to
the production cluster.

**Known limit:** counts detect inserts and deletes, not in-place updates. A photo
whose `approvalStatus` flips to `Approved` changes no count, so that is picked up
when the cache entry expires. `CACHE_TTL_SECONDS` (300) is therefore the real
staleness bound; the watcher shortens it for the common case of new photos and new
reports.

A failed check never kills the interval; the next tick retries. Change streams
would replace `computeMongoFingerprint()`.

---

## Frontend

Two tabs, both reading `/api/monitor/*`.

**Route Completion Monitor** — one row per node across a route: photo coverage,
daily reports, missed days, milestone blocks, overall, status. Header and KPI are
company-scoped by design, so drilling into one route does not shrink the KPI.

**Site Completion Monitor** — one node at a time: status KPI, milestone progress,
photos & daily reports, and the checklist table.

Presentation rules applied throughout, each for a reason:

- **Unmeasurable is `--`, never 0%.** M1 has no source, so 0% would read as "no
  progress" when the truth is "no source". Unmeasurable bars use a grey track so
  they cannot be mistaken for a red zero.
- **Percentages are pooled, not averaged.** The hero figure is stages-done over
  stages-total; averaging four milestone percentages would weight M4's 2 stages the
  same as M2's 7.
- **Coverage numerator is fields covered, not photo count.** 686 photos across 166
  fields is 80% coverage, not 413%.
- **A card never contradicts the table beneath it.** The stat cards count the same
  filtered rows the table renders.
- **Aggregate scope never names one row.** With no node picked the header reads
  "ALL SITES" and `detailName` says which node the cards describe — the API sends
  `name: null` so no code path can claim otherwise.
- **Colour is never the only signal.** Every status ships an icon and a word.

The table lists only items mapped to M1–M4. A node on a non-ILA template
therefore shows an empty table, with a message saying why rather than blaming the
reader's filters.

**No `localStorage`, no cookies, no `history.pushState`** — all three are
partitioned or blocked in a cross-origin iframe.

---

## Embedding in an `<iframe>` later

Cross-origin embedding has three gates that must all agree, or the dashboard
silently renders blank. All three are handled:

1. **CORS** — set `CORS_ALLOWED_ORIGINS` to the parent page's exact origin. Empty
   reflects any origin (dev only) and is *refused* in production so a
   misconfigured deploy can't go wide open.
2. **`frame-ancestors`** — set `FRAME_ANCESTORS` to the embedding origin. Helmet's
   `frameguard` is deliberately **disabled**, because `X-Frame-Options` has no
   allowlist syntax and its `DENY` default would block embedding regardless of CSP.
   Verified by test: the CSP carries `frame-ancestors` and no `X-Frame-Options` is sent.
3. **Storage/cookies** — the frontend uses **no `localStorage`, no cookie
   dependence, and no `history.pushState`**. Storage is partitioned or blocked in
   third-party contexts, and an iframe shares the top-level history stack, so
   per-drill history entries would hijack the parent page's back button. All UI
   state lives in memory. See the notes in
   [`frontend/src/api/client.js`](frontend/src/api/client.js).

```bash
# backend/.env
CORS_ALLOWED_ORIGINS=https://parent-site.example
FRAME_ANCESTORS=https://parent-site.example
```

Then build the frontend (`npm run build`), serve `frontend/dist`, and embed:

```html
<iframe src="https://dash.example.com/" width="100%" height="900" style="border:0"></iframe>
```

---

## Deferred: row-level security (RLS)

**Every user currently sees the same data.** There is no authentication, and no
per-user filtering. This was in scope to defer.

When you add it, there is **one place** to do it:
[`buildMatch()` in `backend/src/services/monitorService.js`](backend/src/services/monitorService.js).
Every query — hierarchy, routes, nodes, status counts, metrics, stages, checklist —
filters through that function, so a predicate added there is inherited everywhere
automatically. Do *not* add tenant predicates per route; it is too easy to miss one.

```js
async function buildMatch({ companyPattern, companyId, siteId, nodeId, principal } = {}) {
  const match = {};
  if (principal) {
    // Derive scope from the authenticated user, and ignore anything the request
    // asked for that the principal is not entitled to.
    match.companyIdList = { $in: principal.companyIds };
  } else if (companyId) {
    match.companyIdList = companyId;
  }
  // ...
}
```

Two things to change at the same time:

1. **Remove the `companyPattern` fallback.** Today it defaults to `%Telamon%` — an
   explicit single-tenant scope rather than "no filter", so the unrestricted case
   never becomes the default by accident. Once auth exists, a missing principal must
   **fail closed** rather than fall back to a pattern.
2. **`companyScopeOf()` widens scope** — it drops `siteId`/`nodeId` so the KPI card
   stays company-level while the page drills. It must never be applied to a per-user
   predicate; `companyId` is preserved there precisely because it is the tenant
   boundary.

Also note the cache key: `queryCache` keys on the logical request. Once a principal
affects results, the principal must be part of that key or one tenant could be
served another's cached rows.

---

## Security notes

- `.env`, `keys/`, `*.p8`, `*.pem` are gitignored; only the *generator script* is
  tracked, never key material.
- Helmet security headers, plus rate limiting (300 req/min default) that skips
  `/api/health` so probes don't consume a caller's budget.
- Client errors return `400` with the allowed values; server errors log the detail
  and return a generic message in production, since raw driver errors can name
  internal objects.
- `/api/status` is asserted by test to expose no key material or password.

---

## History: the Snowflake migration

The dashboard originally read `ECSITE.ANALYTICS` in Snowflake. It now reads the
MongoDB source directly, and the Snowflake path has been deleted.

**Why:** the warehouse trails the source by ~10 minutes, and more importantly its
`CLOUD_FORMGOUP_SS` "current" SCD2 row was **eight months stale** — 14 checklist
items where MongoDB had 20, including one that had since been deleted.

**How it was verified:** both adapters ran side by side behind a flag, and a
harness compared them field by field at the same instant across all 202 nodes.
The final run was **153 checks, 0 unexpected differences**; every remaining
divergence was traced to a specific stale row, with MongoDB the correct side.

**Bugs the comparison exposed in the Snowflake implementation, since fixed:**

| Bug | Effect |
|---|---|
| `CALENDAR."Day of Week"` is 0-indexed, not 1-indexed | `NOT IN (1,7)` excluded **Mondays** and counted every weekend as a working day. Missed days were overstated by ~30% (Wadley 21 instead of 14) |
| `getNodeMetrics` filtered item-level `isDeleted` but not the document's | Deleted checklists still produced milestone bars on 2 nodes |

**Two things MongoDB has that the warehouse never exposed:**

- `ProgressStats.n_a` — the per-field N/A flag. Photo coverage had been reported
  as approximate with N/A "not excluded" because no such flag could be found in
  Snowflake; it exists here.
- `ProgressStats.status` — per-field completion, the same flag the portal reads,
  which made coverage exact instead of an approximation from `DISTINCT
  FieldMedia.questionId`.

The repository folder is still named `snowflake-analytics-dashboard` for path
stability; nothing inside depends on Snowflake.
