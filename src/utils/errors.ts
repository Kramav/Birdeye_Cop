/** Base for every error this application raises deliberately. */
export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Invalid or missing configuration. Always fatal at startup. */
export class ConfigError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super('CONFIG_INVALID', message, options);
  }
}

/** The bot lacks a Discord permission it needs to do something. */
export class PermissionError extends AppError {
  constructor(
    message: string,
    readonly missing: string[] = [],
    options?: ErrorOptions,
  ) {
    super('PERMISSION_DENIED', message, options);
  }
}

/** Speech-to-text failure. `retryable` drives the retry and breaker logic. */
export class SttError extends AppError {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super('STT_FAILED', message, options);
  }
}

export class TimeoutError extends AppError {
  constructor(
    readonly timeoutMs: number,
    label = 'operation',
  ) {
    super('TIMEOUT', `${label} timed out after ${timeoutMs}ms`);
  }
}

/** Evidence could not be captured or written. Never blocks a moderation action. */
export class EvidenceError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super('EVIDENCE_FAILED', message, options);
  }
}

/**
 * Raised when the user ID on a segment, transcription, and evidence record do
 * not all agree.
 *
 * This should be impossible by construction. If it is ever thrown, something
 * is deeply wrong with stream ownership and the only safe response is to
 * moderate nobody — which is exactly what the pipeline does.
 */
export class IdentityMismatchError extends AppError {
  constructor(
    readonly expectedUserId: string,
    readonly actualUserId: string,
    readonly stage: string,
  ) {
    super(
      'IDENTITY_MISMATCH',
      `User identity mismatch at ${stage}: expected ${expectedUserId}, got ${actualUserId}`,
    );
  }
}

/** Evidence ID failed validation, or resolved outside the evidence directory. */
export class UnsafePathError extends AppError {
  constructor(message: string) {
    super('UNSAFE_PATH', message);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Normalize an unknown thrown value into something loggable. */
export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' ? err : JSON.stringify(err));
}
