import { createHash } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

/**
 * `event` is typed as a plain string rather than the `LogEvent` union: callers
 * pass the constants from `events.ts`, but tests and one-off diagnostics need
 * arbitrary names, and a union widened with `| string` collapses to `string`
 * anyway.
 */
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /**
   * When false (the default), any field carrying transcribed speech is
   * replaced by a salted hash. This is the single enforcement point for the
   * `TRANSCRIPT_LOGGING` privacy control — callers cannot bypass it by
   * choosing a different field name, because the redaction is keyed on a
   * fixed set of field names that the whole codebase uses.
   */
  transcriptLogging: boolean;
  pretty?: boolean;
  /** Injectable for tests. */
  sink?: (line: string) => void;
  clock?: () => Date;
}

/**
 * Field names whose values are secrets. Matched case-insensitively as a
 * substring, so `sttApiKey`, `DISCORD_TOKEN` and `authorization` all match.
 *
 * Deliberately does NOT include a bare `key`, which would redact innocuous
 * fields like `keyword` or `dedupeKey`.
 */
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|credential|cookie|authorization|bearer|api[-_]?key|apikey)/i;

/**
 * Field names that carry transcribed speech. Gated behind `transcriptLogging`.
 */
const TRANSCRIPT_KEYS = new Set([
  'transcript',
  'text',
  'verifyTranscript',
  'matchedText',
  'alternatives',
]);

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 2000;

/** Stable, non-reversible identifier for a transcript, safe to log. */
export function hashText(text: string): string {
  return createHash('sha256').update(text.normalize('NFC')).digest('hex').slice(0, 16);
}

function isBinary(value: unknown): boolean {
  return (
    Buffer.isBuffer(value) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof SharedArrayBuffer
  );
}

function byteLength(value: unknown): number {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) return value.byteLength;
  return 0;
}

function serializeError(err: Error): LogFields {
  return {
    name: err.name,
    message: err.message,
    ...(err.stack ? { stack: err.stack.split('\n').slice(0, 8).join('\n') } : {}),
    ...(err.cause instanceof Error ? { cause: serializeError(err.cause) } : {}),
  };
}

/**
 * Recursively sanitize a value before it reaches the log sink.
 *
 * Three hard guarantees, all enforced here rather than at call sites:
 *   1. Raw audio can never be logged — any Buffer/TypedArray/ArrayBuffer is
 *      replaced by a byte-count marker.
 *   2. Secrets are never logged — matched on field name.
 *   3. Transcripts are hashed unless explicitly enabled.
 */
function sanitize(
  value: unknown,
  transcriptLogging: boolean,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) return value;

  if (isBinary(value)) {
    return `[binary omitted: ${byteLength(value)} bytes]`;
  }

  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[truncated]` : s;
  }
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return (value as bigint).toString();
  if (t === 'function' || t === 'symbol') return `[${t}]`;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value);

  if (depth >= MAX_DEPTH) return '[max depth]';

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = value
      .slice(0, MAX_ARRAY)
      .map((v) => sanitize(v, transcriptLogging, depth + 1, seen));
    if (value.length > MAX_ARRAY) out.push(`[+${value.length - MAX_ARRAY} more]`);
    return out;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return '[circular]';
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        out[k] = REDACTED;
        continue;
      }
      if (TRANSCRIPT_KEYS.has(k) && !transcriptLogging) {
        // Keep something correlatable without keeping the words themselves.
        if (typeof v === 'string') {
          out[`${k}Hash`] = hashText(v);
          out[`${k}Length`] = v.length;
        } else if (v !== null && v !== undefined) {
          out[`${k}Hash`] = '[omitted]';
        }
        continue;
      }
      out[k] = sanitize(v, transcriptLogging, depth + 1, seen);
    }
    return out;
  }

  // Unreachable in practice — every type is handled above. Returning a marker
  // rather than String(value) guarantees we can never emit "[object Object]",
  // or worse, some object's custom toString containing data we meant to redact.
  return '[unserializable]';
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

class StructuredLogger implements Logger {
  constructor(
    private readonly opts: Required<Pick<LoggerOptions, 'level' | 'transcriptLogging'>> &
      LoggerOptions,
    private readonly bindings: LogFields = {},
  ) {}

  private write(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.opts.level]) return;

    const clock = this.opts.clock ?? (() => new Date());
    const merged = { ...this.bindings, ...(fields ?? {}) };
    const safe = sanitize(merged, this.opts.transcriptLogging) as LogFields;

    const record = {
      time: clock().toISOString(),
      level,
      event,
      ...safe,
    };

    const sink = this.opts.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

    if (this.opts.pretty) {
      const color = LEVEL_COLOR[level];
      const detail = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : '';
      sink(`${color}${record.time} ${level.toUpperCase().padEnd(5)} ${event}\x1b[0m${detail}`);
      return;
    }

    sink(JSON.stringify(record));
  }

  debug(event: string, fields?: LogFields): void {
    this.write('debug', event, fields);
  }
  info(event: string, fields?: LogFields): void {
    this.write('info', event, fields);
  }
  warn(event: string, fields?: LogFields): void {
    this.write('warn', event, fields);
  }
  error(event: string, fields?: LogFields): void {
    this.write('error', event, fields);
  }

  child(bindings: LogFields): Logger {
    return new StructuredLogger(this.opts, { ...this.bindings, ...bindings });
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  return new StructuredLogger(opts);
}

/** A logger that discards everything. Useful in tests. */
export function createNullLogger(): Logger {
  return createLogger({ level: 'error', transcriptLogging: false, sink: () => {} });
}

// Exported for direct unit testing of the sanitizer's guarantees.
export const __testing = { sanitize, SECRET_KEY_PATTERN, TRANSCRIPT_KEYS };
