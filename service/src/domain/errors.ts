/** Errors the API turns into HTTP responses (status + stable machine-readable code). */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(404, 'not_found', message, details);
  }
}

/** The thing existed but was deleted. */
export class GoneError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(410, 'gone', message, details);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(409, code, message, details);
  }
}