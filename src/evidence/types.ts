import type { ModerationActionType } from '../moderation/types.js';
import type { AudioSegment } from '../voice/types.js';
import type { TimestampedPcmRing } from '../voice/ring-buffer.js';
import type { EvidenceRecord } from '../storage/types.js';

export interface EvidenceCaptureRequest {
  segment: AudioSegment;
  /**
   * The ring owned by the `UserAudioStream` that produced this segment.
   *
   * `ownerUserId` is that stream's user, carried separately so the recorder
   * can assert it equals `segment.userId` before writing anything. Without
   * that assertion, a bug in stream lookup could attach one speaker's audio to
   * another speaker's violation.
   */
  ring: TimestampedPcmRing;
  ownerUserId: string;
  ruleId: string;
  action: ModerationActionType;
  /** Only supplied when transcript logging is enabled. */
  transcript?: string;
}

/** Swappable evidence capture, so recording can be replaced or disabled. */
export interface IEvidenceRecorder {
  readonly enabled: boolean;
  capture(request: EvidenceCaptureRequest): Promise<EvidenceRecord | undefined>;
}
