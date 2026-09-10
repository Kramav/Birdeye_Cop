import { msToSamples, samplesToMs } from './pcm.js';

interface RingEntry {
  /** Treated as immutable once pushed. Callers must not mutate after handing over. */
  pcm: Int16Array;
  tStart: number;
  tEnd: number;
}

/**
 * A bounded, time-indexed ring of PCM for exactly one user.
 *
 * Two properties matter here:
 *
 * 1. **It is instance-owned.** Each `UserAudioStream` constructs its own ring
 *    and never shares or pools it, so there is no code path by which one
 *    user's audio can be extracted into another user's evidence clip.
 *
 * 2. **It is gap-aware.** Discord only sends packets while someone is
 *    actually speaking, so the buffer's contents are not contiguous in wall
 *    time. Extraction is therefore keyed on timestamps and any gap is filled
 *    with real silence rather than by butting unrelated audio together — which
 *    would otherwise splice separate utterances into one misleading clip.
 */
export class TimestampedPcmRing {
  private entries: RingEntry[] = [];
  private totalSamples = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly retentionMs: number,
  ) {}

  push(pcm: Int16Array, tStart: number): void {
    if (pcm.length === 0) return;
    const tEnd = tStart + samplesToMs(pcm.length, this.sampleRate);
    this.entries.push({ pcm, tStart, tEnd });
    this.totalSamples += pcm.length;
    this.prune(tEnd);
  }

  private prune(now: number): void {
    const cutoff = now - this.retentionMs;
    let drop = 0;
    while (drop < this.entries.length && this.entries[drop].tEnd < cutoff) {
      this.totalSamples -= this.entries[drop].pcm.length;
      drop++;
    }
    if (drop > 0) this.entries.splice(0, drop);
  }

  /**
   * Return the audio covering `[fromMs, toMs)`, padding any period with no
   * captured audio with silence. The returned array is always exactly the
   * requested duration.
   */
  extract(fromMs: number, toMs: number): Int16Array {
    const outLength = Math.max(0, msToSamples(toMs - fromMs, this.sampleRate));
    const out = new Int16Array(outLength); // zero-filled == silence

    if (outLength === 0) return out;

    for (const entry of this.entries) {
      if (entry.tEnd <= fromMs || entry.tStart >= toMs) continue;

      const overlapStart = Math.max(entry.tStart, fromMs);
      const overlapEnd = Math.min(entry.tEnd, toMs);
      if (overlapEnd <= overlapStart) continue;

      const srcOffset = msToSamples(overlapStart - entry.tStart, this.sampleRate);
      const dstOffset = msToSamples(overlapStart - fromMs, this.sampleRate);
      const count = msToSamples(overlapEnd - overlapStart, this.sampleRate);

      if (dstOffset < 0 || dstOffset >= outLength) continue;

      const available = Math.min(count, entry.pcm.length - srcOffset, outLength - dstOffset);
      if (available <= 0) continue;

      out.set(entry.pcm.subarray(srcOffset, srcOffset + available), dstOffset);
    }

    return out;
  }

  /** Earliest timestamp still retained, or null when empty. */
  get earliestTimestamp(): number | null {
    return this.entries.length > 0 ? this.entries[0].tStart : null;
  }

  get latestTimestamp(): number | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1].tEnd : null;
  }

  get sampleCount(): number {
    return this.totalSamples;
  }

  get byteLength(): number {
    return this.totalSamples * 2;
  }

  clear(): void {
    this.entries = [];
    this.totalSamples = 0;
  }
}
