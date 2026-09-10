import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTerm,
  auditRuleset,
  loadRuleset,
  parseRuleset,
  removeTerm,
  ruleIdForTerm,
  saveRuleset,
} from '../../src/moderation/rules.js';
import { ConfigError } from '../../src/utils/errors.js';
import { DEFAULT_NORMALIZATION } from '../../src/moderation/types.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
  dirs.length = 0;
});

async function tempFile(name = 'moderation.json'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'birdeye-rules-'));
  dirs.push(dir);
  return join(dir, name);
}

describe('parseRuleset', () => {
  it('fills sensible defaults', () => {
    const ruleset = parseRuleset({ rules: [{ id: 'r1', type: 'word', pattern: 'X' }] });

    expect(ruleset.version).toBe(1);
    expect(ruleset.allowlist).toEqual([]);
    expect(ruleset.normalization).toEqual(DEFAULT_NORMALIZATION);
    expect(ruleset.rules[0]).toMatchObject({
      wholeWord: true,
      severity: 'medium',
      enabled: true,
      exceptions: [],
    });
  });

  it('defaults regex rules to not whole-word', () => {
    // A regex defines its own boundaries; forcing token matching on top would
    // silently change what the author wrote.
    const ruleset = parseRuleset({ rules: [{ id: 'r1', type: 'regex', pattern: 'a+b' }] });
    expect(ruleset.rules[0].wholeWord).toBe(false);
  });

  it('merges partial normalization settings over the defaults', () => {
    const ruleset = parseRuleset({
      normalization: { mapLookalikes: true },
      rules: [],
    });
    expect(ruleset.normalization.mapLookalikes).toBe(true);
    expect(ruleset.normalization.lowercase).toBe(true);
  });

  it('rejects duplicate rule IDs', () => {
    expect(() =>
      parseRuleset({
        rules: [
          { id: 'dup', type: 'word', pattern: 'a' },
          { id: 'dup', type: 'word', pattern: 'b' },
        ],
      }),
    ).toThrow(/duplicate rule id/i);
  });

  it('rejects an invalid regex at load time rather than at match time', () => {
    expect(() => parseRuleset({ rules: [{ id: 'r', type: 'regex', pattern: '([' }] })).toThrow(
      ConfigError,
    );
  });

  it.each<[string, unknown]>([
    ['empty id', { rules: [{ id: '', type: 'word', pattern: 'a' }] }],
    ['unknown type', { rules: [{ id: 'r', type: 'nope', pattern: 'a' }] }],
    ['empty pattern', { rules: [{ id: 'r', type: 'word', pattern: '' }] }],
    ['missing pattern', { rules: [{ id: 'r', type: 'word' }] }],
    ['missing rules array', {}],
    ['rules not an array', { rules: 'not-an-array' }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseRuleset(input)).toThrow(ConfigError);
  });

  it('reports the offending field path', () => {
    expect(() => parseRuleset({ rules: [{ id: 'r', type: 'word', pattern: '' }] })).toThrow(
      /rules\.0\.pattern/,
    );
  });
});

describe('auditRuleset', () => {
  it('flags enabled regex rules with nested quantifiers', () => {
    const ruleset = parseRuleset({
      rules: [
        { id: 'risky', type: 'regex', pattern: '(a+)+' },
        { id: 'fine', type: 'regex', pattern: 'ab+c' },
        { id: 'off', type: 'regex', pattern: '(x*)*', enabled: false },
      ],
    });

    expect(auditRuleset(ruleset)).toEqual(['risky']);
  });
});

describe('addTerm', () => {
  const base = parseRuleset({ rules: [] });

  it('creates a word rule for a single token', () => {
    const { rule } = addTerm(base, 'BANNEDWORDONE');
    expect(rule.type).toBe('word');
    expect(rule.wholeWord).toBe(true);
    expect(rule.severity).toBe('medium');
  });

  it('creates a phrase rule for multiple tokens', () => {
    const { rule } = addTerm(base, 'BANNED PHRASE ONE');
    expect(rule.type).toBe('phrase');
  });

  it('never creates a regex rule', () => {
    // Patterns from Discord commands are untrusted; a regex there would be a
    // denial-of-service vector against the matcher.
    const { rule } = addTerm(base, '(a+)+$');
    expect(rule.type).not.toBe('regex');
  });

  it('honours severity and whole-word options', () => {
    const { rule } = addTerm(base, 'X', { severity: 'high', wholeWord: false });
    expect(rule.severity).toBe('high');
    expect(rule.wholeWord).toBe(false);
  });

  it('detects an equivalent existing term rather than duplicating it', () => {
    const first = addTerm(base, 'BANNEDWORDONE');
    const second = addTerm(first.ruleset, 'bannedwordone!!!');

    expect(second.alreadyExists).toBe(true);
    expect(second.ruleset.rules).toHaveLength(1);
    expect(second.rule.id).toBe(first.rule.id);
  });

  it('rejects a term with nothing matchable in it', () => {
    expect(() => addTerm(base, '   ')).toThrow(ConfigError);
    expect(() => addTerm(base, '!!!')).toThrow(ConfigError);
  });

  it('does not mutate the input ruleset', () => {
    const result = addTerm(base, 'NEWTERM');
    expect(base.rules).toHaveLength(0);
    expect(result.ruleset.rules).toHaveLength(1);
  });

  it('generates stable, collision-resistant IDs', () => {
    expect(ruleIdForTerm('BANNEDWORDONE')).toBe(ruleIdForTerm('BANNEDWORDONE'));
    expect(ruleIdForTerm('a')).not.toBe(ruleIdForTerm('b'));
    expect(ruleIdForTerm('BANNED WORD')).toMatch(/^banned-word-[0-9a-f]{8}$/);
  });
});

describe('removeTerm', () => {
  it('removes by rule ID', () => {
    const { ruleset, rule } = addTerm(parseRuleset({ rules: [] }), 'TERM');
    const result = removeTerm(ruleset, rule.id);

    expect(result.removed?.id).toBe(rule.id);
    expect(result.ruleset.rules).toHaveLength(0);
  });

  it('removes by equivalent pattern', () => {
    const { ruleset } = addTerm(parseRuleset({ rules: [] }), 'BANNEDWORDONE');
    const result = removeTerm(ruleset, 'bannedwordone');

    expect(result.removed).toBeDefined();
    expect(result.ruleset.rules).toHaveLength(0);
  });

  it('reports when nothing matched', () => {
    const result = removeTerm(parseRuleset({ rules: [] }), 'missing');
    expect(result.removed).toBeUndefined();
  });
});

describe('persistence', () => {
  it('round-trips through the filesystem', async () => {
    const path = await tempFile();
    const ruleset = addTerm(parseRuleset({ rules: [] }), 'BANNEDWORDONE', {
      severity: 'high',
    }).ruleset;

    await saveRuleset(path, ruleset);
    const loaded = await loadRuleset(path);

    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0].severity).toBe('high');
  });

  it('writes the rules file owner-readable only', async () => {
    const path = await tempFile();
    await saveRuleset(path, parseRuleset({ rules: [] }));

    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it('gives an actionable error when the file is missing', async () => {
    await expect(loadRuleset(join(tmpdir(), 'definitely-not-here.json'))).rejects.toThrow(
      /moderation\.example\.json|npm run setup/,
    );
  });

  it('gives an actionable error for malformed JSON', async () => {
    const path = await tempFile();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ not json');

    await expect(loadRuleset(path)).rejects.toThrow(/not valid JSON/);
  });

  it('loads the shipped example config', async () => {
    const ruleset = await loadRuleset('./config/moderation.example.json');
    expect(ruleset.rules.length).toBeGreaterThan(0);
    // The example must never contain real offensive terms.
    for (const rule of ruleset.rules) {
      expect(rule.pattern.toUpperCase()).toMatch(/BANNED|PLACEHOLDER|SAFE/);
    }
  });
});
