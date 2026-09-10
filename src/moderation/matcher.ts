import type { Logger } from '../observability/logger.js';
import { normalizeText, normalizePattern, toOriginalSpan } from './normalize.js';
import type { NormalizedText } from './normalize.js';
import type { IMatcher, ModerationRule, ModerationRuleset, RuleMatch } from './types.js';

/** Upper bound on text handed to the matcher, as a backstop against pathological regexes. */
const MAX_MATCH_INPUT = 10_000;

type Span = readonly [start: number, end: number];

interface CompiledRule {
  rule: ModerationRule;
  normalizedPattern: string;
  patternTokens: string[];
  regex?: RegExp;
  /** Rule-specific exception terms, normalized. */
  exceptions: string[];
}

/**
 * Heuristic for catastrophically-backtracking patterns: a quantified group
 * that itself contains a quantifier, e.g. `(a+)+`.
 *
 * Node cannot interrupt a running regex, so this only warns. The real
 * mitigation is that regex rules load exclusively from the config file and are
 * never accepted from a Discord command.
 */
const NESTED_QUANTIFIER = /\([^()]*[*+][^()]*\)\s*[*+{]|\[[^\]]*\][*+]\s*[*+{]/;

export function looksReDoSProne(source: string): boolean {
  return NESTED_QUANTIFIER.test(source);
}

function compileRegex(rule: ModerationRule, logger?: Logger): RegExp | undefined {
  const flags = new Set((rule.flags ?? '').split(''));
  flags.add('g');
  flags.delete('y'); // sticky would break the scan loop

  if (looksReDoSProne(rule.pattern)) {
    logger?.warn('CONFIG_LOADED', {
      message: 'Regex rule contains nested quantifiers and may backtrack catastrophically',
      ruleId: rule.id,
    });
  }

  // Prefer Unicode mode, but not every valid legacy pattern survives it.
  try {
    return new RegExp(rule.pattern, [...flags, 'u'].join(''));
  } catch {
    try {
      return new RegExp(rule.pattern, [...flags].join(''));
    } catch (err) {
      logger?.error('CONFIG_LOADED', {
        message: 'Regex rule failed to compile and has been disabled',
        ruleId: rule.id,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return undefined;
    }
  }
}

/**
 * Banned-term matcher.
 *
 * Returns at most one match per rule — the first occurrence that is not
 * suppressed by an exception. Callers care which rules fired, not how many
 * times, and one-per-rule keeps moderation records readable.
 */
export class RulesetMatcher implements IMatcher {
  private readonly compiled: CompiledRule[] = [];
  private readonly allowlist: string[];

  constructor(
    private readonly ruleset: ModerationRuleset,
    logger?: Logger,
  ) {
    const norm = ruleset.normalization;

    this.allowlist = ruleset.allowlist
      .map((term) => normalizePattern(term, norm))
      .filter((term) => term.length > 0);

    for (const rule of ruleset.rules) {
      const normalizedPattern =
        rule.type === 'regex' ? rule.pattern : normalizePattern(rule.pattern, norm);

      const compiled: CompiledRule = {
        rule,
        normalizedPattern,
        patternTokens: normalizedPattern.split(' ').filter(Boolean),
        exceptions: rule.exceptions
          .map((term) => normalizePattern(term, norm))
          .filter((term) => term.length > 0),
      };

      if (rule.type === 'regex') {
        const regex = compileRegex(rule, logger);
        if (!regex) continue; // failed to compile; already logged
        compiled.regex = regex;
      } else if (normalizedPattern.length === 0) {
        logger?.warn('CONFIG_LOADED', {
          message: 'Rule pattern normalized to nothing and has been skipped',
          ruleId: rule.id,
        });
        continue;
      }

      this.compiled.push(compiled);
    }
  }

  get ruleCount(): number {
    return this.compiled.filter((c) => c.rule.enabled).length;
  }

  match(text: string): RuleMatch[] {
    if (!text) return [];

    const input = text.length > MAX_MATCH_INPUT ? text.slice(0, MAX_MATCH_INPUT) : text;
    const nt = normalizeText(input, this.ruleset.normalization);
    if (nt.normalized.length === 0) return [];

    const globalSuppression = findAllSpans(nt.normalized, this.allowlist);
    const results: RuleMatch[] = [];

    for (const compiled of this.compiled) {
      if (!compiled.rule.enabled) continue;

      const suppression =
        compiled.exceptions.length > 0
          ? [...globalSuppression, ...findAllSpans(nt.normalized, compiled.exceptions)]
          : globalSuppression;

      const span = this.firstAllowedSpan(nt, compiled, suppression);
      if (!span) continue;

      const orig = toOriginalSpan(nt, span[0], span[1]);
      results.push({
        ruleId: compiled.rule.id,
        ruleType: compiled.rule.type,
        severity: compiled.rule.severity,
        ...(compiled.rule.action ? { action: compiled.rule.action } : {}),
        matchedText: nt.original.slice(orig.start, orig.end),
        start: orig.start,
        end: orig.end,
      });
    }

    return results;
  }

  private firstAllowedSpan(
    nt: NormalizedText,
    compiled: CompiledRule,
    suppression: Span[],
  ): Span | undefined {
    for (const span of this.candidateSpans(nt, compiled)) {
      if (!isSuppressed(span, suppression)) return span;
    }
    return undefined;
  }

  private *candidateSpans(nt: NormalizedText, compiled: CompiledRule): Generator<Span> {
    const { rule, regex, patternTokens, normalizedPattern } = compiled;

    if (rule.type === 'regex') {
      if (!regex) return;
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(nt.normalized)) !== null) {
        if (m[0].length === 0) {
          regex.lastIndex++; // zero-width match would loop forever
          continue;
        }
        yield [m.index, m.index + m[0].length];
      }
      return;
    }

    if (rule.wholeWord) {
      // Token-subsequence match. A single-token pattern degenerates to token
      // equality, which is what keeps BANNED_WORD_1 off BANNED_WORD_1_SUFFIX.
      const tokens = nt.tokens;
      const needed = patternTokens.length;
      if (needed === 0) return;

      for (let i = 0; i + needed <= tokens.length; i++) {
        let ok = true;
        for (let j = 0; j < needed; j++) {
          if (tokens[i + j].text !== patternTokens[j]) {
            ok = false;
            break;
          }
        }
        if (ok) yield [tokens[i].normStart, tokens[i + needed - 1].normEnd];
      }
      return;
    }

    yield* substringSpans(nt.normalized, normalizedPattern);
  }
}

function* substringSpans(haystack: string, needle: string): Generator<Span> {
  if (needle.length === 0) return;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    yield [index, index + needle.length];
    index = haystack.indexOf(needle, index + 1);
  }
}

function findAllSpans(haystack: string, needles: readonly string[]): Span[] {
  const spans: Span[] = [];
  for (const needle of needles) {
    for (const span of substringSpans(haystack, needle)) spans.push(span);
  }
  return spans;
}

/**
 * A match is suppressed when it sits entirely inside an allowlisted term.
 *
 * This is what makes an exception for `BANNED_WORD_1_SAFE_COMPOUND` protect
 * that compound even when the `BANNED_WORD_1` rule is matching as a substring.
 */
function isSuppressed(span: Span, suppression: readonly Span[]): boolean {
  return suppression.some(([start, end]) => start <= span[0] && span[1] <= end);
}
