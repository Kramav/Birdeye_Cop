import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserAudioStream } from '../../src/voice/user-stream.js';
import { EnergyVad } from '../../src/voice/speech-detector.js';
import { TimestampedPcmRing } from '../../src/voice/ring-buffer.js';
import { createNullLogger } from '../../src/observability/logger.js';
import { DISCORD_SAMPLE_RATE } from '../../src/voice/pcm.js';
import type { AudioSegment } from '../../src/voice/types.js';
import { peakAmplitude, silencePcm, tonePcm } from '../helpers/audio.js';
import { testVoiceConfig } from '../helpers/config.js';

interface Harness {
  stream: UserAudioStream;
  segments: AudioSegment[];
  advanceClock(ms: number): void;
}

function makeStream(
  userId: string,
  overrides: Partial<ReturnType<typeof testVoiceConfig>> = {},
  ring?: TimestampedPcmRing,
): Harness {
  const config = testVoiceConfig(overrides);
  const segments: AudioSegment[] = [];
  let now = 100_000;

  const stream = new UserAudioStream({
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId,
    detector: new EnergyVad({
      energyThreshold: config.vadEnergyThreshold,
      minSpeechMs: config.minSpeechMs,
    }),
    config,
    onSegment: (s) => segments.push(s),
    logger: createNullLogger(),
    ...(ring ? { ring } : {}),
    clock: () => now,
  });

  return {
    stream,
    segments,
    advanceClock: (ms: number) => {
      now += ms;
    },
  };
}

describe('UserAudioStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits a segment stamped with the owning user ID', () => {
    const h = makeStream('user-abc');
    h.stream.appendPcm(tonePcm(400));
    h.advanceClock(400);
    h.stream.appendPcm(silencePcm(200));
    h.stream.markSubscriptionEnd();

    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].userId).toBe('user-abc');
    expect(h.segments[0].guildId).toBe('guild-1');
    expect(h.segments[0].channelId).toBe('channel-1');
  });

  it('produces 16 kHz PCM sized to the speech duration', () => {
    const h = makeStream('user-abc');
    h.stream.appendPcm(tonePcm(600));
    h.stream.appendPcm(silencePcm(200));
    h.stream.markSubscriptionEnd();

    const segment = h.segments[0];
    expect(segment.durationMs).toBeGreaterThanOrEqual(600);
    // 16 kHz mono: one sample per 1/16 ms.
    expect(segment.pcm16k.length).toBeCloseTo((segment.durationMs * 16_000) / 1000, -1);
  });

  it('discards silence without emitting a segment', () => {
    const h = makeStream('user-abc');
    h.stream.appendPcm(silencePcm(1000));
    h.stream.markSubscriptionEnd();

    expect(h.segments).toHaveLength(0);
  });

  it('discards speech shorter than minSpeechMs', () => {
    const h = makeStream('user-abc', { minSpeechMs: 500 });
    h.stream.appendPcm(tonePcm(100));
    h.stream.appendPcm(silencePcm(200));
    h.stream.markSubscriptionEnd();

    expect(h.segments).toHaveLength(0);
  });

  describe('coalescing (discord.js#8105 mitigation)', () => {
    it('flushes immediately when the stream ended on silence', () => {
      const h = makeStream('user-abc');
      h.stream.appendPcm(tonePcm(400));
      h.stream.appendPcm(silencePcm(200));
      h.stream.markSubscriptionEnd();

      // No timer advance: a genuine end-of-utterance must not pay the
      // coalescing delay.
      expect(h.segments).toHaveLength(1);
    });

    it('waits when the stream was cut mid-speech', () => {
      const h = makeStream('user-abc');
      h.stream.appendPcm(tonePcm(400));
      h.stream.markSubscriptionEnd();

      expect(h.segments).toHaveLength(0);

      vi.advanceTimersByTime(600);
      expect(h.segments).toHaveLength(1);
      expect(h.segments[0].reason).toBe('coalesce-expired');
    });

    it('treats a continuation as the same utterance, not two segments', () => {
      const h = makeStream('user-abc');
      h.stream.appendPcm(tonePcm(400));
      h.stream.markSubscriptionEnd();

      vi.advanceTimersByTime(200);
      h.advanceClock(200);
      h.stream.appendPcm(tonePcm(400)); // continuation arrives
      h.stream.appendPcm(silencePcm(200));
      h.stream.markSubscriptionEnd();

      expect(h.segments).toHaveLength(1);
      expect(h.segments[0].durationMs).toBeGreaterThan(700);
    });

    it('skips the coalescing window entirely when disabled', () => {
      const h = makeStream('user-abc', { segmentCoalesceMs: 0 });
      h.stream.appendPcm(tonePcm(400));
      h.stream.markSubscriptionEnd();

      expect(h.segments).toHaveLength(1);
      expect(h.segments[0].reason).toBe('silence');
    });
  });

  it('force-flushes a monologue at maxSegmentMs to bound latency', () => {
    const h = makeStream('user-abc', { maxSegmentMs: 1000 });
    for (let i = 0; i < 6; i++) {
      h.stream.appendPcm(tonePcm(200));
      h.advanceClock(200);
    }

    expect(h.segments.length).toBeGreaterThanOrEqual(1);
    expect(h.segments[0].reason).toBe('max-duration');
    expect(h.segments[0].durationMs).toBeLessThanOrEqual(1100);
  });

  it('flushes buffered speech when the user leaves mid-utterance', () => {
    const h = makeStream('user-abc');
    h.stream.appendPcm(tonePcm(500));
    h.stream.destroy();

    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].reason).toBe('teardown');
    expect(h.stream.isDestroyed).toBe(true);
  });

  it('can discard buffered audio on teardown when asked', () => {
    const h = makeStream('user-abc');
    h.stream.appendPcm(tonePcm(500));
    h.stream.destroy({ flush: false });

    expect(h.segments).toHaveLength(0);
  });

  it('ignores audio after destruction', () => {
    const h = makeStream('user-abc');
    h.stream.destroy();
    h.stream.appendPcm(tonePcm(500));
    h.stream.markSubscriptionEnd();

    expect(h.segments).toHaveLength(0);
  });

  it('is idempotent on repeated destroy', () => {
    const h = makeStream('user-abc');
    h.stream.appendPcm(tonePcm(500));
    h.stream.destroy();
    h.stream.destroy();

    expect(h.segments).toHaveLength(1);
  });

  it('survives a throwing segment handler', () => {
    const config = testVoiceConfig();
    const stream = new UserAudioStream({
      guildId: 'g',
      channelId: 'c',
      userId: 'u',
      detector: new EnergyVad({ energyThreshold: 0.02, minSpeechMs: 300 }),
      config,
      onSegment: () => {
        throw new Error('downstream exploded');
      },
      logger: createNullLogger(),
    });

    expect(() => {
      stream.appendPcm(tonePcm(400));
      stream.appendPcm(silencePcm(200));
      stream.markSubscriptionEnd();
    }).not.toThrow();
  });

  describe('simultaneous speakers', () => {
    it('keeps each speaker’s audio and identity separate', () => {
      // Distinct amplitudes make cross-contamination detectable in the audio
      // itself, not just in the metadata.
      const loud = makeStream('user-loud');
      const quiet = makeStream('user-quiet');

      // Interleave the writes the way concurrent speakers actually arrive.
      for (let i = 0; i < 4; i++) {
        loud.stream.appendPcm(tonePcm(150, { amplitude: 0.8, frequency: 300 }));
        quiet.stream.appendPcm(tonePcm(150, { amplitude: 0.2, frequency: 900 }));
        loud.advanceClock(150);
        quiet.advanceClock(150);
      }
      loud.stream.appendPcm(silencePcm(200));
      quiet.stream.appendPcm(silencePcm(200));
      loud.stream.markSubscriptionEnd();
      quiet.stream.markSubscriptionEnd();

      expect(loud.segments).toHaveLength(1);
      expect(quiet.segments).toHaveLength(1);

      expect(loud.segments[0].userId).toBe('user-loud');
      expect(quiet.segments[0].userId).toBe('user-quiet');

      expect(peakAmplitude(loud.segments[0].pcm16k)).toBeGreaterThan(0.6);
      expect(peakAmplitude(quiet.segments[0].pcm16k)).toBeLessThan(0.4);
    });

    it('gives each speaker an independent evidence ring', () => {
      const ringA = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 5000);
      const ringB = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 5000);

      const a = makeStream('user-a', {}, ringA);
      const b = makeStream('user-b', {}, ringB);

      a.stream.appendPcm(tonePcm(300, { amplitude: 0.9 }));
      // B never speaks, so B's ring must stay empty.

      expect(ringA.sampleCount).toBeGreaterThan(0);
      expect(ringB.sampleCount).toBe(0);
      void b;
    });
  });

  it('reports memory held for the user', () => {
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 5000);
    const h = makeStream('user-abc', {}, ring);
    expect(h.stream.memoryBytes).toBe(0);

    h.stream.appendPcm(tonePcm(200));
    expect(h.stream.memoryBytes).toBeGreaterThan(0);
  });
});
