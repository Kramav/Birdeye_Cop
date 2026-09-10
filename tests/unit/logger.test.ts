import { describe, expect, it } from 'vitest';
import { createLogger, hashText } from '../../src/observability/logger.js';

function capture(opts: { transcriptLogging?: boolean; level?: 'debug' | 'info' } = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    level: opts.level ?? 'debug',
    transcriptLogging: opts.transcriptLogging ?? false,
    sink: (line) => lines.push(line),
  });
  return { logger, lines, last: () => JSON.parse(lines[lines.length - 1]) as Record<string, unknown> };
}

describe('binary rejection', () => {
  it('never writes Buffer contents', () => {
    const { logger, lines, last } = capture();
    logger.info('TEST', { audio: Buffer.from([1, 2, 3, 4, 5]) });

    expect(last().audio).toBe('[binary omitted: 5 bytes]');
    expect(lines[0]).not.toContain('"1,2,3');
  });

  it('never writes typed-array contents', () => {
    const { logger, last } = capture();
    logger.info('TEST', { pcm: new Int16Array([1000, -1000]) });

    expect(last().pcm).toBe('[binary omitted: 4 bytes]');
  });

  it('rejects binary nested inside an object', () => {
    const { logger, last } = capture();
    logger.info('TEST', { segment: { userId: 'u1', pcm16k: new Int16Array(480) } });

    const segment = last().segment as Record<string, unknown>;
    expect(segment.userId).toBe('u1');
    expect(segment.pcm16k).toBe('[binary omitted: 960 bytes]');
  });

  it('rejects a raw ArrayBuffer', () => {
    const { logger, last } = capture();
    logger.info('TEST', { raw: new ArrayBuffer(8) });
    expect(last().raw).toBe('[binary omitted: 8 bytes]');
  });
});

describe('secret redaction', () => {
  it.each([
    'token',
    'DISCORD_TOKEN',
    'apiKey',
    'api_key',
    'sttApiKey',
    'password',
    'authorization',
    'clientSecret',
    'sessionCookie',
    'bearerToken',
  ])('redacts the %s field', (key) => {
    const { logger, lines } = capture();
    logger.info('TEST', { [key]: 'super-secret-value-12345' });

    expect(lines[0]).not.toContain('super-secret-value-12345');
    expect(JSON.parse(lines[0])[key]).toBe('[REDACTED]');
  });

  it('redacts secrets nested inside config objects', () => {
    const { logger, lines } = capture();
    logger.info('TEST', { stt: { provider: 'deepgram', apiKey: 'dg-live-abcdef' } });

    expect(lines[0]).not.toContain('dg-live-abcdef');
    expect(lines[0]).toContain('deepgram');
  });

  it('does not redact innocuous fields that merely contain "key"', () => {
    const { logger, last } = capture();
    logger.info('TEST', { dedupeKey: 'seg:1:2:3', keyword: 'hello' });

    expect(last().dedupeKey).toBe('seg:1:2:3');
    expect(last().keyword).toBe('hello');
  });
});

describe('transcript gating', () => {
  it('replaces a transcript with a hash when logging is disabled', () => {
    const { logger, lines, last } = capture({ transcriptLogging: false });
    logger.info('TEST', { transcript: 'the quick brown fox' });

    expect(lines[0]).not.toContain('quick brown fox');
    expect(last().transcriptHash).toBe(hashText('the quick brown fox'));
    expect(last().transcriptLength).toBe(19);
    expect(last().transcript).toBeUndefined();
  });

  it('includes the transcript when logging is explicitly enabled', () => {
    const { logger, last } = capture({ transcriptLogging: true });
    logger.info('TEST', { transcript: 'the quick brown fox' });

    expect(last().transcript).toBe('the quick brown fox');
  });

  it('gates every field name that can carry speech', () => {
    const { logger, lines } = capture({ transcriptLogging: false });
    logger.info('TEST', {
      transcript: 'aaa',
      text: 'bbb',
      matchedText: 'ccc',
      verifyTranscript: 'ddd',
    });

    for (const secret of ['aaa', 'bbb', 'ccc', 'ddd']) {
      expect(lines[0]).not.toContain(`"${secret}"`);
    }
  });

  it('produces a stable, non-reversible hash', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('hello')).not.toBe(hashText('hello '));
    expect(hashText('hello')).toHaveLength(16);
  });
});

describe('structure and robustness', () => {
  it('emits one JSON object per line with time, level and event', () => {
    const { logger, last } = capture();
    logger.warn('MODERATION_MATCH', { ruleId: 'r1' });

    const record = last();
    expect(record.level).toBe('warn');
    expect(record.event).toBe('MODERATION_MATCH');
    expect(typeof record.time).toBe('string');
    expect(record.ruleId).toBe('r1');
  });

  it('respects the level threshold', () => {
    const { logger, lines } = capture({ level: 'info' });
    logger.debug('TEST', {});
    expect(lines).toHaveLength(0);

    logger.info('TEST', {});
    expect(lines).toHaveLength(1);
  });

  it('serializes errors without throwing', () => {
    const { logger, last } = capture();
    logger.error('TEST', { err: new Error('boom') });

    const err = last().err as Record<string, unknown>;
    expect(err.message).toBe('boom');
    expect(err.name).toBe('Error');
  });

  it('survives circular references', () => {
    const { logger, last } = capture();
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;

    expect(() => logger.info('TEST', { a })).not.toThrow();
    expect((last().a as Record<string, unknown>).self).toBe('[circular]');
  });

  it('merges child bindings into every record', () => {
    const { logger, last } = capture();
    logger.child({ guildId: 'g1' }).info('TEST', { userId: 'u1' });

    expect(last().guildId).toBe('g1');
    expect(last().userId).toBe('u1');
  });

  it('truncates very long strings', () => {
    const { logger, last } = capture();
    logger.info('TEST', { blob: 'x'.repeat(5000) });

    expect(String(last().blob)).toContain('[truncated]');
    expect(String(last().blob).length).toBeLessThan(2100);
  });
});
