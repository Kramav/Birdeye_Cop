import { unlink } from 'node:fs/promises';
import type { EvidenceConfig, StorageConfig } from '../config/types.js';
import { LogEvent } from '../observability/events.js';
import type { Logger } from '../observability/logger.js';
import type { EvidenceRecord, ModerationStore } from '../storage/types.js';
import { toError } from '../utils/errors.js';
import { assertSafeEvidenceId, assertWithinDirectory } from './paths.js';

export interface RetentionSweeperOptions {
  store: ModerationStore;
  evidence: EvidenceConfig;
  storage: StorageConfig;
  logger: Logger;
  clock?: () => number;
}

/**
 * Deletes evidence and moderation records once their retention window closes.
 *
 * Retention is enforced by the application rather than left to an operator's
 * cron job, because "we delete recordings after N days" is a claim made to the
 * people being recorded.
 */
export class RetentionSweeper {
  private timer: NodeJS.Timeout | undefined;
  private readonly clock: () => number;
  private running = false;

  constructor(private readonly opts: RetentionSweeperOptions) {
    this.clock = opts.clock ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        this.opts.logger.error(LogEvent.EVIDENCE_ERROR, {
          message: 'Retention sweep failed',
          err: toError(err),
        });
      });
    }, this.opts.storage.retentionSweepIntervalMs);

    // Retention must not be the reason the process refuses to exit.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async sweep(): Promise<{ evidenceDeleted: number; eventsPruned: number }> {
    // Overlapping sweeps would race on the same rows and files.
    if (this.running) return { evidenceDeleted: 0, eventsPruned: 0 };
    this.running = true;

    try {
      const now = this.clock();
      let evidenceDeleted = 0;

      const expired = await this.opts.store.findExpiredEvidence(now);
      for (const record of expired) {
        if (await this.deleteRecordFile(record)) evidenceDeleted++;
      }

      let eventsPruned = 0;
      if (this.opts.storage.moderationLogRetentionDays > 0) {
        const cutoff = now - this.opts.storage.moderationLogRetentionDays * 24 * 60 * 60 * 1000;
        eventsPruned = await this.opts.store.pruneEvents(cutoff);
      }

      if (evidenceDeleted > 0 || eventsPruned > 0) {
        this.opts.logger.info(LogEvent.EVIDENCE_PRUNED, { evidenceDeleted, eventsPruned });
      }

      return { evidenceDeleted, eventsPruned };
    } finally {
      this.running = false;
    }
  }

  /** Remove one record's file and row. Used by the sweeper and by admin deletes. */
  async deleteRecordFile(record: EvidenceRecord): Promise<boolean> {
    try {
      // Re-validate on the way out: a record could have been written by an
      // older version, or tampered with in the database.
      assertSafeEvidenceId(record.id);
      const path = assertWithinDirectory(this.opts.evidence.directory, record.filePath);

      try {
        await unlink(path);
      } catch (err) {
        // A missing file is fine — the goal is that it no longer exists.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      await this.opts.store.deleteEvidence(record.id);
      return true;
    } catch (err) {
      this.opts.logger.error(LogEvent.EVIDENCE_ERROR, {
        message: 'Failed to delete expired evidence',
        evidenceId: record.id,
        err: toError(err),
      });
      return false;
    }
  }
}
