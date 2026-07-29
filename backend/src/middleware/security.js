/**
 * CORS + security headers, tuned for being called from an embedded <iframe>.
 *
 * Cross-origin iframe embedding has three separate gates, and all of them must
 * agree or the dashboard silently renders blank:
 *
 *   1. CORS       -- lets the iframe's JS call this API from another origin.
 *   2. frame-ancestors (CSP) -- lets the parent page frame our content. This
 *      REPLACES X-Frame-Options, which helmet sets to DENY by default and which
 *      has no allowlist syntax. We disable it deliberately.
 *   3. Cookie attributes -- any future auth cookie needs SameSite=None; Secure
 *      to survive a third-party iframe. See the note at the bottom.
 */
const cors = require('cors');
const helmet = require('helmet');
const config = require('../config/env');
const logger = require('../util/logger');

function buildCors() {
  const allowed = config.http.corsAllowedOrigins;

  // No allowlist configured: reflect the caller's origin. Convenient in dev,
  // and refused in production so a misconfigured deploy cannot go wide open.
  if (allowed.length === 0) {
    if (config.isProduction) {
      throw new Error(
        'CORS_ALLOWED_ORIGINS must be set in production. ' +
          'List the exact origin(s) of the page that will embed this dashboard.'
      );
    }
    logger.warn('CORS_ALLOWED_ORIGINS is empty -- reflecting all origins (development only)');
    return cors({ origin: true, credentials: true, maxAge: 600 });
  }

  const wildcard = allowed.includes('*');
  if (wildcard && config.isProduction) {
    throw new Error('CORS_ALLOWED_ORIGINS=* is not permitted in production.');
  }

  return cors({
    origin(origin, callback) {
      // Same-origin/server-to-server requests send no Origin header; allow them.
      if (!origin) return callback(null, true);
      if (wildcard || allowed.includes(origin)) return callback(null, true);
      // Reject by not setting CORS headers rather than throwing a 500.
      logger.warn(`CORS: blocked origin ${origin}`);
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['X-Cache', 'X-Cache-Generation'],
    maxAge: 600,
  });
}

function buildHelmet() {
  const ancestors = ["'self'", ...config.http.frameAncestors];

  return helmet({
    // The API serves JSON, so a restrictive default-src is fine. frame-ancestors
    // is the directive that actually governs who may embed us.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ancestors,
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    // Must be off: X-Frame-Options cannot express an allowlist, and its DENY
    // default would block iframe embedding regardless of the CSP above.
    frameguard: false,
    // Would otherwise send Cross-Origin-Resource-Policy: same-origin and break
    // cross-origin reads from the embedding page.
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
    // Send the origin (not the full path) on cross-origin requests.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.isProduction,
  });
}

/**
 * TODO(RLS / auth): when authentication is added, remember that a cross-origin
 * iframe is a third-party context. Cookie-based sessions therefore need
 *     Set-Cookie: <name>=<value>; SameSite=None; Secure; HttpOnly
 * and the parent page must be served over HTTPS. Browsers with third-party
 * cookie blocking will still drop them, so prefer a short-lived signed token
 * passed to the iframe URL (or via postMessage) and held in memory -- see the
 * matching note in frontend/src/api/client.js.
 */
function apply(app) {
  app.use(buildHelmet());
  app.use(buildCors());
  // Behind a reverse proxy/CDN, trust X-Forwarded-* so rate limiting and
  // protocol detection see the real client.
  app.set('trust proxy', 1);
}

module.exports = { apply, buildCors, buildHelmet };
