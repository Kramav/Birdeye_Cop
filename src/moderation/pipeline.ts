import type { AppConfig } from '../config/types.js';
import { LogEvent } from '../observability/events.js';
import type { Logger } from '../observability/logger.js';
import { hashText } from '../observability/logger.js';
import type { TranscriptionService } from '../speech/transcription-service.js';
import type { SegmentTranscription } from '../speech/types.js';
import type { GuildSettingsService } from '../storage/settings-store.js';
import type { EvidenceRecord, ModerationEvent, ModerationStore } from '../storage/types.js';
import { IdentityMismatchError, toError } from '../utils/errors.js';
import { newEventId } from '../utils/id.js';
import type { TimestampedPcmRing } from '../voice/ring-buffer.js';
import type { AudioSegment } from '../voice/types.js';
import type { IEvidenceRecorder } from '../evidence/types.js';
import type { IModerationAction } from './actions.js';
import { contentDedupeKey, Deduplicator, segmentDedupeKey } from './dedupe.js';
import { resolveAction } from './escalation.js';
import type { IMatcher, RuleMatch, Severity } from './types.js';

export interface RingHandle {
  ring: TimestampedPcmRing;
  /** The user the ring's owning stream belongs to. Asserted before capture. */
  ownerUserId: string;
}

export interface ModerationEventContext {
  match: RuleMatch;
  priorViolations: number;
  banWithheld: boolean;
  evidence?: EvidenceRecord;
  actionSkipped?: string;
}

export interface ModerationPipelineOptions {
  /** A function, so an admin editing rules takes effect without a restart. */
  getMatcher: () => IMatcher;
  transcription: TranscriptionService;
  store: ModerationStore;
  settings: GuildSettingsService;
  evidenceRecorder: IEvidenceRecorder;
  action: IModerationAction;
  config: AppConfig;
  logger: Logger;
  clock?: () => number;
  resolveRing?: (segment: AudioSegment) => RingHandle | undefined;
  onEvent?: (event: ModerationEvent, context: ModerationEventContext) => void;
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

function mostSevere(matches: RuleMatch[]): RuleMatch {
  return matches.reduce((worst, candidate) =>
    SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[worst.severity] ? candidate : worst,
  );
}

/**
 * Turns a speech segment into a moderation decision.
 *
 * The ordering is deliberate:
 *
 *   transcribe -> assert identity -> match -> verify -> dedupe -> escalate
 *   -> capture evidence -> act -> record -> report
 *
 * Evidence is captured *before* the action because disconnecting a user tears
 * down the very stream holding their audio. And every failure mode — an
 * unavailable transcription service, a dropped queue item, a disagreeing
 * verify pass, an identity mismatch — resolves to taking no action. Being
 * wrong in the direction of inaction is recoverable; kicking the wrong person
 * is not.
 */
export class ModerationPipeline {
  private readonly dedupe: Deduplicator;
  private readonly clock: () => number;

  constructor(private readonly opts: ModerationPipelineOptions) {
    this.clock = opts.clock ?? Date.now;
    this.dedupe = new Deduplicator({
      ttlMs: opts.config.moderation.dedupeTtlMs,
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
  }

  async handleSegment(segment: AudioSegment): Promise<void> {
    try {
      await this.process(segment);
    } catch (err) {
      const error = toError(err);
      const event =
        err instanceof IdentityMismatchError ? LogEvent.IDENTITY_MISMATCH : LogEvent.MODERATION_ERROR;

      this.opts.logger.error(event, {
        segmentId: segment.segmentId,
        userId: segment.userId,
        guildId: segment.guildId,
        message: 'Segment processing failed; no moderation action was taken',
        err: error,
      });
    }
  }

  private async process(segment: AudioSegment): Promise<void> {
    const settings = await this.opts.settings.get(segment.guildId);
    if (!settings.moderationEnabled) return;

    const outcome = await this.opts.transcription.transcribe(segment);
    if (!outcome.ok) {
      // Every non-success here — breaker open, dropped under load, timeout,
      // empty — means we do not know what was said, so we do nothing.
      this.opts.logger.debug(LogEvent.MODERATION_SKIPPED, {
        segmentId: segment.segmentId,
        userId: segment.userId,
        guildId: segment.guildId,
        reason: outcome.reason,
      });
      return;
    }

    const transcription = outcome.transcription;
    this.assertIdentity(segment, transcription, 'primary-transcription');

    const matches = this.opts.getMatcher().match(transcription.text);
    if (matches.length === 0) return;

    const match = mostSevere(matches);

    this.opts.logger.info(LogEvent.MODERATION_MATCH, {
      segmentId: segment.segmentId,
      userId: segment.userId,
      guildId: segment.guildId,
      channelId: segment.channelId,
      ruleId: match.ruleId,
      severity: match.severity,
      confidence: transcription.confidence,
      rulesMatched: matches.length,
      transcript: transcription.text,
      matchedText: match.matchedText,
    });

    // Claim the segment now: one decision per run of speech, regardless of how
    // many transcripts it yields. Claiming before the verify pass also avoids
    // paying for a second transcription of a segment already being handled.
    const segmentKey = segmentDedupeKey(segment.guildId, segment.userId, segment.segmentId);
    if (!this.dedupe.claim(segmentKey)) {
      this.opts.logger.debug(LogEvent.MODERATION_DEDUPED, {
        segmentId: segment.segmentId,
        userId: segment.userId,
        reason: 'segment-already-handled',
      });
      return;
    }

    const verification = await this.verifyIfNeeded(segment, transcription, match);
    if (!verification.verified) {
      await this.recordNonAction(segment, transcription, match, verification.reason ?? 'unverified');
      return;
    }

    const transcriptHash = hashText(transcription.text);
    const contentKey = contentDedupeKey(
      segment.guildId,
      segment.userId,
      match.ruleId,
      transcriptHash,
    );
    if (!this.dedupe.claim(contentKey)) {
      this.opts.logger.debug(LogEvent.MODERATION_DEDUPED, {
        segmentId: segment.segmentId,
        userId: segment.userId,
        ruleId: match.ruleId,
        reason: 'equivalent-transcript-recently-handled',
      });
      return;
    }

    const decision = await resolveAction({
      store: this.opts.store,
      guildId: segment.guildId,
      userId: segment.userId,
      severity: match.severity,
      ...(match.action ? { ruleAction: match.action } : {}),
      ceiling: settings.actionCeiling,
      escalationEnabled: this.opts.config.moderation.escalationEnabled,
      escalationWindowHours: this.opts.config.moderation.escalationWindowHours,
      allowUnattendedBan: this.opts.config.moderation.allowUnattendedBan,
      clock: this.clock,
    });

    const evidence = await this.captureEvidence(segment, match.ruleId, decision.action, transcription);

    const reason = `Voice moderation: rule ${match.ruleId} (${match.severity})`;
    const actionOutcome = await this.opts.action.execute({
      guildId: segment.guildId,
      channelId: segment.channelId,
      userId: segment.userId,
      action: decision.action,
      reason,
      dryRun: settings.dryRun,
    });

    const event: ModerationEvent = {
      id: newEventId(),
      createdAt: this.clock(),
      guildId: segment.guildId,
      channelId: segment.channelId,
      userId: segment.userId,
      segmentId: segment.segmentId,
      ruleId: match.ruleId,
      ruleType: match.ruleType,
      severity: match.severity,
      action: decision.action,
      actionTaken: actionOutcome.executed,
      dryRun: settings.dryRun,
      confidence: transcription.confidence,
      verified: true,
      provider: transcription.provider,
      model: transcription.model,
      transcriptHash,
      ...this.transcriptFields(transcription.text, match.matchedText),
      ...(evidence ? { evidenceId: evidence.id } : {}),
      ...(actionOutcome.skipped ? { failureReason: actionOutcome.skipped } : {}),
    };

    await this.opts.store.recordEvent(event);

    this.opts.onEvent?.(event, {
      match,
      priorViolations: decision.priorViolations,
      banWithheld: decision.banWithheld,
      ...(evidence ? { evidence } : {}),
      ...(actionOutcome.skipped ? { actionSkipped: actionOutcome.skipped } : {}),
    });
  }

  /**
   * A low-confidence match gets a second opinion from a different model before
   * anything happens to the speaker.
   */
  private async verifyIfNeeded(
    segment: AudioSegment,
    transcription: SegmentTranscription,
    match: RuleMatch,
  ): Promise<{ verified: boolean; reason?: string }> {
    const threshold = this.opts.config.moderation.confidenceThreshold;

    // A null confidence means the provider gave no usable signal, which is not
    // the same as a high score — treat it as needing verification.
    const confident = transcription.confidence !== null && transcription.confidence >= threshold;
    if (confident) return { verified: true };

    const verifyOutcome = await this.opts.transcription.verify(segment);
    if (!verifyOutcome.ok) {
      return { verified: false, reason: `verify-${verifyOutcome.reason}` };
    }

    this.assertIdentity(segment, verifyOutcome.transcription, 'verify-transcription');

    const verifyMatches = this.opts.getMatcher().match(verifyOutcome.transcription.text);
    const agreed = verifyMatches.some((m) => m.ruleId === match.ruleId);

    this.opts.logger.info(LogEvent.TRANSCRIPTION_VERIFY, {
      segmentId: segment.segmentId,
      userId: segment.userId,
      ruleId: match.ruleId,
      agreed,
      primaryConfidence: transcription.confidence,
      verifyConfidence: verifyOutcome.transcription.confidence,
      verifyModel: verifyOutcome.transcription.model,
      transcript: verifyOutcome.transcription.text,
    });

    return agreed ? { verified: true } : { verified: false, reason: 'verify-disagreed' };
  }

  private async captureEvidence(
    segment: AudioSegment,
    ruleId: string,
    action: ModerationEvent['action'],
    transcription: SegmentTranscription,
  ): Promise<EvidenceRecord | undefined> {
    if (!this.opts.evidenceRecorder.enabled) return undefined;

    const handle = this.opts.resolveRing?.(segment);
    if (!handle) {
      this.opts.logger.warn(LogEvent.EVIDENCE_ERROR, {
        segmentId: segment.segmentId,
        userId: segment.userId,
        message: 'No rolling buffer available for this speaker; evidence was not captured',
      });
      return undefined;
    }

    try {
      return await this.opts.evidenceRecorder.capture({
        segment,
        ring: handle.ring,
        ownerUserId: handle.ownerUserId,
        ruleId,
        action,
        ...(this.opts.config.privacy.transcriptLogging
          ? { transcript: transcription.text }
          : {}),
      });
    } catch (err) {
      // Evidence is supporting material, not a precondition. A failed write
      // must never stop the moderation action it was documenting.
      this.opts.logger.error(LogEvent.EVIDENCE_ERROR, {
        segmentId: segment.segmentId,
        userId: segment.userId,
        guildId: segment.guildId,
        message: 'Evidence capture failed; continuing with the moderation action',
        err: toError(err),
      });
      return undefined;
    }
  }

  /** Persist a match that deliberately did not result in an action. */
  private async recordNonAction(
    segment: AudioSegment,
    transcription: SegmentTranscription,
    match: RuleMatch,
    reason: string,
  ): Promise<void> {
    this.opts.logger.info(LogEvent.MODERATION_SKIPPED, {
      segmentId: segment.segmentId,
      userId: segment.userId,
      guildId: segment.guildId,
      ruleId: match.ruleId,
      confidence: transcription.confidence,
      reason,
    });

    const event: ModerationEvent = {
      id: newEventId(),
      createdAt: this.clock(),
      guildId: segment.guildId,
      channelId: segment.channelId,
      userId: segment.userId,
      segmentId: segment.segmentId,
      ruleId: match.ruleId,
      ruleType: match.ruleType,
      severity: match.severity,
      action: 'warn',
      actionTaken: false,
      dryRun: false,
      confidence: transcription.confidence,
      verified: false,
      provider: transcription.provider,
      model: transcription.model,
      transcriptHash: hashText(transcription.text),
      ...this.transcriptFields(transcription.text, match.matchedText),
      failureReason: reason,
    };

    await this.opts.store.recordEvent(event);
  }

  private transcriptFields(
    text: string,
    matchedText: string,
  ): { transcript?: string; matchedText?: string } {
    if (!this.opts.config.privacy.transcriptLogging) return {};
    return { transcript: text, matchedText };
  }

  private assertIdentity(
    segment: AudioSegment,
    transcription: SegmentTranscription,
    stage: string,
  ): void {
    if (
      transcription.userId !== segment.userId ||
      transcription.segmentId !== segment.segmentId ||
      transcription.guildId !== segment.guildId
    ) {
      throw new IdentityMismatchError(segment.userId, transcription.userId, stage);
    }
  }
}
