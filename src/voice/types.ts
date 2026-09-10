/**
 * One contiguous run of speech from exactly one Discord user.
 *
 * `userId` is stamped once, at construction, from the receive subscription it
 * came from, and is never re-derived anywhere downstream. Every stage that
 * handles a segment re-asserts this value rather than looking the user up
 * again — that assertion is the backbone of correct attribution.
 */
export interface AudioSegment {
  segmentId: string;
  userId: string;
  guildId: string;
  channelId: string;
  /** Epoch ms of the first speech sample, after silence trimming. */
  startedAt: number;
  /** Epoch ms just past the last speech sample. */
  endedAt: number;
  durationMs: number;
  /** 16 kHz mono PCM, ready for a speech-to-text provider. */
  pcm16k: Int16Array;
  peakRms: number;
  /** Why the segment was closed. Diagnostics only. */
  reason: SegmentEndReason;
}

export type SegmentEndReason = 'silence' | 'max-duration' | 'teardown' | 'coalesce-expired';

export interface SpeechAnalysis {
  isSpeech: boolean;
  /** Trimmed bounds within the analyzed buffer. */
  startSample: number;
  endSample: number;
  peakRms: number;
}

/** Swappable voice-activity detection. */
export interface ISpeechDetector {
  analyze(pcm48kMono: Int16Array): SpeechAnalysis;
  /**
   * Whether the trailing `windowMs` of audio looks like silence.
   *
   * Drives the coalescing decision: a stream that ended while the speaker was
   * still producing energy was probably cut short by the library, not by the
   * speaker finishing a sentence.
   */
  isTailSilent(pcm48kMono: Int16Array, windowMs: number): boolean;
}

export type SegmentHandler = (segment: AudioSegment) => void;

/** Swappable audio source, so the Discord implementation can be replaced. */
export interface IAudioReceiver {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface VoiceUserContext {
  guildId: string;
  channelId: string;
  userId: string;
}
