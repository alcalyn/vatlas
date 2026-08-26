import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import pretty from 'pino-pretty';
import { config } from '../config.js';

/** Width of the padded level label, so columns line up. */
const LEVEL_WIDTH = 5;

/**
 * Child logger bindings (`{ component: 'auth' }`, `{ source }`, `{ country }`), printed as a `[...]`
 * prefix rather than among the parameters.
 */
const CONTEXT_KEYS = ['component', 'source', 'country'] as const;

/**
 * Human readable, one line per entry: `2026-09-07 12:03:01.123 INFO  [auth] message {"key":1}`.
 * Colors only on a terminal.
 *
 * A plain destination stream rather than a pino transport: transports run in a worker thread and
 * lose the last lines when a short CLI exits.
 */
function prettyStream() {
  return pretty({
    colorize: process.stdout.isTTY === true,
    translateTime: 'UTC:yyyy-mm-dd HH:MM:ss.l',
    // pino-http's message already has method, URL and status.
    ignore: `pid,hostname,req,res,${CONTEXT_KEYS.join(',')}`,
    singleLine: true,
    customPrettifiers: {
      // Pad the plain label: escape codes would count towards the width.
      level: (_value, _key, _log, { label, labelColorized }) =>
        labelColorized + ' '.repeat(Math.max(0, LEVEL_WIDTH - label.length)),
    },
    messageFormat: (log, messageKey) => {
      const message = String(log[messageKey] ?? '');
      const context = CONTEXT_KEYS.map((key) => log[key]).filter((value) => value !== undefined);
      return context.length > 0 ? `[${context.join(' ')}] ${message}` : message;
    },
  });
}

export const logger =
  config.logFormat === 'pretty' ? pino({ level: config.logLevel }, prettyStream()) : pino({ level: config.logLevel });

export type AppLogger = typeof logger;

/**
 * The request logger of both servers. pino-http's default serializers log headers, including
 * `authorization` and `cookie`. These keep method, URL, status and response time.
 */
export function httpLogger() {
  return pinoHttp({
    logger: logger.child({ component: 'http' }),
    serializers: {
      req: (req) => ({ method: req.method, url: redactUrl(req.url) }),
      res: (res) => ({ status: res.statusCode }),
    },
    customSuccessMessage: (req, res) => `${req.method} ${redactUrl(req.url)} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${redactUrl(req.url)} ${res.statusCode}`,
  });
}

/**
 * The URL with `token=` values masked: verification and reset links carry their secret in the
 * query string.
 */
export function redactUrl(url: string | undefined): string | undefined {
  return url?.replace(/([?&]token=)[^&#]*/gi, '$1[redacted]');
}
