import { describe, expect, it } from 'vitest';
import { TimestampedPcmRing } from '../../src/voice/ring-buffer.js';
import { DISCORD_SAMPLE_RATE, msToSamples, rms } from '../../src/voice/pcm.js';

/** Constant-amplitude PCM, so presence/absence is trivially checkable. */
function block(ms: number, value: number): Int16Array {
  const pcm = new Int16Array(msToSamples(ms, DISCORD_SAMPLE_RATE));
  pcm.fill(value);
  return pcm;
}

describe('TimestampedPcmRing', () => {
  it('extracts exactly the requested duration', () => {
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 5000);
    ring.push(block(1000, 8000), 10_000);

    const out = ring.extract(10_000, 10_500);
    expect(out.length).toBe(msToSamples(500, DISCORD_SAMPLE_RATE));
  });

  it('returns the audio that overlaps the window', () => {
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 5000);
    ring.push(block(1000, 8000), 10_000);

    const out = ring.extract(10_200, 10_400);
    expect(out.every((s) => s === 8000)).toBe(true);
  });

  it('pads periods with no captured audio with silence rather than splicing', () => {
    // Discord only sends packets while a user speaks, so the ring is not
    // contiguous in wall time. Butting two utterances together would
    // fabricate speech that never happened.
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 10_000);
    ring.push(block(200, 8000), 1000); // 1000..1200
    ring.push(block(200, 8000), 2000); // 2000..2200

    const out = ring.extract(1000, 2200);
    expect(out.length).toBe(msToSamples(1200, DISCORD_SAMPLE_RATE));

    const gapStart = msToSamples(200, DISCORD_SAMPLE_RATE);
    const gapEnd = msToSamples(1000, DISCORD_SAMPLE_RATE);
    expect(rms(out, gapStart, gapEnd)).toBe(0);
    expect(rms(out, 0, gapStart)).toBeGreaterThan(0);
    expect(rms(out, gapEnd, out.length)).toBeGreaterThan(0);
  });

  it('returns pure silence for a window with no audio at all', () => {
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 10_000);
    ring.push(block(100, 8000), 5000);

    const out = ring.extract(1000, 1500);
    expect(out.length).toBe(msToSamples(500, DISCORD_SAMPLE_RATE));
    expect(rms(out)).toBe(0);
  });

  it('captures pre-roll that preceded the window of interest', () => {
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 10_000);
    ring.push(block(1000, 6000), 1000); // speech from 1000..2000

    // A violation detected at 1500 wants 500ms of pre-roll.
    const out = ring.extract(1000, 1500);
    expect(rms(out)).toBeGreaterThan(0);
  });

  it('drops entries older than the retention window', () => {
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 1000);
    ring.push(block(200, 8000), 1000);
    expect(ring.sampleCount).toBe(msToSamples(200, DISCORD_SAMPLE_RATE));

    // Pushing far in the future must evict the stale entry.
    ring.push(block(200, 8000), 10_000);
    expect(ring.sampleCount).toBe(msToSamples(200, DISCORD_SAMPLE_RATE));
    expect(ring.earliestTimestamp).toBe(10_000);
  });

  it('bounds memory under continuous input', () => {
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 2000);
    for (let t = 0; t < 60_000; t += 20) {
      ring.push(block(20, 4000), t);
    }
    // ~2s of 48kHz 16-bit mono, plus at most one partial chunk.
    expect(ring.byteLength).toBeLessThanOrEqual(2100 * 48 * 2);
  });

  it('reports empty timestamps before any input and after clear', () => {
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 1000);
    expect(ring.earliestTimestamp).toBeNull();

    ring.push(block(100, 1000), 500);
    expect(ring.earliestTimestamp).toBe(500);

    ring.clear();
    expect(ring.earliestTimestamp).toBeNull();
    expect(ring.sampleCount).toBe(0);
  });

  it('ignores empty pushes', () => {
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 1000);
    ring.push(new Int16Array(0), 100);
    expect(ring.sampleCount).toBe(0);
  });
});
