/**
 * Central error handling.
 *
 * Client mistakes (unknown measure, bad sort key) return 400 with the allowed
 * values so the caller can self-correct. Everything else returns a generic 500;
 * raw driver errors can name internal collections, so they are logged but not
 * echoed to the client in production.
 */
const logger = require('../util/logger');
const config = require('../config/env');

function notFound(req, res) {
  res.status(404).json({
    error: 'not_found',
    message: `No route for ${req.method} ${req.originalUrl}`,
  });
}

// eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  if (status < 500) {
    logger.warn(`${req.method} ${req.originalUrl} -> ${status}: ${err.message}`);
    return res.status(status).json({
      error: err.name === 'RequestError' ? 'bad_request' : 'client_error',
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  logger.error(`${req.method} ${req.originalUrl} -> 500: ${err.message}`);
  if (err.stack) logger.debug(err.stack);

  const isConfigProblem =
    /not configured yet|dashboard\.config\.json|private key not found|Missing required environment/i.test(
      err.message
    );

  res.status(isConfigProblem ? 503 : 500).json({
    error: isConfigProblem ? 'not_configured' : 'internal_error',
    message: isConfigProblem
      ? err.message
      : 'The request could not be completed. Check the server logs.',
    ...(config.isProduction ? {} : { detail: err.message }),
  });
}

module.exports = { notFound, errorHandler };
