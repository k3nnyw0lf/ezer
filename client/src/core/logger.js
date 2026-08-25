'use strict';

const { redact, redactUrl } = require('./redact');

/**
 * Structured logger that redacts on the way out.
 *
 * Everything printed passes through redact() - there is deliberately no "raw" escape hatch,
 * because the one time someone uses it is the time a secret ends up in a transcript.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function createLogger({ level = process.env.WOLF_LOG_LEVEL || 'info', sink = console, name = 'wolf-quote' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(lvl, msg, fields) {
    if (LEVELS[lvl] < threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      logger: name,
      msg: typeof msg === 'string' ? msg : '(non-string message)',
      ...(fields ? redact(fields) : {}),
    };
    const out = lvl === 'error' || lvl === 'warn' ? 'error' : 'log';
    sink[out](JSON.stringify(line));
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => {
      const base = createLogger({ level, sink, name });
      return {
        debug: (m, f) => base.debug(m, { ...extra, ...f }),
        info: (m, f) => base.info(m, { ...extra, ...f }),
        warn: (m, f) => base.warn(m, { ...extra, ...f }),
        error: (m, f) => base.error(m, { ...extra, ...f }),
        child: (more) => createLogger({ level, sink, name }).child({ ...extra, ...more }),
      };
    },
    redactUrl,
  };
}

module.exports = { createLogger, LEVELS };
