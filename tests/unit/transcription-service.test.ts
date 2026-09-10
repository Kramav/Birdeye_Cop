import { describe, expect, it } from 'vitest';
import { TranscriptionService } from '../../src/speech/transcription-service.js';
import { MockSttProvider } from '../../src/speech/providers/mock.js';
import type { MockScriptEntry } from '../../src/speech/providers/mock.js';
import { CircuitBreaker, FairQueue } from '../../src/speech/queue.js';
import { createNullLogger } from '../../src/observability/logger.js';
import { SttError } from '../../src/utils/errors.js';
import type { SttConfig } from '../../src/config/types.js';
import { makeSegment } from '../helpers/segment.js';
import { testSttConfig } from '../helpers/config.js';

function makeService(opts: {
  primaryScript?: MockScriptEntry[];
  verifyScript?: MockScriptEntry[];
  config?: Partial<SttConfig>;
} = {}) {
  const logger = createNullLogger();
  const config = testSttConfig(opts.config);

  const primary = new MockSttProvider({
    name: 'mock',
    ...(opts.primaryScript ? { script: opts.primaryScript } : { defaultText: 'hello world' }),
  });
  const verify = new MockSttProvider({
    name: 'mock-verify',
    ...(opts.verifyScript ? { script: opts.verifyScript } : { defaultText: 'hello world' }),
  });

  const queue = new FairQueue({
    concurrency: config.maxConcurrency,
    maxQueued: config.queueMax,
    logger,
  });
  const breaker = new CircuitBreaker({
    threshold: config.breakerThreshold,
    resetMs: config.breakerResetMs,
    logger,
  });

  const service = new TranscriptionService({ primary, verify, config, queue, breaker, logger });
  return { service, primary, verify, queue, breaker, config };
}

describe('successful transcription', () => {
  it('carries the segment identity through untouched', async () => {
    const { service } = makeService({ primaryScript: ['banned words here'] });
    const segment = makeSegment({ userId: 'user-42', guildId: 'g9', channelId: 'c3' });

    const outcome = await service.transcribe(segment);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.transcription.userId).toBe('user-42');
    expect(outcome.transcription.guildId).toBe('g9');
    expect(outcome.transcription.channelId).toBe('c3');
    expect(outcome.transcription.segmentId).toBe(segment.segmentId);
    expect(outcome.transcription.text).toBe('banned words here');
    expect(outcome.transcription.isVerification).toBe(false);
  });

  it('treats an empty transcript as nothing to act on', async () => {
    const { service } = makeService({ primaryScript: [''] });
    const outcome = await service.transcribe(makeSegment());

    expect(outcome).toEqual({ ok: false, reason: 'empty' });
  });

  it('uses the primary model for the first pass', async () => {
    const { service, primary } = makeService();
    await service.transcribe(makeSegment());
    expect(primary.modelsRequested).toEqual(['mock-primary']);
  });
});

describe('verify pass', () => {
  it('uses a different provider and model', async () => {
    const { service, verify, primary } = makeService({ verifyScript: ['second opinion'] });
    const segment = makeSegment();

    const outcome = await service.verify(segment);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.transcription.isVerification).toBe(true);
    expect(outcome.transcription.provider).toBe('mock-verify');
    expect(verify.modelsRequested).toEqual(['mock-verify']);
    expect(primary.callCount).toBe(0);
  });

  it('preserves identity on the verification result too', async () => {
    const { service } = makeService({ verifyScript: ['x'] });
    const segment = makeSegment({ userId: 'user-77' });

    const outcome = await service.verify(segment);
    expect(outcome.ok && outcome.transcription.userId).toBe('user-77');
  });
});

describe('failures', () => {
  it('reports a provider error without throwing', async () => {
    const { service } = makeService({
      primaryScript: [new SttError('upstream exploded', false, 400)],
    });

    const outcome = await service.transcribe(makeSegment());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('failed');
  });

  it('times out a hung provider', async () => {
    const { service } = makeService({
      primaryScript: [{ text: 'too slow', delayMs: 400 }],
      config: { timeoutMs: 30 },
    });

    const outcome = await service.transcribe(makeSegment());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('timeout');
  });

  it('retries once on a retryable error and can then succeed', async () => {
    const { service, primary } = makeService({
      primaryScript: [new SttError('503 upstream', true, 503), 'recovered text'],
    });

    const outcome = await service.transcribe(makeSegment());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.transcription.text).toBe('recovered text');
    expect(primary.callCount).toBe(2);
  });

  it('does not retry a client error', async () => {
    const { service, primary } = makeService({
      primaryScript: [new SttError('401 unauthorized', false, 401), 'never reached'],
    });

    const outcome = await service.transcribe(makeSegment());
    expect(outcome.ok).toBe(false);
    expect(primary.callCount).toBe(1);
  });
});

describe('circuit breaker integration', () => {
  it('stops calling the provider once the breaker opens', async () => {
    const { service, primary, breaker } = makeService({
      primaryScript: [
        new SttError('down', false),
        new SttError('down', false),
        new SttError('down', false),
      ],
      config: { breakerThreshold: 2 },
    });

    await service.transcribe(makeSegment());
    await service.transcribe(makeSegment());
    expect(breaker.isOpen).toBe(true);

    const callsBefore = primary.callCount;
    const outcome = await service.transcribe(makeSegment());

    expect(outcome).toEqual({ ok: false, reason: 'breaker-open' });
    expect(primary.callCount).toBe(callsBefore);
    expect(service.available).toBe(false);
  });

  it('recovers after a successful call', async () => {
    const { service, breaker } = makeService({
      primaryScript: [new SttError('down', false), 'back online'],
      config: { breakerThreshold: 1, breakerResetMs: 0 },
    });

    await service.transcribe(makeSegment());
    expect(breaker.isOpen).toBe(true);

    const outcome = await service.transcribe(makeSegment());
    expect(outcome.ok).toBe(true);
    expect(service.available).toBe(true);
  });

  it('does not let a queue drop count as a provider failure', async () => {
    // A capacity problem is not an outage; letting drops trip the breaker
    // would turn a busy channel into a total moderation outage.
    const { service, breaker } = makeService({
      config: { maxConcurrency: 1, queueMax: 1, breakerThreshold: 2 },
      primaryScript: [{ text: 'slow', delayMs: 50 }],
    });

    const segments = [
      makeSegment({ userId: 'u1' }),
      makeSegment({ userId: 'u1' }),
      makeSegment({ userId: 'u1' }),
    ];
    const results = await Promise.all(segments.map((s) => service.transcribe(s)));

    const dropped = results.filter((r) => !r.ok && r.reason === 'dropped');
    expect(dropped.length).toBeGreaterThan(0);
    expect(breaker.isOpen).toBe(false);
  });
});
