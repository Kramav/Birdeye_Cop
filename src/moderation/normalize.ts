import type { NormalizationOptions } from './types.js';

export interface NormToken {
  text: string;
  /** Offsets into the normalized string. */
  normStart: number;
  normEnd: number;
  /** Offsets into the original, un-normalized string. */
  origStart: number;
  origEnd: number;
}

export interface NormalizedText {
  original: string;
  normalized: string;
  /** For each normalized char, the original span that produced it. */
  mapStart: number[];
  mapEnd: number[];
  tokens: NormToken[];
}

/**
 * Characters commonly substituted to evade text filters.
 *
 * Applied before punctuation stripping, so `b@d` folds to `bad` rather than
 * being split into two tokens by the `@`.
 */
const LOOKALIKES: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '+': 't',
  '¡': 'i',
};

const PUNCT_OR_SYMBOL = /[\p{P}\p{S}]/u;
const COMBINING_MARK = /\p{M}/gu;

/**
 * Normalize text while retaining a mapping back to the original offsets, so a
 * match can be reported against the words the speaker actually used.
 *
 * Normalization is applied per code point rather than to the whole string.
 * Whole-string `NFKD` would be marginally more correct for sequences that
 * compose across boundaries, but it changes the string length in ways that
 * destroy the index mapping — and reporting a match at the wrong offset in a
 * moderation record is worse than the rare composition edge case.
 */
export function normalizeText(input: string, opts: NormalizationOptions): NormalizedText {
  const chars: string[] = [];
  const mapStart: number[] = [];
  const mapEnd: number[] = [];

  let cursor = 0;
  for (const codePoint of input) {
    const origStart = cursor;
    const origEnd = cursor + codePoint.length;
    cursor = origEnd;

    // NFKD folds fullwidth forms, ligatures and compatibility characters, and
    // splits precomposed accents into base + combining mark so diacritic
    // stripping works on both spellings of "é".
    let piece = codePoint.normalize('NFKD');

    if (opts.stripDiacritics) {
      piece = piece.replace(COMBINING_MARK, '');
    }
    if (opts.lowercase) {
      piece = piece.toLowerCase();
    }
    if (opts.mapLookalikes) {
      let mapped = '';
      for (const ch of piece) mapped += LOOKALIKES[ch] ?? ch;
      piece = mapped;
    }

    for (const ch of piece) {
      let out = ch;
      if (/\s/u.test(ch)) {
        out = ' ';
      } else if (opts.normalizePunctuation && PUNCT_OR_SYMBOL.test(ch)) {
        out = ' ';
      }
      chars.push(out);
      mapStart.push(origStart);
      mapEnd.push(origEnd);
    }
  }

  return collapse(input, chars, mapStart, mapEnd, opts);
}

function collapse(
  original: string,
  chars: string[],
  mapStart: number[],
  mapEnd: number[],
  opts: NormalizationOptions,
): NormalizedText {
  const outChars: string[] = [];
  const outStart: number[] = [];
  const outEnd: number[] = [];

  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];

    if (ch === ' ') {
      // Collapse whitespace runs, and drop leading whitespace entirely.
      let j = i;
      while (j < chars.length && chars[j] === ' ') j++;
      if (outChars.length > 0) {
        outChars.push(' ');
        outStart.push(mapStart[i]);
        outEnd.push(mapEnd[j - 1]);
      }
      i = j;
      continue;
    }

    // Measure the run of this character.
    let runEnd = i;
    while (runEnd < chars.length && chars[runEnd] === ch) runEnd++;
    const runLength = runEnd - i;

    // Collapse every run to a single character, not just long ones.
    //
    // Collapsing only runs of 3+ would be asymmetric: "baaaannnned" folds to
    // "baned" while the pattern "banned" keeps its double-n, so the two never
    // converge and the evasion succeeds. Because the identical normalization
    // is applied to patterns and to transcripts, folding all runs keeps
    // ordinary doubled letters matching too ("book" and "bookk" both fold to
    // "bok").
    const keep = opts.collapseRepeats && runLength >= 2 ? 1 : runLength;
    for (let k = 0; k < keep; k++) {
      outChars.push(ch);
      outStart.push(mapStart[i + k]);
      outEnd.push(mapEnd[i + k]);
    }
    i = runEnd;
  }

  // Drop a trailing space.
  while (outChars.length > 0 && outChars[outChars.length - 1] === ' ') {
    outChars.pop();
    outStart.pop();
    outEnd.pop();
  }

  const normalized = outChars.join('');
  return {
    original,
    normalized,
    mapStart: outStart,
    mapEnd: outEnd,
    tokens: tokenize(normalized, outStart, outEnd),
  };
}

function tokenize(normalized: string, mapStart: number[], mapEnd: number[]): NormToken[] {
  const tokens: NormToken[] = [];
  let start = -1;

  for (let i = 0; i <= normalized.length; i++) {
    const isBoundary = i === normalized.length || normalized[i] === ' ';
    if (isBoundary) {
      if (start >= 0) {
        tokens.push({
          text: normalized.slice(start, i),
          normStart: start,
          normEnd: i,
          origStart: mapStart[start],
          origEnd: mapEnd[i - 1],
        });
        start = -1;
      }
    } else if (start < 0) {
      start = i;
    }
  }

  return tokens;
}

/** Map a span in normalized coordinates back to original-string offsets. */
export function toOriginalSpan(
  nt: NormalizedText,
  normStart: number,
  normEnd: number,
): { start: number; end: number } {
  if (nt.mapStart.length === 0 || normEnd <= normStart) {
    return { start: 0, end: 0 };
  }
  const s = Math.max(0, Math.min(normStart, nt.mapStart.length - 1));
  const e = Math.max(0, Math.min(normEnd - 1, nt.mapEnd.length - 1));
  return { start: nt.mapStart[s], end: nt.mapEnd[e] };
}

/** Normalize a configured pattern with the same rules used for speech. */
export function normalizePattern(pattern: string, opts: NormalizationOptions): string {
  return normalizeText(pattern, opts).normalized;
}
