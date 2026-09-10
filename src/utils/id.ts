import { randomUUID } from 'node:crypto';

/**
 * Canonical UUID v4 form, lowercase hex only.
 *
 * Evidence IDs become filesystem paths, so this pattern is the first of two
 * defences against path traversal (the second is resolved-path containment in
 * `evidence/paths.ts`). It deliberately rejects uppercase, braces, and URNs
 * rather than normalizing them — anything that is not exactly what we
 * generated is treated as hostile.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newEvidenceId(): string {
  return randomUUID();
}

export function newSegmentId(): string {
  return randomUUID();
}

export function newEventId(): string {
  return randomUUID();
}

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

/**
 * Key used for all per-user state. Centralized so no call site can invent a
 * different shape and accidentally collide two users' streams.
 */
export function userKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}
