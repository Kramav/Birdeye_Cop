export interface TranscriptionRequest {
  /** 16-bit mono PCM. */
  pcm: Int16Array;
  sampleRate: number;
  model?: string;
  language?: string;
  /** Aborts on timeout, shutdown, or the speaker's stream being torn down. */
  signal: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  /**
   * 0..1, or null when the provider gives no usable signal.
   *
   * Null is meaningfully different from 0: it means "unknown", and the
   * pipeline treats it as low confidence so it routes through the verify pass
   * rather than acting on an unverifiable transcript.
   */
  confidence: number | null;
  provider: string;
  model: string;
  /** Wall-clock time the provider call took. */
  durationMs: number;
}

/** Swappable speech-to-text backend. */
export interface ISttProvider {
  readonly name: string;
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult>;
}

/**
 * A transcription bound to the segment and speaker it came from.
 *
 * The identity fields are copied from the segment, never looked up again, and
 * are re-asserted against the segment before any moderation action.
 */
export interface SegmentTranscription extends TranscriptionResult {
  segmentId: string;
  userId: string;
  guildId: string;
  channelId: string;
  /** True when this came from the second-opinion verify pass. */
  isVerification: boolean;
}
