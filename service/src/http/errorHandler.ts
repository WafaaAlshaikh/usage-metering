import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../domain/errors';

const body = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

const POOL_TIMEOUT = /timeout exceeded when trying to connect/;

/** Pool wait timeout, lock_timeout (55P03) or statement_timeout (57014), directly or wrapped as `cause`. */
function isOverload(err: unknown): boolean {
  let e = err as { code?: string; message?: string; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 5; depth++) {
    if (e.code === '55P03' || e.code === '57014') return true;
    if (typeof e.message === 'string' && POOL_TIMEOUT.test(e.message)) return true;
    e = e.cause as typeof e;
  }
  return false;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send(body(err.code, err.message, err.details));
    }
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return reply.status(400).send(body('validation_error', 'Request validation failed', issues));
    }
    // Fastify's own 4xx (malformed JSON, body too large, wrong content type...).
    const statusCode = (err as FastifyError).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send(body('bad_request', err.message));
    }
    // Overload: pool exhausted, lock wait or statement timed out. Safe to retry with the same
    // requestId, because consume is idempotent.
    if (isOverload(err)) {
      return reply
        .status(503)
        .header('retry-after', '1')
        .send(body('busy', 'Service is busy, retry with the same requestId'));
    }
    // Anything else is our bug: log it, never leak internals.
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send(body('internal_error', 'Internal server error'));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send(body('not_found', `Route ${req.method} ${req.url} not found`));
  });
}