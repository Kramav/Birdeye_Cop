import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceRecorder, DisabledEvidenceRecorder } from '../../src/evidence/recorder.js';
import { RetentionSweeper } from '../../src/evidence/store.js';
import { MemoryModerationStore } from '../../src/storage/memory-store.js';
import { createNullLogger } from '../../src/observability/logger.js';
import { TimestampedPcmRing } from '../../src/voice/ring-buffer.js';
import { DISCORD_SAMPLE_RATE, decodeWav, msToSamples, rms } from '../../src/voice/pcm.js';
import { IdentityMismatchError } from '../../src/utils/errors.js';
import { makeSegment } from '../helpers/segment.js';
import { testEvidenceConfig } from '../helpers/config.js';

let dir: string;
let store: MemoryModerationStore;

const NOW = 1_700_000_000_000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'birdeye-evidence-'));
  store = new MemoryModerationStore();
  await store.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeRecorder(overrides: Parameters<typeof testEvidenceConfig>[0] = {}) {
  const config = testEvidenceConfig({
    enabled: true,
    directory: dir,
    prebufferMs: 1000,
    postbufferMs: 500,
    retentionDays: 7,
    biometricRiskAcknowledged: true,
    ...overrides,
  });
  return {
    config,
    recorder: new EvidenceRecorder({
      config,
      store,
      logger: createNullLogger(),
      clock: () => NOW,
    }),
  };
}

/** Fill a ring with constant-amplitude audio over a time span. */
function fillRing(ring: TimestampedPcmRing, fromMs: number, toMs: number, value: number): void {
  const step = 20;
  for (let t = fromMs; t < toMs; t += step) {
    const pcm = new Int16Array(msToSamples(step, DISCORD_SAMPLE_RATE));
    pcm.fill(value);
    ring.push(pcm, t);
  }
}

describe('when violation audio logging is disabled', () => {
  it('captures nothing at all', async () => {
    const recorder = new DisabledEvidenceRecorder();
    expect(recorder.enabled).toBe(false);
    await expect(recorder.capture()).resolves.toBeUndefined();

    expect(await readdir(dir)).toHaveLength(0);
  });
});

describe('capture', () => {
  it('writes a wav file and a metadata record', async () => {
    const { recorder } = makeRecorder();
    const segment = makeSegment({ startedAt: 10_000, durationMs: 2000 });
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    fillRing(ring, 9_000, 12_500, 8000);

    const record = await recorder.capture({
      segment,
      ring,
      ownerUserId: segment.userId,
      ruleId: 'rule-1',
      action: 'disconnect',
    });

    expect(record).toBeDefined();
    expect(record!.userId).toBe(segment.userId);
    expect(record!.ruleId).toBe('rule-1');
    expect(record!.action).toBe('disconnect');

    const onDisk = await readFile(record!.filePath);
    expect(onDisk.toString('ascii', 0, 4)).toBe('RIFF');

    expect(await store.getEvidence(record!.id)).toBeDefined();
  });

  it('uses a timestamped, non-user-controlled filename', async () => {
    const { recorder } = makeRecorder();
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    fillRing(ring, 9_000, 12_500, 8000);

    const record = await recorder.capture({
      segment: makeSegment({ startedAt: 10_000, durationMs: 2000 }),
      ring,
      ownerUserId: 'user-1',
      ruleId: 'r',
      action: 'kick',
    });

    expect(record!.filename).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[0-9a-f-]{36}\.wav$/,
    );
  });

  it('writes the file owner-readable only', async () => {
    const { recorder } = makeRecorder();
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    fillRing(ring, 9_000, 12_500, 8000);

    const record = await recorder.capture({
      segment: makeSegment({ startedAt: 10_000, durationMs: 2000 }),
      ring,
      ownerUserId: 'user-1',
      ruleId: 'r',
      action: 'kick',
    });

    const info = await stat(record!.filePath);
    if (process.platform !== 'win32') {
      expect(info.mode & 0o777).toBe(0o600);
    }
    expect(info.size).toBeGreaterThan(44);
  });

  it('sets an expiry from the retention setting', async () => {
    const { recorder } = makeRecorder({ retentionDays: 3 });
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    fillRing(ring, 9_000, 12_500, 8000);

    const record = await recorder.capture({
      segment: makeSegment({ startedAt: 10_000, durationMs: 2000 }),
      ring,
      ownerUserId: 'user-1',
      ruleId: 'r',
      action: 'kick',
    });

    expect(record!.expiresAt - record!.createdAt).toBe(3 * 24 * 60 * 60 * 1000);
  });
});

describe('pre-buffer and post-buffer', () => {
  it('captures the configured amount of audio before and after the segment', async () => {
    const { recorder } = makeRecorder({ prebufferMs: 1000, postbufferMs: 500 });
    const segment = makeSegment({ startedAt: 10_000, durationMs: 2000 });

    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    fillRing(ring, 8_000, 13_000, 8000);

    const record = await recorder.capture({
      segment,
      ring,
      ownerUserId: segment.userId,
      ruleId: 'r',
      action: 'kick',
    });

    // 1000 pre + 2000 speech + 500 post
    expect(record!.durationMs).toBe(3500);
  });

  it.each([
    [0, 0, 2000],
    [500, 0, 2500],
    [0, 750, 2750],
    [2000, 2000, 6000],
  ])('pre=%ims post=%ims yields %ims', async (pre, post, expected) => {
    const { recorder } = makeRecorder({ prebufferMs: pre, postbufferMs: post });
    const segment = makeSegment({ startedAt: 10_000, durationMs: 2000 });

    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 60_000);
    fillRing(ring, 5_000, 15_000, 8000);

    const record = await recorder.capture({
      segment,
      ring,
      ownerUserId: segment.userId,
      ruleId: 'r',
      action: 'kick',
    });

    expect(record!.durationMs).toBe(expected);
  });

  it('pads with silence when no trailing audio arrived', async () => {
    // The realistic case: the speaker is disconnected, so nothing follows the
    // segment. The clip must still be the requested length rather than
    // borrowing unrelated audio.
    const { recorder } = makeRecorder({ prebufferMs: 0, postbufferMs: 1000 });
    const segment = makeSegment({ startedAt: 10_000, durationMs: 1000 });

    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    fillRing(ring, 10_000, 11_000, 8000); // nothing after 11_000

    const record = await recorder.capture({
      segment,
      ring,
      ownerUserId: segment.userId,
      ruleId: 'r',
      action: 'kick',
    });

    expect(record!.durationMs).toBe(2000);

    const { pcm } = decodeWav(await readFile(record!.filePath));
    const half = msToSamples(1000, DISCORD_SAMPLE_RATE);
    expect(rms(pcm, 0, half)).toBeGreaterThan(0);
    expect(rms(pcm, half, pcm.length)).toBe(0);
  });
});

describe('speaker isolation', () => {
  it('saves only the violating speaker’s audio', async () => {
    const { recorder } = makeRecorder({ prebufferMs: 0, postbufferMs: 0 });

    // Two speakers talking at the same time, at clearly different levels.
    const ringA = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    const ringB = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    fillRing(ringA, 10_000, 12_000, 4000);
    fillRing(ringB, 10_000, 12_000, 30000);

    const segmentA = makeSegment({ userId: 'user-a', startedAt: 10_000, durationMs: 2000 });

    const record = await recorder.capture({
      segment: segmentA,
      ring: ringA,
      ownerUserId: 'user-a',
      ruleId: 'r',
      action: 'kick',
    });

    const { pcm } = decodeWav(await readFile(record!.filePath));
    // Every sample must come from A's ring, never B's much louder audio.
    expect(Math.max(...Array.from(pcm).map(Math.abs))).toBe(4000);
  });

  it('refuses to write a silent file when the buffer holds nothing from that period', async () => {
    // Reachable if the bot moved channels between capture and capture-time, or
    // if the buffer aged out. A silent clip labelled as evidence is worse than
    // no clip.
    const { recorder } = makeRecorder();
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    fillRing(ring, 50_000, 52_000, 8000); // long after the segment

    await expect(
      recorder.capture({
        segment: makeSegment({ startedAt: 10_000, durationMs: 2000 }),
        ring,
        ownerUserId: 'user-1',
        ruleId: 'r',
        action: 'kick',
      }),
    ).rejects.toThrow(/no audio overlapping/);

    expect(await readdir(dir)).toHaveLength(0);
  });

  it('refuses to attach one speaker’s buffer to another speaker’s violation', async () => {
    const { recorder } = makeRecorder();
    const ringB = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    fillRing(ringB, 9_000, 13_000, 20000);

    const segmentA = makeSegment({ userId: 'user-a', startedAt: 10_000, durationMs: 2000 });

    await expect(
      recorder.capture({
        segment: segmentA,
        ring: ringB,
        ownerUserId: 'user-b', // mismatched owner
        ruleId: 'r',
        action: 'kick',
      }),
    ).rejects.toThrow(IdentityMismatchError);

    // Nothing must have been written.
    expect(await readdir(dir)).toHaveLength(0);
  });

  it('keeps concurrent captures for different speakers separate', async () => {
    const { recorder } = makeRecorder({ prebufferMs: 0, postbufferMs: 0 });

    const ringA = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    const ringB = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    fillRing(ringA, 10_000, 12_000, 5000);
    fillRing(ringB, 10_000, 12_000, 25000);

    const [recA, recB] = await Promise.all([
      recorder.capture({
        segment: makeSegment({ userId: 'user-a', startedAt: 10_000, durationMs: 2000 }),
        ring: ringA,
        ownerUserId: 'user-a',
        ruleId: 'r',
        action: 'kick',
      }),
      recorder.capture({
        segment: makeSegment({ userId: 'user-b', startedAt: 10_000, durationMs: 2000 }),
        ring: ringB,
        ownerUserId: 'user-b',
        ruleId: 'r',
        action: 'kick',
      }),
    ]);

    expect(recA!.id).not.toBe(recB!.id);
    expect(recA!.filePath).not.toBe(recB!.filePath);

    const pcmA = decodeWav(await readFile(recA!.filePath)).pcm;
    const pcmB = decodeWav(await readFile(recB!.filePath)).pcm;

    expect(Math.max(...Array.from(pcmA).map(Math.abs))).toBe(5000);
    expect(Math.max(...Array.from(pcmB).map(Math.abs))).toBe(25000);
  });
});

describe('retention', () => {
  it('deletes expired evidence and its audio file', async () => {
    const { recorder, config } = makeRecorder({ retentionDays: 1 });
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    fillRing(ring, 9_000, 13_000, 8000);

    const record = await recorder.capture({
      segment: makeSegment({ startedAt: 10_000, durationMs: 2000 }),
      ring,
      ownerUserId: 'user-1',
      ruleId: 'r',
      action: 'kick',
    });

    const sweeper = new RetentionSweeper({
      store,
      evidence: config,
      storage: {
        driver: 'memory',
        databasePath: './x',
        moderationLogRetentionDays: 0,
        retentionSweepIntervalMs: 3_600_000,
      },
      logger: createNullLogger(),
      // Two days later.
      clock: () => NOW + 2 * 24 * 60 * 60 * 1000,
    });

    const result = await sweeper.sweep();

    expect(result.evidenceDeleted).toBe(1);
    expect(await store.getEvidence(record!.id)).toBeUndefined();
    await expect(readFile(record!.filePath)).rejects.toThrow();
  });

  it('leaves unexpired evidence alone', async () => {
    const { recorder, config } = makeRecorder({ retentionDays: 30 });
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    fillRing(ring, 9_000, 13_000, 8000);

    const record = await recorder.capture({
      segment: makeSegment({ startedAt: 10_000, durationMs: 2000 }),
      ring,
      ownerUserId: 'user-1',
      ruleId: 'r',
      action: 'kick',
    });

    const sweeper = new RetentionSweeper({
      store,
      evidence: config,
      storage: {
        driver: 'memory',
        databasePath: './x',
        moderationLogRetentionDays: 0,
        retentionSweepIntervalMs: 3_600_000,
      },
      logger: createNullLogger(),
      clock: () => NOW + 1000,
    });

    expect((await sweeper.sweep()).evidenceDeleted).toBe(0);
    expect(await store.getEvidence(record!.id)).toBeDefined();
  });

  it('treats an already-missing file as successfully deleted', async () => {
    const { recorder, config } = makeRecorder({ retentionDays: 0 });
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 30_000);
    fillRing(ring, 9_000, 13_000, 8000);

    const record = await recorder.capture({
      segment: makeSegment({ startedAt: 10_000, durationMs: 2000 }),
      ring,
      ownerUserId: 'user-1',
      ruleId: 'r',
      action: 'kick',
    });

    await rm(record!.filePath);

    const sweeper = new RetentionSweeper({
      store,
      evidence: config,
      storage: {
        driver: 'memory',
        databasePath: './x',
        moderationLogRetentionDays: 0,
        retentionSweepIntervalMs: 3_600_000,
      },
      logger: createNullLogger(),
      clock: () => NOW + 1000,
    });

    expect((await sweeper.sweep()).evidenceDeleted).toBe(1);
    expect(await store.getEvidence(record!.id)).toBeUndefined();
  });
});
