import { PermissionFlagsBits } from 'discord.js';
import type { Client, Guild, GuildMember } from 'discord.js';
import { LogEvent } from '../observability/events.js';
import type { Logger } from '../observability/logger.js';
import { toError } from '../utils/errors.js';
import type { ModerationActionType } from './types.js';

export interface ActionRequest {
  guildId: string;
  channelId: string;
  userId: string;
  action: ModerationActionType;
  reason: string;
  dryRun: boolean;
}

export interface ActionOutcome {
  executed: boolean;
  /** Present when the action was deliberately not performed. */
  skipped?: string;
  error?: Error;
}

/** Swappable execution of a moderation decision. */
export interface IModerationAction {
  execute(request: ActionRequest): Promise<ActionOutcome>;
}

const REQUIRED_PERMISSION: Record<ModerationActionType, bigint | undefined> = {
  warn: undefined,
  disconnect: PermissionFlagsBits.MoveMembers,
  kick: PermissionFlagsBits.KickMembers,
  ban: PermissionFlagsBits.BanMembers,
};

/** Truncated to Discord's audit-log reason limit. */
function auditReason(reason: string): string {
  return reason.length > 500 ? `${reason.slice(0, 497)}...` : reason;
}

export class DiscordModerationAction implements IModerationAction {
  constructor(
    private readonly client: Client,
    private readonly logger: Logger,
  ) {}

  async execute(request: ActionRequest): Promise<ActionOutcome> {
    if (request.dryRun) {
      this.logger.info(LogEvent.MODERATION_ACTION, {
        ...describe(request),
        dryRun: true,
        message: 'Dry run: no action was taken',
      });
      return { executed: false, skipped: 'dry-run' };
    }

    if (request.action === 'warn') {
      return this.warn(request);
    }

    let guild: Guild;
    try {
      guild = await this.client.guilds.fetch(request.guildId);
    } catch (err) {
      return this.fail(request, 'guild-unavailable', toError(err));
    }

    const permission = REQUIRED_PERMISSION[request.action];
    if (permission && !guild.members.me?.permissions.has(permission)) {
      this.logger.error(LogEvent.PERMISSION_ERROR, {
        ...describe(request),
        message: `Missing permission for ${request.action}`,
      });
      return { executed: false, skipped: 'missing-permission' };
    }

    // Fetch by ID rather than reusing any cached member object, so the action
    // can only ever land on the user the pipeline decided about.
    let member: GuildMember | null = null;
    try {
      member = await guild.members.fetch(request.userId);
    } catch {
      member = null;
    }

    if (!member) {
      // Someone who left mid-processing can still be banned, but there is
      // nobody to disconnect or kick.
      if (request.action === 'ban') return this.banById(guild, request);
      return { executed: false, skipped: 'member-not-in-guild' };
    }

    if (!this.canActOn(guild, member, request)) {
      return { executed: false, skipped: 'role-hierarchy' };
    }

    try {
      switch (request.action) {
        case 'disconnect': {
          if (!member.voice.channelId) {
            return { executed: false, skipped: 'not-in-voice' };
          }
          await member.voice.disconnect(auditReason(request.reason));
          break;
        }
        case 'kick':
          await member.kick(auditReason(request.reason));
          break;
        case 'ban':
          await member.ban({ reason: auditReason(request.reason), deleteMessageSeconds: 0 });
          break;
      }
    } catch (err) {
      return this.fail(request, 'discord-api-error', toError(err));
    }

    this.logger.info(LogEvent.MODERATION_ACTION, { ...describe(request), executed: true });
    return { executed: true };
  }

  /**
   * Discord refuses actions against members whose highest role is at or above
   * the bot's. Checking first turns a confusing API error into a clear log.
   */
  private canActOn(guild: Guild, member: GuildMember, request: ActionRequest): boolean {
    const me = guild.members.me;
    if (!me) return false;

    if (member.id === guild.ownerId) {
      this.logger.warn(LogEvent.PERMISSION_ERROR, {
        ...describe(request),
        message: 'Cannot moderate the guild owner',
      });
      return false;
    }

    if (request.action !== 'warn' && me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
      this.logger.warn(LogEvent.PERMISSION_ERROR, {
        ...describe(request),
        message: "Target's highest role is not below the bot's; Discord will refuse the action",
      });
      return false;
    }

    return true;
  }

  private async banById(guild: Guild, request: ActionRequest): Promise<ActionOutcome> {
    try {
      await guild.bans.create(request.userId, {
        reason: auditReason(request.reason),
        deleteMessageSeconds: 0,
      });
      this.logger.info(LogEvent.MODERATION_ACTION, { ...describe(request), executed: true });
      return { executed: true };
    } catch (err) {
      return this.fail(request, 'discord-api-error', toError(err));
    }
  }

  private async warn(request: ActionRequest): Promise<ActionOutcome> {
    try {
      const user = await this.client.users.fetch(request.userId);
      await user.send(
        `You were flagged by voice moderation in this server.\n\nReason: ${request.reason}`,
      );
      this.logger.info(LogEvent.MODERATION_ACTION, { ...describe(request), executed: true });
      return { executed: true };
    } catch (err) {
      // Closed DMs are ordinary, not a failure of moderation: the event is
      // still recorded and posted to the log channel.
      this.logger.info(LogEvent.MODERATION_ACTION, {
        ...describe(request),
        executed: true,
        dmDelivered: false,
        err: toError(err),
      });
      return { executed: true, skipped: 'dm-undeliverable' };
    }
  }

  private fail(request: ActionRequest, skipped: string, error: Error): ActionOutcome {
    this.logger.error(LogEvent.MODERATION_ERROR, { ...describe(request), skipped, err: error });
    return { executed: false, skipped, error };
  }
}

function describe(request: ActionRequest): Record<string, unknown> {
  return {
    guildId: request.guildId,
    channelId: request.channelId,
    userId: request.userId,
    action: request.action,
  };
}

/** Records the decision without touching Discord. Used by tests. */
export class RecordingModerationAction implements IModerationAction {
  readonly requests: ActionRequest[] = [];

  constructor(private readonly outcome: ActionOutcome = { executed: true }) {}

  execute(request: ActionRequest): Promise<ActionOutcome> {
    this.requests.push(request);
    if (request.dryRun) return Promise.resolve({ executed: false, skipped: 'dry-run' });
    return Promise.resolve(this.outcome);
  }
}
