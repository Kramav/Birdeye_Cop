import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { ConfigError } from '../utils/errors.js';
import { looksReDoSProne } from './matcher.js';
import { normalizePattern } from './normalize.js';
import { DEFAULT_NORMALIZATION } from './types.js';
import type { ModerationRule, ModerationRuleset, NormalizationOptions, Severity } from './types.js';

/**
 * Schema is intentionally permissive about optional fields and fills defaults
 * afterwards, so a hand-edited rules file stays short and readable.
 */
const normalizationSchema = z.object({
  lowercase: z.boolean().optional(),
  stripDiacritics: z.boolean().optional(),
  mapLookalikes: z.boolean().optional(),
  collapseRepeats: z.boolean().optional(),
  normalizePunctuation: z.boolean().optional(),
});

const ruleSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(['word', 'phrase', 'regex']),
  pattern: z.string().min(1).max(500),
  wholeWord: z.boolean().optional(),
  severity: z.enum(['low', 'medium', 'high']).optional(),
  action: z.enum(['warn', 'disconnect', 'kick', 'ban']).optional(),
  exceptions: z.array(z.string().max(200)).optional(),
  enabled: z.boolean().optional(),
  flags: z.string().max(8).optional(),
  description: z.string().max(500).optional(),
});

const rulesetSchema = z.object({
  version: z.number().int().positive().optional(),
  normalization: normalizationSchema.optional(),
  allowlist: z.array(z.string().max(200)).optional(),
  rules: z.array(ruleSchema),
});

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

export function parseRuleset(raw: unknown, source = 'moderation config'): ModerationRuleset {
  const parsed = rulesetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid ${source}:\n${formatIssues(parsed.error)}`);
  }

  const normalization: NormalizationOptions = {
    ...DEFAULT_NORMALIZATION,
    ...(parsed.data.normalization ?? {}),
  };

  const seen = new Set<string>();
  const rules: ModerationRule[] = parsed.data.rules.map((r) => {
    if (seen.has(r.id)) {
      throw new ConfigError(`Invalid ${source}: duplicate rule id "${r.id}"`);
    }
    seen.add(r.id);

    if (r.type === 'regex') {
      try {
        new RegExp(r.pattern);
      } catch (err) {
        throw new ConfigError(
          `Invalid ${source}: rule "${r.id}" has an invalid regex: ${(err as Error).message}`,
        );
      }
    }

    return {
      id: r.id,
      type: r.type,
      pattern: r.pattern,
      // Whole-word defaults on for literals: substring matching is the main
      // source of false positives, and regex rules define their own bounds.
      wholeWord: r.wholeWord ?? r.type !== 'regex',
      severity: r.severity ?? 'medium',
      ...(r.action ? { action: r.action } : {}),
      exceptions: r.exceptions ?? [],
      enabled: r.enabled ?? true,
      ...(r.flags ? { flags: r.flags } : {}),
      ...(r.description ? { description: r.description } : {}),
    };
  });

  return {
    version: parsed.data.version ?? 1,
    normalization,
    allowlist: parsed.data.allowlist ?? [],
    rules,
  };
}

/** Regex rules that are likely to backtrack catastrophically. */
export function auditRuleset(ruleset: ModerationRuleset): string[] {
  return ruleset.rules
    .filter((r) => r.type === 'regex' && r.enabled && looksReDoSProne(r.pattern))
    .map((r) => r.id);
}

export async function loadRuleset(path: string): Promise<ModerationRuleset> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(
        `Moderation rules file not found at ${resolve(path)}.\n` +
          `Copy config/moderation.example.json to that path, or run \`npm run setup\`.`,
      );
    }
    throw new ConfigError(`Could not read moderation rules at ${path}: ${(err as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Moderation rules at ${path} are not valid JSON: ${(err as Error).message}`);
  }

  return parseRuleset(json, `moderation rules (${path})`);
}

/**
 * Write the ruleset atomically.
 *
 * Admin commands mutate this file at runtime; a partial write would leave the
 * bot unable to start, so the replacement is staged and renamed into place.
 */
export async function saveRuleset(path: string, ruleset: ModerationRuleset): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const body = JSON.stringify(ruleset, null, 2);
  await writeFile(tmp, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

/** Deterministic, collision-resistant ID for a term added via a command. */
export function ruleIdForTerm(term: string): string {
  const slug = term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const hash = createHash('sha256').update(term.normalize('NFC')).digest('hex').slice(0, 8);
  return slug ? `${slug}-${hash}` : `rule-${hash}`;
}

export interface AddTermOptions {
  severity?: Severity;
  wholeWord?: boolean;
}

/**
 * Add a literal term. Never creates regex rules — patterns from Discord
 * commands are untrusted input and a regex there would be a denial-of-service
 * vector against the matcher.
 */
export function addTerm(
  ruleset: ModerationRuleset,
  term: string,
  opts: AddTermOptions = {},
): { ruleset: ModerationRuleset; rule: ModerationRule; alreadyExists: boolean } {
  const trimmed = term.trim();
  if (!trimmed) throw new ConfigError('Term cannot be empty');

  const normalized = normalizePattern(trimmed, ruleset.normalization);
  if (!normalized) {
    throw new ConfigError('Term contains no matchable characters after normalization');
  }

  const existing = ruleset.rules.find(
    (r) => r.type !== 'regex' && normalizePattern(r.pattern, ruleset.normalization) === normalized,
  );
  if (existing) {
    return { ruleset, rule: existing, alreadyExists: true };
  }

  const rule: ModerationRule = {
    id: ruleIdForTerm(trimmed),
    type: normalized.includes(' ') ? 'phrase' : 'word',
    pattern: trimmed,
    wholeWord: opts.wholeWord ?? true,
    severity: opts.severity ?? 'medium',
    exceptions: [],
    enabled: true,
  };

  return {
    ruleset: { ...ruleset, rules: [...ruleset.rules, rule] },
    rule,
    alreadyExists: false,
  };
}

/** Remove by rule ID or by equivalent normalized pattern. */
export function removeTerm(
  ruleset: ModerationRuleset,
  termOrId: string,
): { ruleset: ModerationRuleset; removed: ModerationRule | undefined } {
  const needle = termOrId.trim();
  const normalized = normalizePattern(needle, ruleset.normalization);

  const removed = ruleset.rules.find(
    (r) =>
      r.id === needle ||
      (r.type !== 'regex' && normalizePattern(r.pattern, ruleset.normalization) === normalized),
  );

  if (!removed) return { ruleset, removed: undefined };

  return {
    ruleset: { ...ruleset, rules: ruleset.rules.filter((r) => r !== removed) },
    removed,
  };
}
