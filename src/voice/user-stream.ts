import type { VoiceConfig } from '../config/types.js';
import { LogEvent } from '../observability/events.js';
import type { Logger } from '../observability/logger.js';
import { newSegmentId } from '../utils/id.js';
import { toError } from '../utils/errors.js';
import {
  DISCORD_SAMPLE_RATE,
  bufferToInt16,
  concatInt16,
  resample48kTo16k,
  samplesToMs,
  stereoToMono,
} from './pcm.js';
import type { TimestampedPcmRing } from './ring-buffer.js';
import type { AudioSegment, ISpeechDetector, SegmentEndReason, SegmentHandler } from './types.js';

/** Window inspected to decide whether a stream ended naturally or was cut short. */
const TAIL_WINDOW_MS = 150;

export interface UserAudioStreamOptions {
  guildId: string;
  channelId: string;
  userId: string;
  detector: ISpeechDetector;
  config: VoiceConfig;
  onSegment: SegmentHandler;
  logger: Logger;
  /** Present only when violation-audio logging is enabled. */
  ring?: TimestampedPcmRing;
  clock?: () => number;
}

/**
 * Accumulates one user's audio and emits discrete speech segments.
 *
 * Deliberately not a Node stream: it is a plain object driven by explicit
 * calls, which makes every timing rule here directly unit-testable without
 * constructing a pipeline.
 *
 * The instance is bound to a single `userId` for its whole lifetime. Every
 * segment it emits carries that ID, copied from this object rather than
 * looked up from Discord state at emit time — so a user leaving, moving, or
 * being replaced by a new speaker mid-flush cannot change who a segment is
 * attributed to.
 */
export class UserAudioStream {
  private chunks: Int16Array[] = [];
  private accumulatedSamples = 0;
  private segmentStartedAt: number | null = null;
  private coalesceTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private readonly clock: () => number;

  /** Wall-clock of the most recent audio, for idle reaping and liveness. */
  lastActivityAt: number;

  constructor(private readonly opts: UserAudioStreamOptions) {
    this.clock = opts.clock ?? Date.now;
    this.lastActivityAt = this.clock();
  }

  get userId(): string {
    return this.opts.userId;
  }

  get guildId(): string {
    return this.opts.guildId;
  }

  get channelId(): string {
    return this.opts.channelId;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  get hasPendingAudio(): boolean {
    return this.chunks.length > 0;
  }

  /** Bytes currently held for this user, including the evidence ring. */
  get memoryBytes(): number {
    return this.accumulatedSamples * 2 + (this.opts.ring?.byteLength ?? 0);
  }

  /**
   * Feed one decoded chunk. Input is 48 kHz, 16-bit, interleaved stereo —
   * exactly what `prism.opus.Decoder` produces for Discord voice.
   */
  appendPcm(stereoChunk: Buffer): void {
    if (this.destroyed || stereoChunk.length === 0) return;

    const mono = stereoToMono(bufferToInt16(stereoChunk));
    if (mono.length === 0) return;

    const now = this.clock();
    this.lastActivityAt = now;

    // Audio arriving means any pending coalesce decision is moot: this is a
    // continuation of the same utterance, not a new one.
    this.clearCoalesceTimer();

    if (this.segmentStartedAt === null) {
      this.segmentStartedAt = now;
    }

    // The evidence ring is fed independently of segment boundaries so that
    // pre-roll exists for audio that preceded the segment we end up flagging.
    this.opts.ring?.push(mono, now);

    this.chunks.push(mono);
    this.accumulatedSamples += mono.length;

    if (samplesToMs(this.accumulatedSamples, DISCORD_SAMPLE_RATE) >= this.opts.config.maxSegmentMs) {
      this.flush('max-duration');
    }
  }

  /**
   * Called when a receive subscription ends.
   *
   * `EndBehaviorType.AfterSilence` is known to fire while a user is still
   * talking (discordjs/discord.js#8105). Rather than pay a coalescing delay on
   * every utterance, inspect the tail: audio that ended quietly really did end,
   * and can be flushed immediately. Only an energetic tail — the signature of
   * a premature cut — waits for a possible continuation.
   */
  markSubscriptionEnd(): void {
    if (this.destroyed || this.chunks.length === 0) return;

    const coalesceMs = this.opts.config.segmentCoalesceMs;
    if (coalesceMs <= 0) {
      this.flush('silence');
      return;
    }

    const tail = this.tailSamples(TAIL_WINDOW_MS);
    if (this.opts.detector.isTailSilent(tail, TAIL_WINDOW_MS)) {
      this.flush('silence');
      return;
    }

    this.startCoalesceTimer(coalesceMs);
  }

  /** Release everything. Any buffered speech is flushed first by default. */
  destroy(opts: { flush?: boolean } = {}): void {
    if (this.destroyed) return;
    const shouldFlush = opts.flush ?? true;

    this.clearCoalesceTimer();
    if (shouldFlush && this.chunks.length > 0) {
      this.flush('teardown');
    }

    this.destroyed = true;
    this.chunks = [];
    this.accumulatedSamples = 0;
    this.segmentStartedAt = null;
    this.opts.ring?.clear();
  }

  // -- internals ---------------------------------------------------------

  private startCoalesceTimer(ms: number): void {
    this.clearCoalesceTimer();
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      if (!this.destroyed) this.flush('coalesce-expired');
    }, ms);
    // Never hold the process open for a coalescing window.
    this.coalesceTimer.unref?.();
  }

  private clearCoalesceTimer(): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
  }

  /** Last `ms` of buffered audio, walking chunks backwards without a full concat. */
  private tailSamples(ms: number): Int16Array {
    const wanted = Math.round((ms * DISCORD_SAMPLE_RATE) / 1000);
    const collected: Int16Array[] = [];
    let have = 0;

    for (let i = this.chunks.length - 1; i >= 0 && have < wanted; i--) {
      const chunk = this.chunks[i];
      const need = wanted - have;
      if (chunk.length <= need) {
        collected.unshift(chunk);
        have += chunk.length;
      } else {
        collected.unshift(chunk.subarray(chunk.length - need));
        have += need;
      }
    }

    return collected.length === 1 ? collected[0] : concatInt16(collected);
  }

  private flush(reason: SegmentEndReason): void {
    this.clearCoalesceTimer();

    const startedAt = this.segmentStartedAt;
    if (this.chunks.length === 0 || startedAt === null) {
      this.resetAccumulator();
      return;
    }

    const mono48k = concatInt16(this.chunks);
    // Reset before emitting so a handler that synchronously feeds more audio
    // cannot see or duplicate the segment we are in the middle of emitting.
    this.resetAccumulator();

    const analysis = this.opts.detector.analyze(mono48k);
    if (!analysis.isSpeech) {
      this.opts.logger.debug(LogEvent.VOICE_SEGMENT_DISCARDED, {
        userId: this.opts.userId,
        guildId: this.opts.guildId,
        reason: 'no-speech-detected',
        durationMs: Math.round(samplesToMs(mono48k.length, DISCORD_SAMPLE_RATE)),
        peakRms: Number(analysis.peakRms.toFixed(4)),
      });
      return;
    }

    const trimmed = mono48k.subarray(analysis.startSample, analysis.endSample);
    const leadingSilenceMs = samplesToMs(analysis.startSample, DISCORD_SAMPLE_RATE);
    const durationMs = samplesToMs(trimmed.length, DISCORD_SAMPLE_RATE);

    if (durationMs < this.opts.config.minSpeechMs) {
      this.opts.logger.debug(LogEvent.VOICE_SEGMENT_DISCARDED, {
        userId: this.opts.userId,
        guildId: this.opts.guildId,
        reason: 'too-short',
        durationMs: Math.round(durationMs),
      });
      return;
    }

    const segmentStart = startedAt + leadingSilenceMs;

    const segment: AudioSegment = {
      segmentId: newSegmentId(),
      // Copied from this instance, never re-derived from Discord state.
      userId: this.opts.userId,
      guildId: this.opts.guildId,
      channelId: this.opts.channelId,
      startedAt: segmentStart,
      endedAt: segmentStart + durationMs,
      durationMs,
      pcm16k: resample48kTo16k(trimmed),
      peakRms: analysis.peakRms,
      reason,
    };

    this.opts.logger.debug(LogEvent.VOICE_SEGMENT_READY, {
      userId: segment.userId,
      guildId: segment.guildId,
      channelId: segment.channelId,
      segmentId: segment.segmentId,
      durationMs: Math.round(segment.durationMs),
      reason,
    });

    try {
      this.opts.onSegment(segment);
    } catch (err) {
      // A downstream failure must never break audio capture for this user.
      this.opts.logger.error(LogEvent.MODERATION_ERROR, {
        userId: segment.userId,
        segmentId: segment.segmentId,
        err: toError(err),
      });
    }
  }

  private resetAccumulator(): void {
    this.chunks = [];
    this.accumulatedSamples = 0;
    this.segmentStartedAt = null;
  }
}
