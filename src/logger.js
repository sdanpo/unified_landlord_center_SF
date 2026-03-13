'use strict';

const path = require('path');
const fs = require('fs');
const { createLogger, format, transports } = require('winston');
const { config } = require('./config');

// Ensure the logs directory exists next to the project root
const logsDir = path.resolve(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// ─── Shared formats ───────────────────────────────────────────────────────────

const baseFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  format.errors({ stack: true }),
  format.splat()
);

// Human-readable console output
const consoleFormat = format.combine(
  baseFormat,
  format.colorize(),
  format.printf(({ timestamp, level, message, service, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? `\n  ${JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')}` : '';
    const stackStr = stack ? `\n${stack}` : '';
    return `[${timestamp}] ${level} (${service}): ${message}${metaStr}${stackStr}`;
  })
);

// Structured JSON for file transports (machine-parseable, grep-friendly)
const fileFormat = format.combine(baseFormat, format.json());

// ─── Logger instance ──────────────────────────────────────────────────────────

const logger = createLogger({
  level: config.log.level,
  defaultMeta: { service: 'unified-landlord-center' },
  transports: [
    // Console: colourised, human-readable
    new transports.Console({ format: consoleFormat }),

    // File: every log level (debug and above)
    new transports.File({
      filename: path.join(logsDir, 'app.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10 MB per file
      maxFiles: 7,               // keep ~7 days of rotated files
      tailable: true,
    }),

    // File: errors only – quick to scan after an incident
    new transports.File({
      filename: path.join(logsDir, 'errors.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 14,
      tailable: true,
    }),
  ],
});

logger.info('Logger initialised', {
  level: config.log.level,
  logDir: logsDir,
  appLog: path.join(logsDir, 'app.log'),
  errorLog: path.join(logsDir, 'errors.log'),
});

module.exports = logger;
