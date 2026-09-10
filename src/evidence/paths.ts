import { isAbsolute, resolve, sep } from 'node:path';
import { UnsafePathError } from '../utils/errors.js';
import { isValidUuid } from '../utils/id.js';

/**
 * Exactly the filenames this module generates, and nothing else.
 *
 * Evidence IDs arrive from Discord command arguments, so they are untrusted
 * input that ends up in a filesystem path. Rather than trying to sanitize
 * hostile input, both the ID and the assembled filename must match a strict
 * generated shape — anything else is rejected outright.
 */
const EVIDENCE_FILENAME =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.wav$/;

/** `2026-09-09T18:42:31.123Z` -> `2026-09-09T18-42-31Z` */
export function timestampSlug(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

export function evidenceFilename(evidenceId: string, createdAt: Date): string {
  assertSafeEvidenceId(evidenceId);
  return `${timestampSlug(createdAt)}_${evidenceId}.wav`;
}

/** Throws unless `id` is a canonical lowercase UUID v4. */
export function assertSafeEvidenceId(id: unknown): string {
  if (!isValidUuid(id)) {
    throw new UnsafePathError(
      `Evidence ID is not a valid identifier: ${JSON.stringify(String(id)).slice(0, 120)}`,
    );
  }
  return id;
}

/**
 * Resolve a filename inside the evidence directory.
 *
 * Two independent checks, deliberately redundant: the filename must match the
 * generated pattern (so it cannot contain separators, `..`, or a drive
 * letter), and the resolved path must still sit under the evidence directory
 * after normalization.
 */
export function resolveEvidencePath(directory: string, filename: string): string {
  if (!EVIDENCE_FILENAME.test(filename)) {
    throw new UnsafePathError(
      `Refusing to resolve an evidence filename that does not match the expected format: ${JSON.stringify(
        filename,
      ).slice(0, 120)}`,
    );
  }
  return assertWithinDirectory(directory, resolve(directory, filename));
}

/** Throws unless `candidate` resolves to a location inside `directory`. */
export function assertWithinDirectory(directory: string, candidate: string): string {
  const root = resolve(directory);
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);

  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new UnsafePathError(
      `Refusing to access a path outside the evidence directory: ${JSON.stringify(candidate).slice(0, 200)}`,
    );
  }
  return target;
}

export const __testing = { EVIDENCE_FILENAME };
