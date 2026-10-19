interface PgLikeError {
  code?: string;
  constraint?: string;
  cause?: unknown;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as PgLikeError | null;
  const pg = e?.code === '23505' ? e : (e?.cause as PgLikeError | undefined);
  return pg?.code === '23505' && (constraint === undefined || pg.constraint === constraint);
}