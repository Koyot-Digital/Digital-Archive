/**
 * Typed application errors.
 *
 * Every route throws one of these; the error plugin turns them into a stable
 * JSON envelope. Unknown throws become a 500 with no detail leaked.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  /** Surfaced to the client. Internal errors keep their message server-side. */
  readonly expose: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { details?: unknown; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.expose = options.expose ?? statusCode < 500;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "bad_request", message, { details });

export const unauthorized = (message = "Authentication required") =>
  new AppError(401, "unauthorized", message);

export const forbidden = (message = "Insufficient permissions") =>
  new AppError(403, "forbidden", message);

export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, "conflict", message, { details });

export const payloadTooLarge = (message: string) =>
  new AppError(413, "payload_too_large", message);

export const unsupportedMedia = (message: string) =>
  new AppError(415, "unsupported_media_type", message);

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, "unprocessable_entity", message, { details });

export const tooManyRequests = (message = "Rate limit exceeded") =>
  new AppError(429, "rate_limited", message);

export const internal = (message: string, cause?: unknown) =>
  new AppError(500, "internal_error", message, { expose: false, cause });

export const serviceUnavailable = (message = "Service temporarily unavailable") =>
  new AppError(503, "service_unavailable", message);
