import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  EventQuery,
  EvidenceQuery,
  EvidenceRecord,
  GuildSettings,
  ModerationEvent,
  ModerationStore,
} from './types.js';

/**
 * Append-only JSON-lines store.
 *
 * This exists so a failed `better-sqlite3` native build degrades the
 * deployment rather than stopping it: the bot keeps moderating and keeps
 * durable records, with linear scans instead of indexes. At moderation-event
 * volumes that difference is not observable.
 *
 * Reads are served from an in-memory index built at startup; deletes and
 * prunes rewrite the file atomically.
 */
export class JsonlModerationStore implements ModerationStore {
  private readonly dir: string;
  private readonly eventsPath: string;
  private readonly evidencePath: string;
  private readonly settingsPath: string;

  private events: ModerationEvent[] = [];
  private evidence = new Map<string, EvidenceRecord>();
  private settings = new Map<string, GuildSettings>();

  constructor(databasePath: string) {
    // Accepts the same DATABASE_PATH as the SQLite store and uses its
    // directory, so switching drivers needs no config change.
    this.dir = resolve(dirname(databasePath));
    this.eventsPath = join(this.dir, 'moderation-events.jsonl');
    this.evidencePath = join(this.dir, 'evidence.jsonl');
    this.settingsPath = join(this.dir, 'guild-settings.json');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });

    this.events = await readJsonl<ModerationEvent>(this.eventsPath);

    const evidenceRows = await readJsonl<EvidenceRecord>(this.evidencePath);
    this.evidence = new Map(evidenceRows.map((row) => [row.id, row]));

    const settingsRows = await readJson<GuildSettings[]>(this.settingsPath, []);
    this.settings = new Map(settingsRows.map((row) => [row.guildId, row]));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  async recordEvent(event: ModerationEvent): Promise<void> {
    this.events.push(event);
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
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

  async pruneEvents(olderThan: number): Promise<number> {
    const before = this.events.length;
    this.events = this.events.filter((e) => e.createdAt >= olderThan);
    const removed = before - this.events.length;
    if (removed > 0) await this.rewriteEvents();
    return removed;
  }

  async recordEvidence(record: EvidenceRecord): Promise<void> {
    this.evidence.set(record.id, record);
    await appendFile(this.evidencePath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  getEvidence(id: string): Promise<EvidenceRecord | undefined> {
    return Promise.resolve(this.evidence.get(id));
  }

  listEvidence(query: EvidenceQuery): Promise<EvidenceRecord[]> {
    let out = [...this.evidence.values()];
    if (query.guildId) out = out.filter((e) => e.guildId === query.guildId);
    if (query.userId) out = out.filter((e) => e.userId === query.userId);

    return Promise.resolve(
      out.sort((a, b) => b.createdAt - a.createdAt).slice(0, query.limit ?? 25),
    );
  }

  async deleteEvidence(id: string): Promise<EvidenceRecord | undefined> {
    const found = this.evidence.get(id);
    if (!found) return undefined;
    this.evidence.delete(id);
    await this.rewriteEvidence();
    return found;
  }

  findExpiredEvidence(now: number): Promise<EvidenceRecord[]> {
    return Promise.resolve([...this.evidence.values()].filter((e) => e.expiresAt <= now));
  }

  getGuildSettings(guildId: string): Promise<GuildSettings | undefined> {
    return Promise.resolve(this.settings.get(guildId));
  }

  async setGuildSettings(
    guildId: string,
    patch: Partial<Omit<GuildSettings, 'guildId' | 'updatedAt'>>,
  ): Promise<GuildSettings> {
    const existing = this.settings.get(guildId) ?? { guildId, updatedAt: 0 };
    const next: GuildSettings = { ...existing, ...patch, guildId, updatedAt: Date.now() };
    this.settings.set(guildId, next);
    await atomicWrite(this.settingsPath, JSON.stringify([...this.settings.values()], null, 2));
    return next;
  }

  private async rewriteEvents(): Promise<void> {
    await atomicWrite(
      this.eventsPath,
      this.events.map((e) => JSON.stringify(e)).join('\n') + (this.events.length ? '\n' : ''),
    );
  }

  private async rewriteEvidence(): Promise<void> {
    const rows = [...this.evidence.values()];
    await atomicWrite(
      this.evidencePath,
      rows.map((e) => JSON.stringify(e)).join('\n') + (rows.length ? '\n' : ''),
    );
  }
}

async function readJsonl<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const out: T[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A torn final line from an interrupted append is expected; skipping it
      // is strictly better than refusing to start.
    }
  }
  return out;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}
