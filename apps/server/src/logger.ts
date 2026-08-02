import { pino, type Logger as PinoLogger } from 'pino';
import { config, env } from './config.js';

/**
 * Structured logging is not optional at this scale: with dozens of projects the
 * only way to answer "why did channel X miss its 09:00 slot" is to filter by
 * project_id / post_id / job_id. Every worker binds those fields via `child()`.
 */

const baseOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'token',
      'botToken',
      'apiKey',
      'secret',
      '*.token',
      '*.botToken',
      '*.apiKey',
      '*.secret',
      'req.headers.cookie',
      'req.headers.authorization',
    ],
    censor: '[redacted]',
  },
};

/**
 * `pino-pretty` is a devDependency and is absent from the runtime image. A
 * container started with NODE_ENV=development must still boot, so fall back to
 * plain JSON rather than crashing on a missing transport.
 */
function createLogger(): PinoLogger {
  if (config.isProduction) return pino(baseOptions);
  try {
    return pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    });
  } catch {
    return pino(baseOptions);
  }
}

export const logger = createLogger();

export type Logger = PinoLogger;
