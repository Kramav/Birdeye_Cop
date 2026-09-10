import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, FairQueue } from '../../src/speech/queue.js';
import { createLogger, createNullLogger } from '../../src/observability/logger.js';
import { deferred } from '../../src/utils/async.js';

function makeQueue(concurrency: number, maxQueued: number, lines?: string[]) {
  const logger = lines
    ? createLogger({ level: 'debug', transcriptLogging: false, sink: (l) => lines.push(l) })
    : createNullLogger();
  return new FairQueue({ concurrency, maxQueued, logger });
}

describe('FairQueue concurrency', () => {
  it('never exceeds the configured concurrency', async () => {
    const queue = makeQueue(2, 100);
    let active = 0;
    let peak = 0;

    const tasks = Array.from({ length: 10 }, (_, i) =>
      queue.submit(`user-${i % 3}`, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return i;
      }),
    );

    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(2);
    expect(queue.isIdle).toBe(true);
  });

  it('reports idle state through drain()', async () => {
    const queue = makeQueue(1, 10);
    const results: number[] = [];

    for (let i = 0; i < 3; i++) {
      void queue.submit('u', async () => {
        await new Promise((r) => setTimeout(r, 1));
        results.push(i);
        return i;
      });
    }

    await queue.drain();
    expect(results).toHaveLength(3);
  });
});

describe('FairQueue fairness', () => {
  it('does not make one speaker wait behind another speaker’s whole backlog', async () => {
    // The bypass this prevents: a continuous talker monopolising transcription
    // while someone else's single utterance never gets processed.
    const queue = makeQueue(1, 100);
    const order: string[] = [];

    const run = (label: string) => () => {
      order.push(label);
      return Promise.resolve(label);
    };

    const p1 = queue.submit('loud', run('loud-1'));
    const p2 = queue.submit('loud', run('loud-2'));
    const p3 = queue.submit('loud', run('loud-3'));
    const p4 = queue.submit('quiet', run('quiet-1'));

    await Promise.all([p1, p2, p3, p4]);

    expect(order).toHaveLength(4);
    expect(order.indexOf('quiet-1')).toBeLessThan(order.indexOf('loud-3'));
  });

  it('round-robins between speakers', async () => {
    const queue = makeQueue(1, 100);
    const order: string[] = [];
    const gate = deferred<void>();

    // Occupy the single slot so everything else is genuinely queued.
    const blocker = queue.submit('blocker', async () => {
      await gate.promise;
      return 'blocker';
    });

    const submissions = [
      queue.submit('a', () => Promise.resolve(order.push('a1'))),
      queue.submit('a', () => Promise.resolve(order.push('a2'))),
      queue.submit('b', () => Promise.resolve(order.push('b1'))),
      queue.submit('b', () => Promise.resolve(order.push('b2'))),
    ];

    gate.resolve();
    await Promise.all([blocker, ...submissions]);

    // Alternating, rather than draining `a` before touching `b`.
    expect(order).toEqual(['a1', 'b1', 'a2', 'b2']);
  });
});

describe('FairQueue overflow', () => {
  it('sheds from the longest queue, not from whoever spoke first', async () => {
    const queue = makeQueue(1, 2);
    const gate = deferred<void>();

    const running = queue.submit('loud', async () => {
      await gate.promise;
      return 'running';
    });

    const loud2 = queue.submit('loud', () => Promise.resolve('loud-2'));
    const loud3 = queue.submit('loud', () => Promise.resolve('loud-3'));

    // Queue is now full. The quiet speaker must still get in, at the loud
    // speaker's expense.
    const quiet = queue.submit('quiet', () => Promise.resolve('quiet-1'));

    await expect(loud3).rejects.toThrow(/Dropped from transcription queue/);

    gate.resolve();
    await expect(running).resolves.toBe('running');
    await expect(loud2).resolves.toBe('loud-2');
    await expect(quiet).resolves.toBe('quiet-1');
  });

  it('rejects the incoming segment when that speaker already owns the longest queue', async () => {
    const queue = makeQueue(1, 2);
    const gate = deferred<void>();

    const running = queue.submit('loud', async () => {
      await gate.promise;
      return 'running';
    });
    const q1 = queue.submit('loud', () => Promise.resolve(1));
    const q2 = queue.submit('loud', () => Promise.resolve(2));
    const overflow = queue.submit('loud', () => Promise.resolve(3));

    await expect(overflow).rejects.toThrow(/saturated/);

    gate.resolve();
    await Promise.all([running, q1, q2]);
  });

  it('reports every drop as STT_DEGRADED rather than dropping silently', async () => {
    // Silence must never be mistakable for "nothing was said".
    const lines: string[] = [];
    const queue = makeQueue(1, 1, lines);
    const gate = deferred<void>();

    const running = queue.submit('a', async () => {
      await gate.promise;
      return 1;
    });
    const queued = queue.submit('a', () => Promise.resolve(2));
    const dropped = queue.submit('a', () => Promise.resolve(3));

    await expect(dropped).rejects.toThrow();

    const degraded = lines.map((l) => JSON.parse(l)).filter((r) => r.event === 'STT_DEGRADED');
    expect(degraded.length).toBeGreaterThan(0);
    expect(degraded[0].userId).toBe('a');

    gate.resolve();
    await Promise.all([running, queued]);
  });
});

describe('FairQueue shutdown', () => {
  it('rejects queued work and refuses new submissions', async () => {
    const queue = makeQueue(1, 10);
    const gate = deferred<void>();

    const running = queue.submit('a', async () => {
      await gate.promise;
      return 1;
    });
    const queued = queue.submit('a', () => Promise.resolve(2));

    queue.destroy();
    await expect(queued).rejects.toThrow(/shut down/);
    await expect(queue.submit('a', () => Promise.resolve(3))).rejects.toThrow(/shut down/);

    gate.resolve();
    await running;
  });
});

describe('CircuitBreaker', () => {
  const makeBreaker = (threshold = 3, resetMs = 1000) => {
    let now = 0;
    const breaker = new CircuitBreaker({
      threshold,
      resetMs,
      logger: createNullLogger(),
      clock: () => now,
    });
    return { breaker, advance: (ms: number) => (now += ms) };
  };

  it('stays closed below the threshold', () => {
    const { breaker } = makeBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.isOpen).toBe(false);
    expect(breaker.canAttempt()).toBe(true);
  });

  it('opens at the threshold and blocks attempts', () => {
    const { breaker } = makeBreaker(3);
    for (let i = 0; i < 3; i++) breaker.recordFailure();

    expect(breaker.isOpen).toBe(true);
    expect(breaker.canAttempt()).toBe(false);
  });

  it('allows a single trial call after the reset window', () => {
    const { breaker, advance } = makeBreaker(2, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.canAttempt()).toBe(false);

    advance(1000);
    expect(breaker.canAttempt()).toBe(true); // half-open
    expect(breaker.currentState).toBe('half-open');
    expect(breaker.canAttempt()).toBe(false); // only one trial
  });

  it('closes on a successful trial', () => {
    const { breaker, advance } = makeBreaker(2, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    advance(1000);
    breaker.canAttempt();
    breaker.recordSuccess();

    expect(breaker.currentState).toBe('closed');
    expect(breaker.canAttempt()).toBe(true);
  });

  it('reopens immediately if the trial fails', () => {
    const { breaker, advance } = makeBreaker(2, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    advance(1000);
    breaker.canAttempt();
    breaker.recordFailure();

    expect(breaker.isOpen).toBe(true);
    expect(breaker.canAttempt()).toBe(false);
  });

  it('resets the failure count on success', () => {
    const { breaker } = makeBreaker(3);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.isOpen).toBe(false);
  });
});

describe('queue timers', () => {
  it('does not keep the process alive', () => {
    // Regression guard: a queue with no pending work must not hold handles.
    vi.useFakeTimers();
    const queue = makeQueue(1, 10);
    expect(queue.isIdle).toBe(true);
    queue.destroy();
    vi.useRealTimers();
  });
});
