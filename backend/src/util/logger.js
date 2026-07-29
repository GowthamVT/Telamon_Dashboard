/**
 * Minimal leveled logger. Deliberately dependency-free -- swap for pino/winston
 * if structured log shipping is ever needed.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configured = (process.env.APP_LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[configured] ?? LEVELS.info;

function emit(level, stream, args) {
  if (LEVELS[level] > threshold) return;
  const stamp = new Date().toISOString();
  stream(`[${stamp}] ${level.toUpperCase()}`, ...args);
}

module.exports = {
  error: (...args) => emit('error', console.error, args),
  warn: (...args) => emit('warn', console.warn, args),
  info: (...args) => emit('info', console.log, args),
  debug: (...args) => emit('debug', console.log, args),
};
