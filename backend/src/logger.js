const pino = require('pino');
const pkg = require('../package.json');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'password',
      'new_password',
      'current_password',
      'reset_token',
      'worker_token',
      'credential',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.worker_token',
      '*.reset_token',
    ],
    censor: '[Redacted]',
  },
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'plankton-backend',
    version: process.env.npm_package_version || pkg.version,
  },
});

function createChildLogger(bindings) {
  return logger.child(bindings);
}

module.exports = { logger, createChildLogger };