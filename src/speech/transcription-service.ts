import type { SttConfig } from '../config/types.js';
import { LogEvent } from '../observability/events.js';
import type { Logger } from '../observability/logger.js';
import { SttError, TimeoutError, toError } from '../utils/errors.js';
import { sleep, withTimeout } from '../utils/async.js';
import { STT_SAMPLE_RATE } from '../voice/pcm.js';
import type { AudioSegment } from '../voice/types.js';
import type { CircuitBreaker, FairQueue } from './queue.js';
import type { ISttProvider, SegmentTranscription } from './types.js';

export type TranscriptionFailureReason =
  | 'breaker-open'
  | 'dropped'
  | 'timeout'
  | 'failed'
  | 'empty';

export type TranscriptionOutcome =
  | { ok: true; transcription: SegmentTranscription }
  | { ok: false; reason: TranscriptionFailureReason; error?: Error };

export interface TranscriptionServiceOptions {
  primary: ISttProvider;
  verify: ISttProvider;
  config: SttConfig;
  queue: FairQueue;
  breaker: CircuitBreaker;
  logger: Logger;
}

export class TranscriptionService {
  constructor(private readonly opts: TranscriptionServiceOptions) {}

  /** False while the provider is considered unavailable. */
  get available(): boolean {
    return !this.opts.breaker.isOpen;
  }

  transcribe(segment: AudioSegment): Promise<TranscriptionOutcome> {
    return this.run(segment, this.opts.primary, this.opts.config.model, false);
  }

  /** Second opinion on the same audio, for a low-confidence match. */
  verify(segment: AudioSegment): Promise<TranscriptionOutcome> {
    return this.run(segment, this.opts.verify, this.opts.config.verifyModel, true);
  }

  private async run(
    segment: AudioSegment,
    provider: ISttProvider,
    model: string,
    isVerification: boolean,
  ): Promise<TranscriptionOutcome> {
    if (!this.opts.breaker.canAttempt()) {
      this.opts.logger.warn(LogEvent.STT_ERROR, {
        reason: 'breaker-open',
        segmentId: segment.segmentId,
        userId: segment.userId,
        message: 'Speech-to-text circuit is open; taking no moderation action',
      });
      return { ok: false, reason: 'breaker-open' };
    }

    this.opts.logger.debug(LogEvent.TRANSCRIPTION_STARTED, {
      segmentId: segment.segmentId,
      userId: segment.userId,
      guildId: segment.guildId,
      provider: provider.name,
      model,
      isVerification,
      durationMs: Math.round(segment.durationMs),
    });

    try {
      const result = await this.opts.queue.submit(segment.userId, (queueSignal) =>
        this.callWithRetry(provider, segment, model, queueSignal),
      );

      this.opts.breaker.recordSuccess();

      const transcription: SegmentTranscription = {
        ...result,
        // Identity is copied from the segment, never re-derived. Every
        // downstream stage re-asserts these against the segment before acting.
        segmentId: segment.segmentId,
        userId: segment.userId,
        guildId: segment.guildId,
        channelId: segment.channelId,
        isVerification,
      };

      if (transcription.text.length === 0) {
        this.opts.logger.debug(LogEvent.TRANSCRIPTION_COMPLETED, {
          segmentId: segment.segmentId,
          userId: segment.userId,
          empty: true,
          isVerification,
        });
        return { ok: false, reason: 'empty' };
      }

      this.opts.logger.info(
        isVerification ? LogEvent.TRANSCRIPTION_VERIFY : LogEvent.TRANSCRIPTION_COMPLETED,
        {
          segmentId: segment.segmentId,
          userId: segment.userId,
          guildId: segment.guildId,
          provider: transcription.provider,
          model: transcription.model,
          confidence: transcription.confidence,
          sttDurationMs: transcription.durationMs,
          // Gated centrally by the logger's transcriptLogging setting.
          transcript: transcription.text,
        },
      );

      return { ok: true, transcription };
    } catch (err) {
      const error = toError(err);

      // A drop under load is a capacity problem, not a provider failure — it
      // must not push the breaker toward tripping.
      const dropped = err instanceof SttError && !err.retryable && /queue/i.test(error.message);
      if (dropped) {
        return { ok: false, reason: 'dropped', error };
      }

      this.opts.breaker.recordFailure();

      const timedOut = err instanceof TimeoutError;
      this.opts.logger.error(LogEvent.STT_ERROR, {
        segmentId: segment.segmentId,
        userId: segment.userId,
        guildId: segment.guildId,
        provider: provider.name,
        model,
        isVerification,
        timedOut,
        err: error,
      });

      return { ok: false, reason: timedOut ? 'timeout' : 'failed', error };
    }
  }

  private async callWithRetry(
    provider: ISttProvider,
    segment: AudioSegment,
    model: string,
    queueSignal: AbortSignal,
  ): Promise<Awaited<ReturnType<ISttProvider['transcribe']>>> {
    const attempt = (): Promise<Awaited<ReturnType<ISttProvider['transcribe']>>> =>
      withTimeout(
        this.opts.config.timeoutMs,
        (signal) =>
          provider.transcribe({
            pcm: segment.pcm16k,
            sampleRate: STT_SAMPLE_RATE,
            model,
            ...(this.opts.config.language ? { language: this.opts.config.language } : {}),
            signal,
          }),
        { label: `transcription(${provider.name})`, parentSignal: queueSignal },
      );

    try {
      return await attempt();
    } catch (err) {
      const retryable = err instanceof SttError ? err.retryable : err instanceof TimeoutError;
      if (!retryable || queueSignal.aborted) throw err;

      // One retry only. A second failure is a real outage, and the breaker
      // should learn about it rather than being masked by more retries.
      this.opts.logger.debug(LogEvent.STT_ERROR, {
        segmentId: segment.segmentId,
        userId: segment.userId,
        retrying: true,
        err: toError(err),
      });

      await sleep(150 + Math.floor(Math.random() * 200), queueSignal);
      return attempt();
    }
  }
}
