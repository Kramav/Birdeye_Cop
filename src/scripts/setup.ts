/**
 * `npm run setup` — interactive first-run configuration.
 *
 * Design goals, in order:
 *   1. Fail fast on a bad token, rather than at first use.
 *   2. Never ask for something that can be discovered. The application ID is
 *      read from the token; servers and channels are listed, not typed.
 *   3. Preserve the documentation in .env.example by editing values in place.
 *   4. Make it safe to re-run.
 */
import prompts from 'prompts';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { invitePermissions } from '../bot/permissions.js';
import type { ModerationActionType } from '../moderation/types.js';
import { toError } from '../utils/errors.js';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

const ENV_PATH = '.env';
const ENV_EXAMPLE = '.env.example';
const RULES_PATH = './config/moderation.json';
const RULES_EXAMPLE = './config/moderation.example.json';

interface DiscordUser {
  id: string;
  username: string;
}
interface DiscordGuild {
  id: string;
  name: string;
}
interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  position?: number;
}

function onCancel(): never {
  process.stdout.write('\nSetup cancelled. Nothing was written.\n');
  process.exit(130);
}

async function api<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Discord API ${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Replace values in an env file while keeping every comment intact. */
function applyValues(template: string, values: Record<string, string>): string {
  const applied = new Set<string>();

  const lines = template.split('\n').map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!(key in values)) return line;
    applied.add(key);
    return `${key}=${values[key]}`;
  });

  // Anything the template did not already contain gets appended so nothing is
  // silently lost.
  const missing = Object.entries(values).filter(([key]) => !applied.has(key));
  if (missing.length > 0) {
    lines.push('', '# Added by `npm run setup`');
    for (const [key, value] of missing) lines.push(`${key}=${value}`);
  }

  return lines.join('\n');
}

function readExistingValue(env: string, key: string): string | undefined {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(env);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

async function main(): Promise<void> {
  process.stdout.write(`\n${BOLD}Birdeye_Cop setup${RESET}\n`);
  process.stdout.write(`${DIM}Ctrl+C to cancel at any point. Safe to re-run.${RESET}\n\n`);

  const hasEnv = existsSync(ENV_PATH);
  // Editing the existing .env preserves any hand-tuned settings; otherwise
  // start from the documented example.
  const template = await readFile(hasEnv ? ENV_PATH : ENV_EXAMPLE, 'utf8');

  if (hasEnv) {
    const { proceed } = await prompts(
      {
        type: 'confirm',
        name: 'proceed',
        message: 'A .env already exists. Update it in place?',
        initial: true,
      },
      { onCancel },
    );
    if (!proceed) onCancel();
  }

  // --- token ---------------------------------------------------------------
  let token = readExistingValue(template, 'DISCORD_TOKEN');
  let me: DiscordUser | undefined;

  for (;;) {
    if (!token) {
      const answer = await prompts(
        {
          type: 'password',
          name: 'token',
          message: 'Discord bot token (Developer Portal → Bot → Reset Token)',
          validate: (v: string) => (v.trim().length > 20 ? true : 'That looks too short'),
        },
        { onCancel },
      );
      token = String(answer.token).trim();
    }

    try {
      me = await api<DiscordUser>('/users/@me', token);
      process.stdout.write(`  ${GREEN}✓${RESET} Authenticated as ${BOLD}@${me.username}${RESET}\n`);
      break;
    } catch (err) {
      process.stdout.write(
        `  ${YELLOW}✗${RESET} That token was rejected (${toError(err).message}).\n`,
      );
      token = undefined;
    }
  }

  // The application ID is the bot user's ID — no reason to make anyone go
  // and copy it separately.
  const clientId = me.id;

  // --- server --------------------------------------------------------------
  let guildIds = '';
  let guild: DiscordGuild | undefined;

  const guilds = await api<DiscordGuild[]>('/users/@me/guilds', token).catch(() => []);

  if (guilds.length === 0) {
    process.stdout.write(
      `\n  ${YELLOW}!${RESET} The bot is not in any server yet. Invite it with the URL below, ` +
        `then re-run setup to finish choosing a log channel.\n`,
    );
  } else {
    const { chosen } = await prompts(
      {
        type: 'select',
        name: 'chosen',
        message: 'Which server should it moderate?',
        choices: [
          ...guilds.map((g) => ({ title: g.name, value: g.id })),
          { title: 'All servers it is in', value: '' },
        ],
      },
      { onCancel },
    );
    guildIds = String(chosen ?? '');
    guild = guilds.find((g) => g.id === guildIds);
  }

  // --- log channel ---------------------------------------------------------
  let logChannelId = readExistingValue(template, 'MODERATION_LOG_CHANNEL_ID') ?? '';

  if (guild) {
    const channels = await api<DiscordChannel[]>(`/guilds/${guild.id}/channels`, token).catch(
      () => [],
    );
    const textChannels = channels
      .filter((c) => c.type === 0)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    if (textChannels.length > 0) {
      const { chosen } = await prompts(
        {
          type: 'select',
          name: 'chosen',
          message: 'Where should moderation reports be posted?',
          choices: textChannels.map((c) => ({ title: `#${c.name}`, value: c.id })),
        },
        { onCancel },
      );
      logChannelId = String(chosen);
    }
  }

  if (!logChannelId) {
    const { typed } = await prompts(
      {
        type: 'text',
        name: 'typed',
        message: 'Moderation log channel ID (right-click the channel → Copy ID)',
        validate: (v: string) => (/^\d{17,20}$/.test(v.trim()) ? true : 'Expected 17-20 digits'),
      },
      { onCancel },
    );
    logChannelId = String(typed).trim();
  }

  // --- speech-to-text ------------------------------------------------------
  const { provider } = await prompts(
    {
      type: 'select',
      name: 'provider',
      message: 'Speech-to-text provider',
      choices: [
        {
          title: 'mock — no credentials, no network (start here)',
          value: 'mock',
        },
        {
          title: 'deepgram — lowest latency, real confidence scores',
          value: 'deepgram',
        },
        {
          title: 'openai — OpenAI, Groq, or a local whisper.cpp server',
          value: 'openai',
        },
      ],
    },
    { onCancel },
  );

  let apiKey = '';
  let baseUrl = '';

  if (provider === 'openai') {
    const { where } = await prompts(
      {
        type: 'select',
        name: 'where',
        message: 'Which OpenAI-compatible endpoint?',
        choices: [
          { title: 'OpenAI', value: 'https://api.openai.com/v1' },
          { title: 'Groq', value: 'https://api.groq.com/openai/v1' },
          { title: 'Local whisper.cpp (http://localhost:8080/v1)', value: 'http://localhost:8080/v1' },
          { title: 'Something else', value: 'custom' },
        ],
      },
      { onCancel },
    );

    baseUrl = String(where);
    if (baseUrl === 'custom') {
      const { url } = await prompts(
        { type: 'text', name: 'url', message: 'Base URL (should end in /v1)' },
        { onCancel },
      );
      baseUrl = String(url).trim();
    }
  }

  if (provider !== 'mock' && !baseUrl.includes('localhost')) {
    const { key } = await prompts(
      {
        type: 'password',
        name: 'key',
        message: `${provider} API key`,
        validate: (v: string) => (v.trim().length > 5 ? true : 'That looks too short'),
      },
      { onCancel },
    );
    apiKey = String(key).trim();
  }

  // --- moderation posture --------------------------------------------------
  const { action } = await prompts(
    {
      type: 'select',
      name: 'action',
      message: 'Most severe action moderation may take',
      choices: [
        { title: 'disconnect — remove from voice (recommended)', value: 'disconnect' },
        { title: 'warn — log and DM only', value: 'warn' },
        { title: 'kick — remove from the server', value: 'kick' },
        { title: 'ban — permanent (requires ALLOW_UNATTENDED_BAN)', value: 'ban' },
      ],
      initial: 0,
    },
    { onCancel },
  );

  const { dryRun } = await prompts(
    {
      type: 'confirm',
      name: 'dryRun',
      message: 'Start in dry-run mode? (log violations without acting)',
      initial: true,
    },
    { onCancel },
  );

  // --- write ---------------------------------------------------------------
  const values: Record<string, string> = {
    DISCORD_TOKEN: token,
    DISCORD_CLIENT_ID: clientId,
    GUILD_IDS: guildIds,
    MODERATION_LOG_CHANNEL_ID: logChannelId,
    STT_PROVIDER: String(provider),
    STT_API_KEY: apiKey,
    STT_BASE_URL: baseUrl === 'custom' ? '' : baseUrl,
    MODERATION_ACTION: String(action),
    DRY_RUN: String(Boolean(dryRun)),
  };

  await writeFile(ENV_PATH, applyValues(template, values), { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`\n  ${GREEN}✓${RESET} Wrote ${ENV_PATH} (mode 600)\n`);

  if (!existsSync(RULES_PATH)) {
    await copyFile(RULES_EXAMPLE, RULES_PATH);
    process.stdout.write(
      `  ${GREEN}✓${RESET} Created ${RULES_PATH} from the example ${DIM}(placeholder rules only)${RESET}\n`,
    );
  } else {
    process.stdout.write(`  ${DIM}·${RESET} ${RULES_PATH} already exists — left alone\n`);
  }

  // --- invite --------------------------------------------------------------
  const permissions = invitePermissions(action as ModerationActionType, false);
  const inviteUrl =
    `https://discord.com/oauth2/authorize?client_id=${clientId}` +
    `&permissions=${permissions.toString()}` +
    `&scope=bot%20applications.commands`;

  process.stdout.write(`\n${BOLD}Invite the bot${RESET}\n`);
  process.stdout.write(`${inviteUrl}\n`);
  process.stdout.write(
    `${DIM}Includes exactly the permissions "${String(action)}" needs, plus the ` +
      `applications.commands scope for slash commands.${RESET}\n`,
  );

  process.stdout.write(`\n${BOLD}Next${RESET}\n`);
  process.stdout.write(`  1. npm run doctor      ${DIM}# verify everything is reachable${RESET}\n`);
  process.stdout.write(`  2. npm run dev         ${DIM}# start the bot${RESET}\n`);
  process.stdout.write(
    `  3. /moderation join    ${DIM}# in a voice channel, to begin monitoring it${RESET}\n\n`,
  );

  if (dryRun) {
    process.stdout.write(
      `${DIM}Dry-run is on: violations are logged but nobody is removed. Watch the log ` +
        `channel for a while, then \`/moderation dry-run false\`.${RESET}\n\n`,
    );
  }

  process.stdout.write(
    `${YELLOW}Before pointing this at real users, read the "Legal and consent" section of the ` +
      `README.${RESET} Recording or transcribing a conversation without informing participants is\n` +
      `unlawful in a number of jurisdictions, regardless of who owns the server.\n\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`\nSetup failed: ${toError(err).message}\n\n`);
  process.exit(1);
});
