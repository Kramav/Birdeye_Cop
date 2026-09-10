import { LogEvent } from '../observability/events.js';
import type { Logger } from '../observability/logger.js';
import { RulesetMatcher } from './matcher.js';
import { addTerm, auditRuleset, loadRuleset, removeTerm, saveRuleset } from './rules.js';
import type { AddTermOptions } from './rules.js';
import type { IMatcher, ModerationRule, ModerationRuleset } from './types.js';

/**
 * Holds the live ruleset and the compiled matcher built from it.
 *
 * Rules change at runtime through admin commands, so the matcher is rebuilt on
 * every mutation and handed to the pipeline through a getter — the pipeline
 * never caches it, and an edit takes effect on the next utterance rather than
 * the next restart.
 */
export class RulesService {
  private ruleset: ModerationRuleset;
  private compiled: RulesetMatcher;

  constructor(
    private readonly path: string,
    initial: ModerationRuleset,
    private readonly logger: Logger,
  ) {
    this.ruleset = initial;
    this.compiled = new RulesetMatcher(initial, logger);
    this.warnAboutRiskyRules(initial);
  }

  static async create(path: string, logger: Logger): Promise<RulesService> {
    return new RulesService(path, await loadRuleset(path), logger);
  }

  get matcher(): IMatcher {
    return this.compiled;
  }

  get current(): ModerationRuleset {
    return this.ruleset;
  }

  get ruleCount(): number {
    return this.compiled.ruleCount;
  }

  private warnAboutRiskyRules(ruleset: ModerationRuleset): void {
    const risky = auditRuleset(ruleset);
    if (risky.length > 0) {
      this.logger.warn(LogEvent.CONFIG_LOADED, {
        ruleIds: risky,
        message:
          'Regex rules contain nested quantifiers and may backtrack catastrophically on long input',
      });
    }
  }

  private async commit(next: ModerationRuleset): Promise<void> {
    // Compile before persisting: a ruleset that cannot build a matcher must
    // never reach disk, or the next restart fails.
    const compiled = new RulesetMatcher(next, this.logger);
    await saveRuleset(this.path, next);
    this.ruleset = next;
    this.compiled = compiled;
  }

  async addTerm(
    term: string,
    opts: AddTermOptions = {},
  ): Promise<{ rule: ModerationRule; alreadyExists: boolean }> {
    const result = addTerm(this.ruleset, term, opts);
    if (!result.alreadyExists) {
      await this.commit(result.ruleset);
      this.logger.info(LogEvent.CONFIG_CHANGED, {
        change: 'rule-added',
        ruleId: result.rule.id,
        ruleType: result.rule.type,
      });
    }
    return { rule: result.rule, alreadyExists: result.alreadyExists };
  }

  async removeTerm(termOrId: string): Promise<ModerationRule | undefined> {
    const result = removeTerm(this.ruleset, termOrId);
    if (result.removed) {
      await this.commit(result.ruleset);
      this.logger.info(LogEvent.CONFIG_CHANGED, {
        change: 'rule-removed',
        ruleId: result.removed.id,
      });
    }
    return result.removed;
  }

  async reload(): Promise<void> {
    const next = await loadRuleset(this.path);
    this.compiled = new RulesetMatcher(next, this.logger);
    this.ruleset = next;
    this.warnAboutRiskyRules(next);
    this.logger.info(LogEvent.CONFIG_CHANGED, { change: 'rules-reloaded', rules: next.rules.length });
  }
}
