import type { ModerationStore } from '../storage/types.js';
import { ACTION_LADDER, actionRank, capAction } from './types.js';
import type { ModerationActionType, Severity } from './types.js';

export interface EscalationInput {
  store: ModerationStore;
  guildId: string;
  userId: string;
  severity: Severity;
  /** Action requested by the matched rule, if it specified one. */
  ruleAction?: ModerationActionType;
  ceiling: ModerationActionType;
  escalationEnabled: boolean;
  escalationWindowHours: number;
  allowUnattendedBan: boolean;
  clock?: () => number;
}

export interface EscalationDecision {
  action: ModerationActionType;
  priorViolations: number;
  /** True when a ban was withheld because unattended bans are not enabled. */
  banWithheld: boolean;
}

/**
 * Decide what to do about a confirmed match.
 *
 * Three things narrow the outcome, in order:
 *
 *   1. **Escalation** — a first offence is a warning, not a removal. Repeat
 *      offences within the window climb the ladder.
 *   2. **The configured ceiling** — never exceed what the operator allowed.
 *   3. **Ban gating** — automated permanent bans decided by a speech
 *      recognizer are withheld unless explicitly enabled, and downgraded to a
 *      kick so a human can review the record. Transcription of noisy voice
 *      chat is not reliable enough to make an irreversible call unattended.
 */
export async function resolveAction(input: EscalationInput): Promise<EscalationDecision> {
  const clock = input.clock ?? Date.now;

  let priorViolations = 0;
  let action: ModerationActionType;

  if (input.escalationEnabled) {
    const since = clock() - input.escalationWindowHours * 60 * 60 * 1000;
    priorViolations = await input.store.countViolations(input.guildId, input.userId, since);

    // High-severity rules start one rung up the ladder.
    const severityBoost = input.severity === 'high' ? 1 : 0;
    const index = Math.min(priorViolations + severityBoost, ACTION_LADDER.length - 1);
    const escalated = ACTION_LADDER[index];

    // A rule that names an action sets a floor, not the final answer.
    action =
      input.ruleAction && actionRank(input.ruleAction) > actionRank(escalated)
        ? input.ruleAction
        : escalated;
  } else {
    action = input.ruleAction ?? input.ceiling;
  }

  action = capAction(action, input.ceiling);

  let banWithheld = false;
  if (action === 'ban' && !input.allowUnattendedBan) {
    action = 'kick';
    banWithheld = true;
  }

  return { action, priorViolations, banWithheld };
}
