/**
 * Live monitor data from the API.
 *
 * Scope params (companyId / siteId / nodeId) map straight onto the backend's
 * buildScope() -- the single place per-user RLS will be enforced. Passing none
 * falls back to the Telamon company scope.
 *
 * No credentials are sent: a cross-origin iframe cannot rely on third-party
 * cookies, so auth will arrive as a bearer token instead.
 */
const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

async function get(path, params = {}, signal) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}${qs ? `?${qs}` : ''}`, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Cannot reach the API. Is the backend running on port 8080?');
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }

  if (!response.ok) {
    throw new Error(body?.message || `Request failed with ${response.status}`);
  }
  return body;
}

export const monitorApi = {
  hierarchy: (scope, signal) => get('/api/monitor/hierarchy', scope, signal),
  routes: (scope, signal) => get('/api/monitor/routes', scope, signal),
  nodes: (scope, signal) => get('/api/monitor/nodes', scope, signal),
  statusCounts: (scope, signal) => get('/api/monitor/status-counts', scope, signal),
  route: (scope, signal) => get('/api/monitor/route', scope, signal),
  site: (scope, signal) => get('/api/monitor/site', scope, signal),
};
