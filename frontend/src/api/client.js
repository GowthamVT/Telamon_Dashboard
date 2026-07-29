/**
 * API client.
 *
 * Iframe-safety notes -- these are deliberate constraints, not oversights:
 *
 * 1. NO localStorage / sessionStorage anywhere in this app. In a cross-origin
 *    iframe, storage is partitioned or outright blocked (Safari ITP, Chrome
 *    third-party storage partitioning). Code that assumes it can persist state
 *    works standalone and then silently fails once embedded. All UI state lives
 *    in React memory for the lifetime of the frame.
 *
 * 2. NO cookie-based auth assumptions. `credentials` defaults to 'omit' so we
 *    never depend on a third-party cookie that browsers may drop. When auth is
 *    added, prefer a short-lived token handed to the frame (query param on the
 *    iframe src, or postMessage from the parent) and held in memory only --
 *    see the TODO at the bottom.
 *
 * 3. NO history/pushState writes. An iframe shares the top-level back/forward
 *    stack, so pushing entries per drill-down would hijack the parent page's
 *    back button. Drill state is in-memory instead.
 */

/**
 * Base URL for the API.
 *
 * Empty string (the default) means same-origin relative requests, which is what
 * the Vite dev proxy and a co-hosted production deploy both want. Set
 * VITE_API_BASE_URL when the API lives on a different origin than the frontend.
 */
const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, { status, details, code } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

/** Serialise a request object into the query string the backend expects. */
export function buildQuery({ measures, dimension, timeColumn, grain, filters, from, to, sortBy, sortDir, limit, offset } = {}) {
  const params = new URLSearchParams();

  if (measures?.length) params.set('measures', measures.join(','));
  if (dimension) params.set('dimension', dimension);
  if (timeColumn) params.set('timeColumn', timeColumn);
  if (grain) params.set('grain', grain);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (sortBy) params.set('sortBy', sortBy);
  if (sortDir) params.set('sortDir', sortDir);
  if (limit != null) params.set('limit', String(limit));
  if (offset != null) params.set('offset', String(offset));

  // Filters use the f.<dimension>= convention; multi-values are comma joined.
  for (const [key, value] of Object.entries(filters || {})) {
    const values = (Array.isArray(value) ? value : [value]).filter(
      (v) => v !== undefined && v !== null && v !== ''
    );
    if (values.length > 0) params.set(`f.${key}`, values.join(','));
  }

  return params.toString();
}

async function request(path, { signal } = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // See note 2 above: never rely on third-party cookies.
      credentials: 'omit',
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(
      `Cannot reach the API${BASE_URL ? ` at ${BASE_URL}` : ''}. Is the backend running?`,
      { code: 'network' }
    );
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON response (proxy error page, etc.)
  }

  if (!response.ok) {
    throw new ApiError(body?.message || `Request failed with ${response.status}`, {
      status: response.status,
      details: body?.details,
      code: body?.error,
    });
  }

  return {
    data: body,
    // Surfaced so the UI can show whether a number came from cache.
    cacheHit: response.headers.get('X-Cache') === 'HIT',
  };
}

const get = (path, params, opts) => {
  const qs = params ? buildQuery(params) : '';
  return request(`/api${path}${qs ? `?${qs}` : ''}`, opts);
};

export const api = {
  meta: (opts) => get('/meta', null, opts),
  status: (opts) => get('/status', null, opts),
  summary: (params, opts) => get('/summary', params, opts),
  timeseries: (params, opts) => get('/timeseries', params, opts),
  breakdown: (params, opts) => get('/breakdown', params, opts),
  filterOptions: (params, opts) => get('/filter-options', params, opts),
  detail: (params, opts) => get('/detail', params, opts),
};

/**
 * TODO(auth, iframe): when this dashboard is embedded on the external site and
 * needs per-user scoping, the parent page should mint a short-lived signed token
 * server-side and pass it to the frame, e.g.
 *
 *     <iframe src="https://dash.example.com/?token=eyJ..."></iframe>
 *
 * Read it once from location.search into a module-level variable, strip it from
 * the visible URL, and send it as `Authorization: Bearer <token>` here. Keep it
 * in memory only -- do NOT put it in localStorage (note 1). The backend then
 * derives the RLS predicate from the token; see buildWhere() in
 * backend/src/services/queryBuilder.js.
 */
