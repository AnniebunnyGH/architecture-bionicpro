export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, message, details);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(403, message, details);
  }
}

export class PeriodNotProcessedError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(422, message, details);
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(503, message, details);
  }
}
