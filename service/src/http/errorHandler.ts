import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../domain/errors';

const body = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

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
    const e = err as { code?: string; cause?: { code?: string } };
    const pgCode = e.code ?? e.cause?.code;
    if (pgCode === '55P03' || pgCode === '57014' || /timeout exceeded when trying to connect/.test(err.message)) {
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