import { LogEvent } from '../observability/events.js';
import type { Logger } from '../observability/logger.js';
import { SttError } from '../utils/errors.js';
import { deferred } from '../utils/async.js';

interface QueueItem<T = unknown> {
  key: string;
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  controller: AbortController;
  enqueuedAt: number;
}

export interface FairQueueOptions {
  concurrency: number;
  maxQueued: number;
  logger: Logger;
  clock?: () => number;
}

/**
 * Concurrency-limited work queue with per-speaker fairness.
 *
 * A plain FIFO with drop-oldest is a moderation-bypass vector: sustained
 * cross-talk — precisely the situation where something worth catching is
 * likely being said — backs the queue up, and the oldest un-transcribed audio
 * is discarded first. Several people talking at once would make the queue do
 * the evading for them.
 *
 * So two rules apply instead:
 *
 *   1. Dispatch round-robins across speakers, so a continuous talker cannot
 *      starve someone who spoke once.
 *   2. On overflow, the *longest* queue sheds work — never an arbitrary
 *      oldest item — and every drop is reported as `STT_DEGRADED` rather than
 *      happening silently. Silent drops would let an operator read "no
 *      violations" as "nothing was said".
 */
export class FairQueue {
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly keyOrder: string[] = [];
  private cursor = 0;
  private active = 0;
  private queuedCount = 0;
  private destroyed = false;
  private readonly idleWaiters: Array<() => void> = [];
  private readonly clock: () => number;

  constructor(private readonly opts: FairQueueOptions) {
    this.clock = opts.clock ?? Date.now;
  }

  get queued(): number {
    return this.queuedCount;
  }

  get running(): number {
    return this.active;
  }

  get isIdle(): boolean {
    return this.active === 0 && this.queuedCount === 0;
  }

  submit<T>(key: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.destroyed) {
      return Promise.reject(new SttError('Transcription queue has been shut down', false));
    }

    const d = deferred<T>();
    const item: QueueItem<T> = {
      key,
      run,
      resolve: d.resolve,
      reject: d.reject,
      controller: new AbortController(),
      enqueuedAt: this.clock(),
    };

    if (this.queuedCount >= this.opts.maxQueued && !this.shedForRoom(key)) {
      // The incoming speaker already owns the longest queue, so they are the
      // one who has to wait rather than displacing anyone else.
      this.opts.logger.warn(LogEvent.STT_DEGRADED, {
        reason: 'queue-full',
        userId: key,
        queued: this.queuedCount,
        maxQueued: this.opts.maxQueued,
        message: 'Speech-to-text queue saturated; this segment was not transcribed',
      });
      return Promise.reject(
        new SttError('Transcription queue is saturated; segment dropped', false),
      );
    }

    this.enqueue(item as QueueItem);
    this.pump();
    return d.promise;
  }

  /**
   * Make room by dropping the newest item from whichever speaker has the most
   * queued. Returns false if that speaker is the incoming one.
   */
  private shedForRoom(incomingKey: string): boolean {
    let longestKey: string | undefined;
    let longestLength = 0;

    for (const [key, items] of this.queues) {
      if (items.length > longestLength) {
        longestKey = key;
        longestLength = items.length;
      }
    }

    if (longestKey === undefined || longestLength === 0) return false;
    if (longestKey === incomingKey) return false;

    const victim = this.queues.get(longestKey)!.pop();
    if (!victim) return false;
    this.queuedCount--;

    this.opts.logger.warn(LogEvent.STT_DEGRADED, {
      reason: 'shed-longest-queue',
      userId: longestKey,
      displacedBy: incomingKey,
      queued: this.queuedCount,
      message: 'Speech-to-text queue saturated; a segment was dropped without transcription',
    });
    victim.reject(new SttError('Dropped from transcription queue under load', false));
    return true;
  }

  private enqueue(item: QueueItem): void {
    let queue = this.queues.get(item.key);
    if (!queue) {
      queue = [];
      this.queues.set(item.key, queue);
      this.keyOrder.push(item.key);
    }
    queue.push(item);
    this.queuedCount++;
  }

  private takeNext(): QueueItem | undefined {
    if (this.keyOrder.length === 0) return undefined;

    for (let attempt = 0; attempt < this.keyOrder.length; attempt++) {
      const index = (this.cursor + attempt) % this.keyOrder.length;
      const key = this.keyOrder[index];
      const queue = this.queues.get(key);

      if (queue && queue.length > 0) {
        const item = queue.shift()!;
        this.queuedCount--;
        // Advance past this speaker so the next dispatch prefers someone else.
        this.cursor = (index + 1) % this.keyOrder.length;
        if (queue.length === 0) this.forgetKey(key);
        return item;
      }

      if (queue && queue.length === 0) this.forgetKey(key);
    }

    return undefined;
  }

  private forgetKey(key: string): void {
    const index = this.keyOrder.indexOf(key);
    if (index === -1) return;
    this.keyOrder.splice(index, 1);
    this.queues.delete(key);
    if (this.keyOrder.length === 0) {
      this.cursor = 0;
    } else if (this.cursor > index) {
      this.cursor--;
    }
    if (this.cursor >= this.keyOrder.length) this.cursor = 0;
  }

  private pump(): void {
    while (!this.destroyed && this.active < this.opts.concurrency) {
      const item = this.takeNext();
      if (!item) break;

      this.active++;
      void item
        .run(item.controller.signal)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active--;
          this.pump();
          this.notifyIfIdle();
        })
        .catch(() => undefined);
    }

    this.notifyIfIdle();
  }

  private notifyIfIdle(): void {
    if (!this.isIdle) return;
    while (this.idleWaiters.length > 0) {
      this.idleWaiters.pop()?.();
    }
  }

  /** Resolves once nothing is queued or running. */
  async drain(): Promise<void> {
    if (this.isIdle) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** Abort in-flight work and reject everything queued. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const queue of this.queues.values()) {
      for (const item of queue) {
        item.controller.abort();
        item.reject(new SttError('Transcription queue shut down', false));
      }
    }
    this.queues.clear();
    this.keyOrder.length = 0;
    this.queuedCount = 0;
    this.notifyIfIdle();
  }
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  threshold: number;
  resetMs: number;
  logger: Logger;
  clock?: () => number;
}

/**
 * Trips after repeated provider failures.
 *
 * The direction of failure matters: while the breaker is open the pipeline
 * takes **no** moderation action at all. An unavailable transcription service
 * must never be able to cause a kick, so the safe state is to moderate
 * nobody rather than to act on whatever partial signal remains.
 */
export class CircuitBreaker {
  private failures = 0;
  private state: BreakerState = 'closed';
  private openedAt = 0;
  private readonly clock: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.clock = opts.clock ?? Date.now;
  }

  get currentState(): BreakerState {
    return this.state;
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  /** Whether a call may proceed, transitioning to half-open when due. */
  canAttempt(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open' && this.clock() - this.openedAt >= this.opts.resetMs) {
      this.state = 'half-open';
      return true; // exactly one trial call
    }

    return false;
  }

  recordSuccess(): void {
    const wasTripped = this.state !== 'closed';
    this.failures = 0;
    this.state = 'closed';
    if (wasTripped) {
      this.opts.logger.info(LogEvent.STT_BREAKER_CLOSED, {
        message: 'Speech-to-text recovered; moderation resumed',
      });
    }
  }

  recordFailure(): void {
    this.failures++;

    if (this.state === 'half-open' || this.failures >= this.opts.threshold) {
      const wasOpen = this.state === 'open';
      this.state = 'open';
      this.openedAt = this.clock();
      if (!wasOpen) {
        this.opts.logger.error(LogEvent.STT_BREAKER_OPEN, {
          failures: this.failures,
          resetMs: this.opts.resetMs,
          message: 'Speech-to-text unavailable; no moderation actions will be taken',
        });
      }
    }
  }

  reset(): void {
    this.failures = 0;
    this.state = 'closed';
  }
}
