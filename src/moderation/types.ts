export type Severity = 'low' | 'medium' | 'high';

export type ModerationActionType = 'warn' | 'disconnect' | 'kick' | 'ban';

/** Ordered least- to most-severe. Used for escalation and for capping. */
export const ACTION_LADDER: readonly ModerationActionType[] = [
  'warn',
  'disconnect',
  'kick',
  'ban',
] as const;

export function actionRank(action: ModerationActionType): number {
  return ACTION_LADDER.indexOf(action);
}

/** Returns whichever action is less severe. */
export function capAction(
  requested: ModerationActionType,
  ceiling: ModerationActionType,
): ModerationActionType {
  return actionRank(requested) <= actionRank(ceiling) ? requested : ceiling;
}

export type RuleType = 'word' | 'phrase' | 'regex';

export interface ModerationRule {
  id: string;
  type: RuleType;
  /** Literal term for word/phrase rules; a regex source for regex rules. */
  pattern: string;
  /**
   * When true, the term must occupy whole tokens. This is what keeps
   * `BANNED_WORD_1` from firing on `BANNED_WORD_1_SAFE_COMPOUND`.
   */
  wholeWord: boolean;
  severity: Severity;
  /** Per-rule override; still capped by the guild's configured ceiling. */
  action?: ModerationActionType;
  /**
   * Terms that suppress this rule when the match falls inside one of them.
   * Applies in both whole-word and substring modes.
   */
  exceptions: string[];
  enabled: boolean;
  /** Regex rules only. `g` and `u` are added automatically. */
  flags?: string;
  description?: string;
}

export interface NormalizationOptions {
  lowercase: boolean;
  stripDiacritics: boolean;
  /** Fold visually confusable characters (0→o, 1→i, @→a, …). */
  mapLookalikes: boolean;
  /** Collapse runs of the same character ("heeeey" → "hey"). */
  collapseRepeats: boolean;
  normalizePunctuation: boolean;
}

export const DEFAULT_NORMALIZATION: NormalizationOptions = {
  lowercase: true,
  stripDiacritics: true,
  mapLookalikes: false,
  collapseRepeats: false,
  normalizePunctuation: true,
};

export interface ModerationRuleset {
  version: number;
  normalization: NormalizationOptions;
  /** Global terms that suppress any rule matching inside them. */
  allowlist: string[];
  rules: ModerationRule[];
}

export interface RuleMatch {
  ruleId: string;
  ruleType: RuleType;
  severity: Severity;
  action?: ModerationActionType;
  /** The matched span, taken from the ORIGINAL text, not the normalized form. */
  matchedText: string;
  /** Offsets into the original text. */
  start: number;
  end: number;
}

/** Swappable banned-term matching engine. */
export interface IMatcher {
  match(text: string): RuleMatch[];
  readonly ruleCount: number;
}
