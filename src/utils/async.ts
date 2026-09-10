import { TimeoutError, toError } from './errors.js';
import type { Logger } from '../observability/logger.js';

/** Resolves after `ms`, or rejects if `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn` with a deadline.
 *
 * The signal handed to `fn` aborts on timeout, so cooperative callers (fetch,
 * for instance) cancel their real work rather than leaving it running. The
 * race is a backstop for uncooperative callers; the loser's rejection is
 * swallowed so it cannot surface as an unhandled rejection.
 */
export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { label?: string; parentSignal?: AbortSignal } = {},
): Promise<T> {
  const { label = 'operation', parentSignal } = opts;
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new TimeoutError(ms, label);
      controller.abort(err);
      reject(err);
    }, ms);
  });

  const work = fn(signal);
  // Attach a no-op handler so that if the timeout wins the race, a later
  // rejection of `work` is already handled.
  work.catch(() => undefined);

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run a promise at an async boundary where there is no caller to await it,
 * guaranteeing the rejection is logged rather than becoming an unhandled
 * rejection. Every `void somePromise()` in this codebase should use this.
 */
export function fireAndForget(
  promise: Promise<unknown>,
  logger: Logger,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  promise.catch((err: unknown) => {
    logger.error(event, { ...fields, err: toError(err) });
  });
}

/** A promise plus its resolvers, for bridging event-driven code. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
