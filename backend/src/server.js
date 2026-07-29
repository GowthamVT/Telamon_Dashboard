/**
 * Process entry point: start HTTP, start the freshness watcher, and shut both
 * down cleanly so pooled Snowflake sessions are released.
 */
const { createApp } = require('./app');
const config = require('./config/env');
const logger = require('./util/logger');
const sf = require('./db/snowflake');
const dashboard = require('./config/dashboard');
const freshness = require('./sync/freshnessWatcher');

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(`API listening on http://localhost:${config.port} (${config.env})`);
  logger.info(
    `Snowflake target: ${config.snowflake.account} ${config.snowflake.database}.${config.snowflake.schema} as ${config.snowflake.role}`
  );

  if (!dashboard.isConfigured()) {
    logger.warn(
      'No dashboard.config.json yet -- data endpoints will return 503. ' +
        'Run `npm run introspect` once Snowflake auth works.'
    );
  }

  freshness.start();
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received -- shutting down`);

  freshness.stop();
  server.close(async () => {
    await sf.close();
    logger.info('Shutdown complete');
    process.exit(0);
  });

  // Don't hang forever on a stuck connection.
  setTimeout(() => {
    logger.warn('Forcing exit after 10s shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason && reason.message ? reason.message : reason}`);
});
