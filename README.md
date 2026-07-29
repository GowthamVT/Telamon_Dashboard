# Snowflake Analytics Dashboard

A custom (non-BI-tool) analytics dashboard that queries **live** data from Snowflake.
Node/Express API + React UI, built to run standalone now and be embedded via
`<iframe>` on an external site later.

```
├── backend/     Express API: pooled Snowflake access, caching, freshness sync
├── frontend/    React + Vite dashboard: charts, filters, drill-down/through
└── keys/        RSA key-pair for Snowflake auth (gitignored -- never committed)
```

---

## Current status

| Piece | State |
|---|---|
| Backend API, caching, sync, security headers | Done — 41 tests passing |
| React UI: filters, sorting, drill-down/up/through | Done — verified in headless Chrome |
| Snowflake key-pair auth | **Blocked: public key not yet registered** (one SQL statement, see below) |
| Live query against `ECSITE.ANALYTICS` | Pending the step above |
| Row-level security (RLS) | Deliberately deferred — see [Deferred: RLS](#deferred-row-level-security-rls) |

The connection path is fully built and confirmed working up to authentication:
Snowflake accepts the connection and rejects the JWT with `JWT token is invalid`,
which is exactly the expected response until the public key is registered. Account
resolution, networking, and key loading are all verified.

Because the live schema could not be read yet, the dashboard is **descriptor-driven**
rather than hardcoded to specific columns — see [How the data model works](#how-the-data-model-works).
Nothing needs to be rewritten once the key is live; you just run `npm run introspect`.

---

## Step 1 — Register the public key in Snowflake (you must do this)

A key pair has already been generated into `keys/` (gitignored). Run this in
Snowflake as a role that can `ALTER USER` — **`USERADMIN` or `ACCOUNTADMIN`;
`PUBLIC` cannot do it**:

```sql
ALTER USER GOWTHAM SET RSA_PUBLIC_KEY='MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmLjztmk5kaJ2JmRsWM5Wgc9Xsded8cI9ntie4wk95q6Qk7FATQjzIUTJZSMqLHyWX/E6BpGcNau5WFDm2qhrETnaZSAGpYit22LQMzqgboi4s6AniL/SldL7QYnAW9GTIez9iOpk+ueue5+uDzLlrlGIluEHpi7Yd1RkNgo5eesR38GmYFosVrygR+ryA2FrDW+FYtJ4nTnf3QdqNmnQTCjZWVaqpuyC02v4nX3DgsLVHm0f68C9toQU7R8LFAbFh//VkW8dR4K0TXsWRCfBwuMxEeFXbdJqHtlJiHmn6JxFqis6nBDhj/bOdFsaZG8/rgDccPp+JhYSeR7VOHVwXwIDAQAB';

-- Confirm it stored:
DESC USER GOWTHAM;
```

`RSA_PUBLIC_KEY_FP` should read `SHA256:WHheD74iiJs61aLD2oBV4ikcFIpJ5yLzdyut1qahR6k=`.

The same SQL is saved at `keys/register-public-key.sql` (gitignored). To generate a
fresh pair: `cd backend && npm run keygen -- --force` (then re-register the new key).

> Registration can take a few seconds to propagate.

---

## Step 2 — Run it locally

Prereqs: Node 20+ (built on v22).

```bash
# 1. Backend
cd backend
npm install
cp .env.example .env          # already contains your account/db/schema values
npm run verify                # proves auth + queries a real table
npm run introspect            # reads your schema -> dashboard.config.json
npm run dev                   # API on http://localhost:8080

# 2. Frontend (second terminal)
cd frontend
npm install
npm run dev                   # UI on http://localhost:5173
```

Open <http://localhost:5173>. The Vite dev server proxies `/api` to port 8080, so
local development has no CORS involved at all.

### No Snowflake access yet? Run the UI on synthetic data

```bash
cd backend && npm run dev:mock     # real API, synthetic data, no Snowflake
cd frontend && npm run dev
```

`dev:mock` runs the **real** Express app — every route, the cache, and the drill
logic are production code paths — with only the driver swapped for a seeded
generator. Useful for UI work and demos at zero warehouse cost. It refuses to
start with `NODE_ENV=production`.

### Useful commands

| Command | What it does |
|---|---|
| `npm run verify` (backend) | Authenticate, list visible objects, SELECT from one. Diagnoses failures. |
| `npm run introspect` (backend) | Regenerate `dashboard.config.json` from the live schema. `-- --object NAME` targets a specific table. |
| `npm test` (backend) | 41 tests: SQL generation, injection safety, routing, caching, drill sequence. |
| `npm run dev:mock` (backend) | API with synthetic data. |
| `npm run build` (frontend) | Production bundle into `frontend/dist`. |

---

## How the Snowflake connection is configured

**All credentials come from `backend/.env`, which is gitignored.** Nothing is
hardcoded; `backend/.env.example` documents every setting.

| Setting | Value |
|---|---|
| Account / User | `KOA17766` / `GOWTHAM` |
| Role / Warehouse | `PUBLIC` / `COMPUTE_WH` |
| Database / Schema | `ECSITE` / `ANALYTICS` |
| Auth | Key-pair JWT (`SNOWFLAKE_JWT`) — no password anywhere |

Nothing in this project creates or alters roles, schemas, or databases; it only
reads, using the existing `PUBLIC` role.

### Connection pooling

One process-wide pool via the official SDK's `createPool`, created lazily on first
query ([`backend/src/db/snowflake.js`](backend/src/db/snowflake.js)). Requests
borrow and return a connection — **never one connection per request**, since
Snowflake session setup costs hundreds of milliseconds and would dominate latency.

Each physical connection is primed once with `STATEMENT_TIMEOUT_IN_SECONDS`, so a
runaway query can't pin a pooled connection indefinitely. Pool size, timeouts, and
the statement cap are all env-tunable. The pool drains on `SIGINT`/`SIGTERM` so
sessions close cleanly.

---

## How the data model works

The API and UI are driven by a **descriptor** — `backend/dashboard.config.json`,
generated by `npm run introspect` from `INFORMATION_SCHEMA` — instead of hardcoded
column names. It declares which columns are measures, which are drillable
dimensions, and which is the time axis. `introspect` classifies columns by type and
probes cardinality (text columns with ≤1000 distinct values become dimensions).

This means one codebase works against whatever `ECSITE.ANALYTICS` actually holds,
and the file is hand-editable: reorder `drillPath` to match real business meaning,
relabel, drop noisy dimensions, or change aggregations. It is gitignored because it
is generated and environment-specific. Restart the API after editing.

### Why this is also the security boundary

Two invariants in [`queryBuilder.js`](backend/src/services/queryBuilder.js) make the
request surface injection-safe:

1. **Identifiers** (table/column names) only ever come from the descriptor. Requests
   reference descriptor *keys*, which are resolved to identifiers; an unknown key is
   rejected with a `400` listing what's allowed, and never reaches SQL.
2. **Values** (filters, date bounds, limits) are *always* bind parameters.

Tests assert this directly with malicious `dimension`, `grain`, and `sortDir`
payloads: a value like `West'; DROP TABLE X --` appears only in the bind array,
never in the SQL text.

---

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/meta` | Descriptor: measures, dimensions, drill path, time columns |
| `GET /api/summary` | KPI tile values |
| `GET /api/timeseries` | Trend, bucketed by `grain` (day…year) |
| `GET /api/breakdown?dimension=<key>` | Grouped aggregate — also the drill-down query |
| `GET /api/filter-options?dimension=<key>` | Distinct values for a dropdown |
| `GET /api/detail` | Drill-through: raw rows + total count |
| `GET /api/health` · `/api/health/snowflake` | Liveness (cheap) · real round trip |
| `GET /api/status` | Pool, cache, and sync telemetry |
| `POST /api/cache/invalidate` | Force a cache flush |
| `POST /api/sync/check` | Run one freshness check now |

Common query params: `measures=a,b` · `f.<dimension>=x,y` (filter; comma = `IN`) ·
`from`/`to` · `grain` · `sortBy`/`sortDir` · `limit`/`offset`.

```bash
curl "localhost:8080/api/breakdown?dimension=region&measures=amount&f.category=Toys,Games&sortBy=amount&sortDir=desc"
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
invalidates the cache when it changes:

- **Tables** → `INFORMATION_SCHEMA` metadata (`LAST_ALTERED`/`ROW_COUNT`/`BYTES`).
  Pure metadata, so polling does **not** spin up warehouse compute.
- **Views** → a `COUNT(*)` probe, because a view's `LAST_ALTERED` tracks its
  *definition*, not the underlying rows.

A failed check never kills the interval; the next tick retries. Moving to Snowflake
Streams later means replacing only `computeFingerprint()`.

---

## Frontend

- **Filters** in one row scoping everything below: dimension dropdowns (populated
  from live distinct values, each respecting the *other* active filters so choices
  stay coherent), date range, grain, and measure selection.
- **Sorting** is server-side, so clicking a header orders the whole result set in
  Snowflake — not just the visible page.
- **Drill-down / up / through** is one crumb stack that converts to ordinary API
  filters, so the server stays stateless and every level is just another cached
  query. Clicking a bar or row pushes a crumb; clicking any breadcrumb truncates the
  stack (jumping up several levels at once); "View detail rows" keeps the same
  filters and shows raw rows, so the detail count reconciles with the aggregate above it.
- **Charts** are faceted small multiples — one panel per measure, each with its own
  y-axis. Measures here differ by orders of magnitude (a count in the thousands
  beside a currency total in the hundreds of thousands); overlaid on a shared axis
  the smaller series flattens onto the baseline and reads as zero. A second y-axis
  is not used: aligning two scales is arbitrary and invents a correlation the data
  doesn't contain.
- **Accessibility**: series colors were validated for colorblind separation and
  contrast in both light and dark modes. Light-mode aqua falls below 3:1 against the
  surface, so the sortable table beside each chart is *required relief* — every
  charted value is also readable as text. Sortable headers are keyboard-operable
  with `aria-sort`.

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
[`buildWhere()` in `backend/src/services/queryBuilder.js`](backend/src/services/queryBuilder.js).
Every endpoint — summary, timeseries, breakdown, filter options, detail — builds its
`WHERE` clause through that function, so a predicate added there is inherited
everywhere automatically. Do *not* add tenant predicates per route; it is too easy to
miss one.

```js
if (principal) {
  clauses.push(`"TENANT_ID" = ?`);
  binds.push(principal.tenantId);
}
```

Two things must change with it:

1. **The cache key must include the principal's scope.** A cache key that ignores
   the security boundary would serve one tenant's cached rows to another — a data
   leak, not just a stale read. See the TODO in
   [`analyticsService.js`](backend/src/services/analyticsService.js).
2. **Auth must stay iframe-friendly.** Prefer a short-lived signed token passed to
   the frame (query param on the `iframe src`, or `postMessage`) and held in memory
   — not a third-party cookie, which browsers may drop. See the TODO in
   [`frontend/src/api/client.js`](frontend/src/api/client.js).

Other deferrals, all marked with `TODO` in code:

- `POST /api/cache/invalidate` and `/api/sync/check` mutate shared state and are
  unauthenticated — they need an admin credential before this is publicly exposed.
- Cache is in-process, so multiple instances each keep their own. Redis is the fix
  (the cache interface is already isolated for this).
- Currency formatting prefixes `$` rather than guessing a currency code from the
  data. Set it explicitly in `lib/format.js` if your data isn't USD.

---

## Security notes

- `.env`, `keys/`, `*.p8`, `*.pem` are gitignored; only the *generator script* is
  tracked, never key material.
- Helmet security headers, plus rate limiting (300 req/min default) that skips
  `/api/health` so probes don't consume a caller's budget.
- Client errors return `400` with the allowed values; server errors log the detail
  and return a generic message in production, since raw Snowflake errors can name
  internal objects.
- `/api/status` is asserted by test to expose no key material or password.
