export interface DeduplicatorOptions {
  ttlMs: number;
  maxEntries?: number;
  clock?: () => number;
}

/**
 * Time-bounded "have I already handled this?" set.
 *
 * Used at two levels by the pipeline:
 *
 *   - **Per segment** — one action per run of speech, no matter how many
 *     transcriptions it produces. The verify pass alone means a single segment
 *     routinely yields two transcripts that match the same rule.
 *   - **Per content** — catches the same words matching again across
 *     coalesced or overlapping segments within a short window.
 */
export class Deduplicator {
  private readonly seen = new Map<string, number>();
  private readonly clock: () => number;
  private readonly maxEntries: number;

  constructor(private readonly opts: DeduplicatorOptions) {
    this.clock = opts.clock ?? Date.now;
    this.maxEntries = opts.maxEntries ?? 5000;
  }

  /**
   * Record `key` and report whether it was new.
   *
   * Returns true exactly once per key per TTL window, so callers can treat a
   * true result as permission to act.
   */
  claim(key: string): boolean {
    const now = this.clock();
    this.expire(now);

    const previous = this.seen.get(key);
    if (previous !== undefined && now - previous < this.opts.ttlMs) {
      return false;
    }

    this.seen.set(key, now);
    this.enforceBound();
    return true;
  }

  has(key: string): boolean {
    const previous = this.seen.get(key);
    return previous !== undefined && this.clock() - previous < this.opts.ttlMs;
  }

  private expire(now: number): void {
    if (this.opts.ttlMs <= 0) {
      this.seen.clear();
      return;
    }
    for (const [key, at] of this.seen) {
      if (now - at >= this.opts.ttlMs) this.seen.delete(key);
    }
  }

  private enforceBound(): void {
    // Map iteration is insertion-ordered, so this evicts the oldest first.
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }

  get size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }
}

export function segmentDedupeKey(guildId: string, userId: string, segmentId: string): string {
  return `seg:${guildId}:${userId}:${segmentId}`;
}

export function contentDedupeKey(
  guildId: string,
  userId: string,
  ruleId: string,
  transcriptHash: string,
): string {
  return `txt:${guildId}:${userId}:${ruleId}:${transcriptHash}`;
}
