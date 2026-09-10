import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EvidenceConfig } from '../config/types.js';
import { LogEvent } from '../observability/events.js';
import type { Logger } from '../observability/logger.js';
import type { EvidenceRecord, ModerationStore } from '../storage/types.js';
import { EvidenceError, IdentityMismatchError } from '../utils/errors.js';
import { sleep } from '../utils/async.js';
import { newEvidenceId } from '../utils/id.js';
import { DISCORD_SAMPLE_RATE, encodeWav, samplesToMs } from '../voice/pcm.js';
import { evidenceFilename, resolveEvidencePath } from './paths.js';
import type { EvidenceCaptureRequest, IEvidenceRecorder } from './types.js';

export interface EvidenceRecorderOptions {
  config: EvidenceConfig;
  store: ModerationStore;
  logger: Logger;
  clock?: () => number;
}

/** No-op recorder used whenever violation-audio logging is disabled. */
export class DisabledEvidenceRecorder implements IEvidenceRecorder {
  readonly enabled = false;
  capture(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

/**
 * Persists the specific speech that triggered a moderation action.
 *
 * Audio is only ever written to disk here, and only when a violation actually
 * occurred — the rolling buffer it draws from stays in memory. Nothing in the
 * normal path of a conversation reaches the filesystem.
 */
export class EvidenceRecorder implements IEvidenceRecorder {
  readonly enabled = true;
  private readonly clock: () => number;
  private directoryReady = false;

  constructor(private readonly opts: EvidenceRecorderOptions) {
    this.clock = opts.clock ?? Date.now;
  }

  async capture(request: EvidenceCaptureRequest): Promise<EvidenceRecord | undefined> {
    const { segment, ring, ownerUserId } = request;

    // The ring belongs to exactly one speaker. If the stream we were handed
    // does not belong to the speaker this segment came from, something has
    // gone badly wrong upstream and writing the clip would attribute one
    // person's voice to another's violation. Refuse rather than guess.
    if (ownerUserId !== segment.userId) {
      throw new IdentityMismatchError(segment.userId, ownerUserId, 'evidence-capture');
    }

    const { config } = this.opts;

    // Waiting lets genuine trailing audio arrive before extraction. When the
    // operator has not opted into delaying the action, we extract now and the
    // post-roll is silence-padded, because a disconnected user stops
    // transmitting immediately.
    if (config.delayAction && config.postbufferMs > 0) {
      await sleep(config.postbufferMs);
    }

    const from = segment.startedAt - config.prebufferMs;
    const to = segment.endedAt + config.postbufferMs;

    // `extract` always returns the requested duration, padding with silence.
    // That is right for a missing tail, but if the buffer holds nothing from
    // this period at all, we would write an entirely silent file and label it
    // evidence. Refuse instead — the moderation action still proceeds.
    const earliest = ring.earliestTimestamp;
    const latest = ring.latestTimestamp;
    if (earliest === null || latest === null || latest <= from || earliest >= to) {
      throw new EvidenceError(
        'Rolling buffer holds no audio overlapping the violation window; ' +
          'refusing to write a silent evidence file',
      );
    }

    const pcm = ring.extract(from, to);
    if (pcm.length === 0) {
      throw new EvidenceError('Rolling buffer yielded no audio for the violation window');
    }

    const createdAt = new Date(this.clock());
    const id = newEvidenceId();
    const filename = evidenceFilename(id, createdAt);

    await this.ensureDirectory();
    const filePath = resolveEvidencePath(config.directory, filename);

    const wav = encodeWav(pcm, DISCORD_SAMPLE_RATE);

    // `wx` fails rather than overwriting: an existing file at a generated UUID
    // path means something is wrong, and clobbering evidence is unacceptable.
    await writeFile(filePath, wav, { flag: 'wx', mode: 0o600 });

    const record: EvidenceRecord = {
      id,
      createdAt: createdAt.getTime(),
      expiresAt: createdAt.getTime() + config.retentionDays * 24 * 60 * 60 * 1000,
      guildId: segment.guildId,
      channelId: segment.channelId,
      userId: segment.userId,
      segmentId: segment.segmentId,
      ruleId: request.ruleId,
      action: request.action,
      filename,
      filePath,
      durationMs: Math.round(samplesToMs(pcm.length, DISCORD_SAMPLE_RATE)),
      byteSize: wav.length,
      ...(request.transcript !== undefined ? { transcript: request.transcript } : {}),
    };

    await this.opts.store.recordEvidence(record);

    this.opts.logger.info(LogEvent.EVIDENCE_SAVED, {
      evidenceId: id,
      userId: segment.userId,
      guildId: segment.guildId,
      channelId: segment.channelId,
      ruleId: request.ruleId,
      durationMs: record.durationMs,
      byteSize: record.byteSize,
      // Deliberately not the path's contents, and never the audio itself.
      filename,
    });

    return record;
  }

  private async ensureDirectory(): Promise<void> {
    if (this.directoryReady) return;
    await mkdir(resolve(this.opts.config.directory), { recursive: true, mode: 0o700 });
    this.directoryReady = true;
  }
}
