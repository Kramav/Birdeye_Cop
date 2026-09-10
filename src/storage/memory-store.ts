import type {
  EventQuery,
  EvidenceQuery,
  EvidenceRecord,
  GuildSettings,
  ModerationEvent,
  ModerationStore,
} from './types.js';

/** In-memory store. Used by tests and by `STORAGE_DRIVER=memory`. */
export class MemoryModerationStore implements ModerationStore {
  private events: ModerationEvent[] = [];
  private evidence = new Map<string, EvidenceRecord>();
  private settings = new Map<string, GuildSettings>();

  init(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  recordEvent(event: ModerationEvent): Promise<void> {
    this.events.push({ ...event });
    return Promise.resolve();
  }

  listEvents(query: EventQuery): Promise<ModerationEvent[]> {
    let out = this.events;
    if (query.guildId) out = out.filter((e) => e.guildId === query.guildId);
    if (query.userId) out = out.filter((e) => e.userId === query.userId);
    if (query.since !== undefined) out = out.filter((e) => e.createdAt >= query.since!);

    return Promise.resolve(
      [...out].sort((a, b) => b.createdAt - a.createdAt).slice(0, query.limit ?? 50),
    );
  }

  countViolations(guildId: string, userId: string, since: number): Promise<number> {
    return Promise.resolve(
      this.events.filter(
        (e) => e.guildId === guildId && e.userId === userId && e.createdAt >= since,
      ).length,
    );
  }

  pruneEvents(olderThan: number): Promise<number> {
    const before = this.events.length;
    this.events = this.events.filter((e) => e.createdAt >= olderThan);
    return Promise.resolve(before - this.events.length);
  }

  recordEvidence(record: EvidenceRecord): Promise<void> {
    this.evidence.set(record.id, { ...record });
    return Promise.resolve();
  }

  getEvidence(id: string): Promise<EvidenceRecord | undefined> {
    const found = this.evidence.get(id);
    return Promise.resolve(found ? { ...found } : undefined);
  }

  listEvidence(query: EvidenceQuery): Promise<EvidenceRecord[]> {
    let out = [...this.evidence.values()];
    if (query.guildId) out = out.filter((e) => e.guildId === query.guildId);
    if (query.userId) out = out.filter((e) => e.userId === query.userId);

    return Promise.resolve(
      out.sort((a, b) => b.createdAt - a.createdAt).slice(0, query.limit ?? 25),
    );
  }

  deleteEvidence(id: string): Promise<EvidenceRecord | undefined> {
    const found = this.evidence.get(id);
    if (found) this.evidence.delete(id);
    return Promise.resolve(found);
  }

  findExpiredEvidence(now: number): Promise<EvidenceRecord[]> {
    return Promise.resolve([...this.evidence.values()].filter((e) => e.expiresAt <= now));
  }

  getGuildSettings(guildId: string): Promise<GuildSettings | undefined> {
    const found = this.settings.get(guildId);
    return Promise.resolve(found ? { ...found } : undefined);
  }

  setGuildSettings(
    guildId: string,
    patch: Partial<Omit<GuildSettings, 'guildId' | 'updatedAt'>>,
  ): Promise<GuildSettings> {
    const existing = this.settings.get(guildId) ?? { guildId, updatedAt: 0 };
    const next: GuildSettings = { ...existing, ...patch, guildId, updatedAt: Date.now() };
    this.settings.set(guildId, next);
    return Promise.resolve({ ...next });
  }
}
