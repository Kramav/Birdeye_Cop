import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  assertSafeEvidenceId,
  assertWithinDirectory,
  evidenceFilename,
  resolveEvidencePath,
  timestampSlug,
} from '../../src/evidence/paths.js';
import { UnsafePathError } from '../../src/utils/errors.js';
import { newEvidenceId } from '../../src/utils/id.js';

const VALID_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const DIR = './violation-audio';

describe('assertSafeEvidenceId', () => {
  it('accepts a generated ID', () => {
    expect(() => assertSafeEvidenceId(newEvidenceId())).not.toThrow();
    expect(assertSafeEvidenceId(VALID_ID)).toBe(VALID_ID);
  });

  it.each([
    ['path traversal', '../../etc/passwd'],
    ['traversal disguised as a suffix', `${VALID_ID}/../../secret`],
    ['absolute posix path', '/etc/passwd'],
    ['absolute windows path', 'C:\\Windows\\System32\\config\\SAM'],
    ['null byte', `${VALID_ID}\u0000.png`],
    ['uppercase hex', VALID_ID.toUpperCase()],
    ['braced uuid', `{${VALID_ID}}`],
    ['urn form', `urn:uuid:${VALID_ID}`],
    ['empty', ''],
    ['whitespace padded', ` ${VALID_ID} `],
    ['sql-ish', "' OR 1=1 --"],
    ['wrong version nibble', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['wrong variant nibble', '3f2504e0-4f89-41d3-1a0c-0305e82c3301'],
    ['truncated', '3f2504e0-4f89-41d3-9a0c'],
    ['non-string', 12345],
    ['null', null],
    ['object', { toString: () => VALID_ID }],
  ])('rejects %s', (_label, value) => {
    expect(() => assertSafeEvidenceId(value)).toThrow(UnsafePathError);
  });
});

describe('evidenceFilename', () => {
  it('uses a non-user-controlled timestamped name', () => {
    const at = new Date('2026-09-09T18:42:31.123Z');
    expect(evidenceFilename(VALID_ID, at)).toBe(`2026-09-09T18-42-31Z_${VALID_ID}.wav`);
  });

  it('produces a filesystem-safe timestamp', () => {
    const slug = timestampSlug(new Date('2026-01-02T03:04:05.678Z'));
    expect(slug).toBe('2026-01-02T03-04-05Z');
    expect(slug).not.toContain(':');
  });

  it('refuses to build a filename from an unsafe ID', () => {
    expect(() => evidenceFilename('../../evil', new Date())).toThrow(UnsafePathError);
  });
});

describe('resolveEvidencePath', () => {
  it('resolves a generated filename inside the directory', () => {
    const filename = evidenceFilename(VALID_ID, new Date('2026-09-09T18:42:31Z'));
    expect(resolveEvidencePath(DIR, filename)).toBe(resolve(DIR, filename));
  });

  it.each([
    '../outside.wav',
    '../../etc/passwd',
    'subdir/nested.wav',
    'subdir\\nested.wav',
    '/absolute.wav',
    `2026-09-09T18-42-31Z_${VALID_ID}.wav.exe`,
    `2026-09-09T18-42-31Z_${VALID_ID}.mp3`,
    `../2026-09-09T18-42-31Z_${VALID_ID}.wav`,
  ])('rejects %j', (filename) => {
    expect(() => resolveEvidencePath(DIR, filename)).toThrow(UnsafePathError);
  });
});

describe('assertWithinDirectory', () => {
  it('accepts a path inside the directory', () => {
    expect(() => assertWithinDirectory(DIR, resolve(DIR, 'a.wav'))).not.toThrow();
  });

  it('rejects a path that escapes via ..', () => {
    expect(() => assertWithinDirectory(DIR, resolve(DIR, '../../a.wav'))).toThrow(UnsafePathError);
  });

  it('rejects an unrelated absolute path', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\evil.wav' : '/tmp/evil.wav';
    expect(() => assertWithinDirectory(DIR, outside)).toThrow(UnsafePathError);
  });

  it('rejects a sibling directory sharing a name prefix', () => {
    // `./violation-audio-public` must not be treated as inside
    // `./violation-audio` just because the string starts the same way.
    expect(() => assertWithinDirectory(DIR, resolve('./violation-audio-public/x.wav'))).toThrow(
      UnsafePathError,
    );
  });
});
