/**
 * Express app assembly. Kept separate from server.js so tests can import the
 * app without binding a port.
 */
const express = require('express');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const config = require('./config/env');
const security = require('./middleware/security');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const analyticsRoutes = require('./routes/analytics');
const systemRoutes = require('./routes/system');
const monitorRoutes = require('./routes/monitors');

function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Security headers + CORS must run before any route.
  security.apply(app);

  app.use(compression());
  app.use(express.json({ limit: '256kb' }));
  if (config.logLevel !== 'silent') app.use(morgan(config.logLevel));

  app.use(
    rateLimit({
      windowMs: config.http.rateLimitWindowMs,
      max: config.http.rateLimitMaxRequests,
      standardHeaders: true,
      legacyHeaders: false,
      // Health checks shouldn't consume a caller's budget.
      skip: (req) => req.path === '/api/health',
      message: { error: 'rate_limited', message: 'Too many requests -- slow down.' },
    })
  );

  app.use('/api', systemRoutes);
  app.use('/api', monitorRoutes);
  app.use('/api', analyticsRoutes);

  app.get('/', (req, res) => {
    res.json({
      name: 'snowflake-analytics-dashboard API',
      endpoints: [
        'GET  /api/health',
        'GET  /api/health/snowflake',
        'GET  /api/status',
        'GET  /api/meta',
        'GET  /api/summary',
        'GET  /api/timeseries',
        'GET  /api/breakdown?dimension=<key>',
        'GET  /api/filter-options?dimension=<key>',
        'GET  /api/detail',
        'POST /api/cache/invalidate',
        'POST /api/sync/check',
      ],
    });
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
