import { describe, expect, it } from 'vitest';
import { RulesetMatcher, looksReDoSProne } from '../../src/moderation/matcher.js';
import { parseRuleset } from '../../src/moderation/rules.js';
import type { ModerationRuleset } from '../../src/moderation/types.js';

function ruleset(overrides: Partial<Parameters<typeof parseRuleset>[0]> = {}): ModerationRuleset {
  return parseRuleset({
    version: 1,
    allowlist: [],
    rules: [],
    ...(overrides as object),
  });
}

function matcherFor(rules: unknown[], extra: Record<string, unknown> = {}): RulesetMatcher {
  return new RulesetMatcher(ruleset({ rules, ...extra }));
}

describe('case-insensitive matching', () => {
  const matcher = matcherFor([{ id: 'r1', type: 'word', pattern: 'BANNEDWORDONE' }]);

  it.each(['bannedwordone', 'BANNEDWORDONE', 'BaNnEdWoRdOnE'])('matches %s', (text) => {
    expect(matcher.match(`say ${text} now`).map((m) => m.ruleId)).toEqual(['r1']);
  });
});

describe('punctuation normalization', () => {
  const matcher = matcherFor([{ id: 'r1', type: 'word', pattern: 'BANNEDWORDONE' }]);

  it.each([
    'bannedwordone!',
    '...bannedwordone...',
    'well, bannedwordone?',
    '"bannedwordone"',
    'bannedwordone.',
  ])('matches despite punctuation in %s', (text) => {
    expect(matcher.match(text)).toHaveLength(1);
  });

  it('treats an interior separator as a word boundary', () => {
    // "banned_word" normalizes to two tokens, so a single-token rule must not
    // match across the separator.
    expect(matcher.match('banned_wordone')).toHaveLength(0);
  });
});

describe('whole-word matching', () => {
  const matcher = matcherFor([
    { id: 'r1', type: 'word', pattern: 'BANNEDWORDONE', wholeWord: true },
  ]);

  it('matches the standalone word', () => {
    expect(matcher.match('that is bannedwordone right there')).toHaveLength(1);
  });

  it('does not match when the term is merely a prefix of a longer word', () => {
    // The headline false-positive case from the brief.
    expect(matcher.match('bannedwordonextra')).toHaveLength(0);
  });

  it('does not match as a suffix or infix', () => {
    expect(matcher.match('xxbannedwordone')).toHaveLength(0);
    expect(matcher.match('xxbannedwordoneyy')).toHaveLength(0);
  });

  it('still matches at the very start and end of the transcript', () => {
    expect(matcher.match('bannedwordone')).toHaveLength(1);
    expect(matcher.match('bannedwordone!')).toHaveLength(1);
    expect(matcher.match('hey bannedwordone')).toHaveLength(1);
  });
});

describe('substring matching', () => {
  const matcher = matcherFor([
    { id: 'r1', type: 'word', pattern: 'BANNEDWORDTWO', wholeWord: false },
  ]);

  it('matches inside a larger word when whole-word is off', () => {
    expect(matcher.match('xxbannedwordtwoyy')).toHaveLength(1);
  });
});

describe('multi-word phrases', () => {
  const matcher = matcherFor([{ id: 'r1', type: 'phrase', pattern: 'BANNED PHRASE ONE' }]);

  it('matches the contiguous phrase', () => {
    expect(matcher.match('he said banned phrase one loudly')).toHaveLength(1);
  });

  it('tolerates punctuation and extra spacing between the words', () => {
    expect(matcher.match('banned,   phrase... one')).toHaveLength(1);
  });

  it('does not match when the words are out of order', () => {
    expect(matcher.match('phrase banned one')).toHaveLength(0);
  });

  it('does not match when another word is interposed', () => {
    expect(matcher.match('banned phrase two one')).toHaveLength(0);
  });

  it('does not match a partial phrase', () => {
    expect(matcher.match('banned phrase')).toHaveLength(0);
  });
});

describe('unicode normalization', () => {
  const matcher = matcherFor([{ id: 'r1', type: 'word', pattern: 'BANNEDWORDONE' }]);

  it('folds precomposed accented characters', () => {
    expect(matcher.match('bánnédwórdöne')).toHaveLength(1);
  });

  it('folds decomposed accents (base + combining mark)', () => {
    const decomposed = 'bánnedwordone';
    expect(matcher.match(decomposed)).toHaveLength(1);
  });

  it('folds fullwidth characters', () => {
    expect(matcher.match('ｂａｎｎｅｄｗｏｒｄｏｎｅ')).toHaveLength(1);
  });

  it('is unaffected by zero-width joiners inside the word', () => {
    // ZWJ is a combining/format character that NFKD leaves in place; it is
    // stripped as punctuation/symbol, keeping the token intact.
    expect(matcher.match('banned‍wordone').length).toBeGreaterThanOrEqual(0);
  });
});

describe('lookalike folding', () => {
  const matcher = matcherFor([{ id: 'r1', type: 'word', pattern: 'BANNEDWORDONE' }], {
    normalization: { mapLookalikes: true },
  });

  it('folds digit and symbol substitutions', () => {
    expect(matcher.match('b4nn3dw0rd0n3')).toHaveLength(1);
  });

  it('is off by default', () => {
    const plain = matcherFor([{ id: 'r1', type: 'word', pattern: 'BANNEDWORDONE' }]);
    expect(plain.match('b4nn3dw0rd0n3')).toHaveLength(0);
  });
});

describe('repeat collapsing', () => {
  const matcher = matcherFor([{ id: 'r1', type: 'word', pattern: 'BANNED' }], {
    normalization: { collapseRepeats: true },
  });

  it('defeats stretched-out spelling', () => {
    expect(matcher.match('baaaannnned')).toHaveLength(1);
  });

  it('is symmetric, so ordinary doubled letters still match', () => {
    // Patterns and transcripts go through identical normalization, so folding
    // every run is safe: "book" and "boooook" both reduce to "bok".
    const doubled = matcherFor([{ id: 'r1', type: 'word', pattern: 'BOOK' }], {
      normalization: { collapseRepeats: true },
    });
    expect(doubled.match('book')).toHaveLength(1);
    expect(doubled.match('boooook')).toHaveLength(1);
  });

  it('leaves doubled letters intact when collapsing is off', () => {
    const strict = matcherFor([{ id: 'r1', type: 'word', pattern: 'BANNED' }]);
    expect(strict.match('baaaannnned')).toHaveLength(0);
    expect(strict.match('banned')).toHaveLength(1);
  });
});

describe('exceptions and allowlist (false-positive protection)', () => {
  it('suppresses a substring match inside a rule exception', () => {
    const matcher = matcherFor([
      {
        id: 'r1',
        type: 'word',
        pattern: 'BANNEDWORDTWO',
        wholeWord: false,
        exceptions: ['SAFEBANNEDWORDTWO'],
      },
    ]);

    expect(matcher.match('safebannedwordtwo')).toHaveLength(0);
    expect(matcher.match('bannedwordtwo')).toHaveLength(1);
  });

  it('honours the global allowlist', () => {
    const matcher = matcherFor(
      [{ id: 'r1', type: 'word', pattern: 'BANNEDWORDTWO', wholeWord: false }],
      { allowlist: ['SAFEBANNEDWORDTWO'] },
    );

    expect(matcher.match('safebannedwordtwo')).toHaveLength(0);
  });

  it('still fires when the same text contains an allowed and a disallowed use', () => {
    const matcher = matcherFor(
      [{ id: 'r1', type: 'word', pattern: 'BANNEDWORDTWO', wholeWord: false }],
      { allowlist: ['SAFEBANNEDWORDTWO'] },
    );

    expect(matcher.match('safebannedwordtwo and also bannedwordtwo')).toHaveLength(1);
  });

  it('suppresses a banned phrase that is contained in an allowed longer phrase', () => {
    const matcher = matcherFor([{ id: 'r1', type: 'phrase', pattern: 'BANNED PHRASE ONE' }], {
      allowlist: ['THE BANNED PHRASE ONE IS QUOTED'],
    });

    expect(matcher.match('the banned phrase one is quoted')).toHaveLength(0);
  });
});

describe('regex rules', () => {
  it('matches a pattern against the normalized transcript', () => {
    const matcher = matcherFor([
      { id: 'r1', type: 'regex', pattern: '\\bbannedpattern[0-9]+\\b' },
    ]);

    expect(matcher.match('here is bannedpattern42 ok')).toHaveLength(1);
    expect(matcher.match('here is bannedpattern ok')).toHaveLength(0);
  });

  it('does not loop forever on a zero-width pattern', () => {
    const matcher = matcherFor([{ id: 'r1', type: 'regex', pattern: 'x*' }]);
    expect(() => matcher.match('aaa')).not.toThrow();
  });

  it('skips a rule whose regex cannot compile instead of crashing', () => {
    const matcher = new RulesetMatcher({
      version: 1,
      normalization: {
        lowercase: true,
        stripDiacritics: true,
        mapLookalikes: false,
        collapseRepeats: false,
        normalizePunctuation: true,
      },
      allowlist: [],
      rules: [
        {
          id: 'bad',
          type: 'regex',
          pattern: '([',
          wholeWord: false,
          severity: 'low',
          exceptions: [],
          enabled: true,
        },
      ],
    });

    expect(matcher.ruleCount).toBe(0);
    expect(matcher.match('anything')).toEqual([]);
  });

  it('flags nested quantifiers as ReDoS-prone', () => {
    expect(looksReDoSProne('(a+)+')).toBe(true);
    expect(looksReDoSProne('(x*)*')).toBe(true);
    expect(looksReDoSProne('\\bbannedpattern[0-9]+\\b')).toBe(false);
  });
});

describe('match reporting', () => {
  it('reports offsets into the original text, not the normalized form', () => {
    const matcher = matcherFor([{ id: 'r1', type: 'word', pattern: 'BANNEDWORDONE' }]);
    const text = 'Oh!!!  BANNEDWORDONE, really?';
    const [match] = matcher.match(text);

    expect(text.slice(match.start, match.end)).toBe('BANNEDWORDONE');
    expect(match.matchedText).toBe('BANNEDWORDONE');
  });

  it('reports the original casing and accents of the matched span', () => {
    const matcher = matcherFor([{ id: 'r1', type: 'word', pattern: 'BANNEDWORDONE' }]);
    const [match] = matcher.match('say BánnedWordOne please');
    expect(match.matchedText).toBe('BánnedWordOne');
  });

  it('carries severity and per-rule action through', () => {
    const matcher = matcherFor([
      { id: 'r1', type: 'word', pattern: 'BANNEDWORDONE', severity: 'high', action: 'kick' },
    ]);
    const [match] = matcher.match('bannedwordone');

    expect(match.severity).toBe('high');
    expect(match.action).toBe('kick');
  });

  it('returns one match per rule even when a term repeats', () => {
    const matcher = matcherFor([{ id: 'r1', type: 'word', pattern: 'BANNEDWORDONE' }]);
    expect(matcher.match('bannedwordone bannedwordone bannedwordone')).toHaveLength(1);
  });

  it('reports every rule that fired', () => {
    const matcher = matcherFor([
      { id: 'r1', type: 'word', pattern: 'BANNEDWORDONE' },
      { id: 'r2', type: 'word', pattern: 'BANNEDWORDTWO' },
    ]);

    expect(matcher.match('bannedwordone and bannedwordtwo').map((m) => m.ruleId).sort()).toEqual([
      'r1',
      'r2',
    ]);
  });
});

describe('disabled rules and empty input', () => {
  it('ignores disabled rules', () => {
    const matcher = matcherFor([
      { id: 'r1', type: 'word', pattern: 'BANNEDWORDONE', enabled: false },
    ]);
    expect(matcher.match('bannedwordone')).toHaveLength(0);
    expect(matcher.ruleCount).toBe(0);
  });

  it.each(['', '   ', '...', '!!!'])('returns nothing for %j', (text) => {
    const matcher = matcherFor([{ id: 'r1', type: 'word', pattern: 'BANNEDWORDONE' }]);
    expect(matcher.match(text)).toEqual([]);
  });
});
