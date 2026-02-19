'use strict';

const { createLogger, format, transports } = require('winston');
const { config } = require('./config');

const logger = createLogger({
  level: config.log.level,
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  defaultMeta: { service: 'unified-landlord-center' },
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, service, ...meta }) => {
          const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `[${timestamp}] ${level} (${service}): ${message}${extra}`;
        })
      ),
    }),
  ],
});

module.exports = logger;
