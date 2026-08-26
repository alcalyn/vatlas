import type { NextFunction, Request, Response } from 'express';
import { InvalidVatError } from '../vat/parse.js';
import { logger } from '../lib/logger.js';
import { CallbackUrlError } from '../services/callbacks.js';
import { MonitorError } from '../services/monitors.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra context returned next to the error, such as the date of a VIES answer. */
    readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * The JSON body {@link errorHandler} sends. Exported because the audit trail stores the envelope
   * the caller received, and it must be built in one place.
   */
  toBody(): Record<string, unknown> {
    return {
      error: { code: this.code, message: this.message },
      ...(this.meta ? { meta: this.meta } : {}),
    };
  }
}

/**
 * HTTP status of each service-level error, shared by the console and the API.
 *
 * `403` for a full monitor list (a plan rule), `409` for a duplicate.
 */
const REFUSAL_STATUS: Record<string, number> = {
  CALLBACK_URL_MISSING: 400,
  INVALID_CALLBACK_URL: 400,
  MONITOR_LIMIT_REACHED: 403,
  MONITOR_EXISTS: 409,
};

/** Single JSON error envelope for every API failure. */
export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof InvalidVatError) {
    res.status(400).json({ error: { code: 'INVALID_VAT_FORMAT', message: error.message, reason: error.reason } });
    return;
  }
  if (error instanceof CallbackUrlError || error instanceof MonitorError) {
    res.status(REFUSAL_STATUS[error.code] ?? 400).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ApiError) {
    res.status(error.status).json(error.toBody());
    return;
  }

  logger.error({ err: error }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } });
}
