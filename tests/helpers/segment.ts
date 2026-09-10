import { newSegmentId } from '../../src/utils/id.js';
import { STT_SAMPLE_RATE } from '../../src/voice/pcm.js';
import type { AudioSegment } from '../../src/voice/types.js';

export function makeSegment(overrides: Partial<AudioSegment> = {}): AudioSegment {
  const startedAt = overrides.startedAt ?? 1_000_000;
  const durationMs = overrides.durationMs ?? 1000;

  return {
    segmentId: newSegmentId(),
    userId: 'user-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    startedAt,
    endedAt: startedAt + durationMs,
    durationMs,
    pcm16k: new Int16Array((STT_SAMPLE_RATE * durationMs) / 1000),
    peakRms: 0.4,
    reason: 'silence',
    ...overrides,
  };
}
