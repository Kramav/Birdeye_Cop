/**
 * `npm run doctor` — one command that says what is wrong and how to fix it.
 *
 * Ordered so the cheapest, most common failures surface first. Every failure
 * carries a concrete next step rather than a stack trace, because the people
 * running this are setting up a bot, not debugging TypeScript.
 */
import { access, constants, mkdir, readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { parse } from 'dotenv';
import { loadEnv } from '../config/env.js';
import type { AppConfig } from '../config/types.js';
import { loadRuleset } from '../moderation/rules.js';
import { createProvider } from '../speech/provider-factory.js';
import { STT_SAMPLE_RATE } from '../voice/pcm.js';
import { ConfigError, toError } from '../utils/errors.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[90m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

type Status = 'ok' | 'fail' | 'warn' | 'skip';

interface CheckResult {
  status: Status;
  detail?: string;
  hint?: string;
}

const results: Array<{ name: string; result: CheckResult }> = [];

function report(name: string, result: CheckResult): void {
  results.push({ name, result });
  const icon =
    result.status === 'ok'
      ? `${GREEN}✓${RESET}`
      : result.status === 'fail'
        ? `${RED}✗${RESET}`
        : result.status === 'warn'
          ? `${YELLOW}!${RESET}`
          : `${DIM}-${RESET}`;

  process.stdout.write(`  ${icon} ${name}`);
  if (result.detail) process.stdout.write(` ${DIM}${result.detail}${RESET}`);
  process.stdout.write('\n');
  if (result.hint) process.stdout.write(`      ${YELLOW}→ ${result.hint}${RESET}\n`);
}

function section(title: string): void {
  process.stdout.write(`\n${BOLD}${title}${RESET}\n`);
}

// ---------------------------------------------------------------------------

function checkNodeVersion(): CheckResult {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = major > 22 || (major === 22 && minor >= 12);
  return ok
    ? { status: 'ok', detail: `v${process.versions.node}` }
    : {
        status: 'fail',
        detail: `v${process.versions.node}`,
        hint: '@discordjs/voice requires Node >= 22.12. Install a newer Node and reinstall.',
      };
}

/**
 * Native and near-native modules — the single most common install failure.
 */
async function checkModule(
  name: string,
  required: boolean,
  fallbackNote?: string,
): Promise<CheckResult> {
  try {
    await import(name);
    return { status: 'ok' };
  } catch (err) {
    const message = toError(err).message.split('\n')[0];
    if (!required) {
      return { status: 'warn', detail: message.slice(0, 80), hint: fallbackNote };
    }
    return {
      status: 'fail',
      detail: message.slice(0, 80),
      hint:
        'Reinstall with build tools available: ' +
        '`sudo apt install -y build-essential python3` then `npm ci`.',
    };
  }
}

/**
 * dotenv swallows every read error, so a missing or unreadable .env looks
 * exactly like an empty one. Must run before loadEnv() mutates process.env.
 */
async function checkEnvFile(): Promise<CheckResult> {
  const path = resolve('.env');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        status: 'warn',
        detail: `not found at ${path}`,
        hint: 'Run `npm run setup` in this directory, or supply the variables through the environment.',
      };
    }
    return {
      status: 'fail',
      detail: `${code ?? toError(err).message}: ${path}`,
      hint:
        `User "${userInfo().username}" cannot read it — setup was probably run as a different user ` +
        '(e.g. root instead of `sudo -u birdeye`). Fix its owner, or re-run setup as this user.',
    };
  }

  // dotenv never overrides a variable that is already set, even to "".
  const shadowed = Object.entries(parse(text))
    .filter(([key, value]) => process.env[key] !== undefined && process.env[key] !== value)
    .map(([key]) => key);
  if (shadowed.length > 0) {
    return {
      status: 'warn',
      detail: `ignored for ${shadowed.join(', ')}`,
      hint: 'Already set in the shell environment, which takes precedence over .env. Unset them.',
    };
  }
  return { status: 'ok', detail: path };
}

async function checkDiscordToken(config: AppConfig): Promise<CheckResult> {
  try {
    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${config.discord.token}` },
    });

    if (response.status === 401) {
      return {
        status: 'fail',
        detail: '401 Unauthorized',
        hint: 'DISCORD_TOKEN is wrong or was reset. Developer Portal → Bot → Reset Token.',
      };
    }
    if (!response.ok) {
      return { status: 'fail', detail: `HTTP ${response.status}` };
    }

    const me = (await response.json()) as { id: string; username: string };
    if (me.id !== config.discord.clientId) {
      return {
        status: 'fail',
        detail: `token belongs to ${me.id}`,
        hint: `DISCORD_CLIENT_ID is ${config.discord.clientId} but the token is for ${me.id}. Use the Application ID from General Information.`,
      };
    }
    return { status: 'ok', detail: `@${me.username}` };
  } catch (err) {
    return {
      status: 'fail',
      detail: toError(err).message.slice(0, 80),
      hint: 'Could not reach discord.com. Check network access and DNS from this host.',
    };
  }
}

async function checkGuilds(config: AppConfig): Promise<CheckResult> {
  try {
    const response = await fetch('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bot ${config.discord.token}` },
    });
    if (!response.ok) return { status: 'fail', detail: `HTTP ${response.status}` };

    const guilds = (await response.json()) as Array<{ id: string; name: string }>;
    if (guilds.length === 0) {
      return {
        status: 'fail',
        detail: 'not in any server',
        hint: 'Invite the bot using the URL printed by `npm run setup`.',
      };
    }

    const configured = config.discord.guildIds;
    if (configured.length > 0) {
      const missing = configured.filter((id) => !guilds.some((g) => g.id === id));
      if (missing.length > 0) {
        return {
          status: 'fail',
          detail: `not in ${missing.join(', ')}`,
          hint: 'GUILD_IDS lists servers the bot has not been invited to.',
        };
      }
    }

    return { status: 'ok', detail: `${guilds.length} server(s)` };
  } catch (err) {
    return { status: 'fail', detail: toError(err).message.slice(0, 80) };
  }
}

async function checkLogChannel(config: AppConfig): Promise<CheckResult> {
  const id = config.discord.moderationLogChannelId;
  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${id}`, {
      headers: { Authorization: `Bot ${config.discord.token}` },
    });

    if (response.status === 404) {
      return {
        status: 'fail',
        detail: 'not found',
        hint: `MODERATION_LOG_CHANNEL_ID=${id} does not exist, or the bot cannot see it.`,
      };
    }
    if (response.status === 403) {
      return {
        status: 'fail',
        detail: '403 Forbidden',
        hint: 'The bot lacks View Channel there. Grant it, or pick another channel.',
      };
    }
    if (!response.ok) return { status: 'fail', detail: `HTTP ${response.status}` };

    const channel = (await response.json()) as { name?: string; type: number };
    if (channel.type !== 0 && channel.type !== 5) {
      return {
        status: 'fail',
        detail: `type ${channel.type}`,
        hint: 'The moderation log channel must be a text or announcement channel.',
      };
    }
    return { status: 'ok', detail: `#${channel.name ?? id}` };
  } catch (err) {
    return { status: 'fail', detail: toError(err).message.slice(0, 80) };
  }
}

/**
 * A live transcription call.
 *
 * Worth the fraction of a cent: a wrong key, a wrong base URL, or a local
 * whisper server that is not running are all invisible until the first person
 * speaks, and by then the failure looks like "the bot doesn't work".
 */
async function checkSttProvider(config: AppConfig): Promise<CheckResult> {
  if (config.stt.provider === 'mock') {
    return { status: 'skip', detail: 'mock provider — nothing to reach' };
  }

  try {
    const provider = createProvider(config.stt.provider, {
      model: config.stt.model,
      ...(config.stt.apiKey ? { apiKey: config.stt.apiKey } : {}),
      ...(config.stt.baseUrl ? { baseUrl: config.stt.baseUrl } : {}),
    });

    // Half a second of near-silence: enough to be a valid request, cheap
    // enough to be free in practice.
    const pcm = new Int16Array(STT_SAMPLE_RATE / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 20) * 200);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);

    try {
      const result = await provider.transcribe({
        pcm,
        sampleRate: STT_SAMPLE_RATE,
        model: config.stt.model,
        signal: controller.signal,
      });
      return {
        status: 'ok',
        detail: `${config.stt.provider}/${result.model} responded in ${result.durationMs}ms`,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const message = toError(err).message;
    let hint = 'Check STT_API_KEY and STT_BASE_URL.';
    if (/401|403|unauthor/i.test(message)) hint = 'STT_API_KEY appears to be invalid.';
    else if (/ECONNREFUSED|fetch failed/i.test(message)) {
      hint = config.stt.baseUrl?.includes('localhost')
        ? `Nothing is listening at ${config.stt.baseUrl}. Start it with \`npm run whisper\`, or switch STT_PROVIDER=mock.`
        : 'Could not reach the speech-to-text endpoint from this host.';
    } else if (/404/.test(message)) {
      hint = config.stt.baseUrl?.includes('localhost')
        ? 'whisper-server needs `--inference-path /v1/audio/transcriptions`. Start it with `npm run whisper`.'
        : `STT_BASE_URL may be wrong. It should end in /v1 (currently ${config.stt.baseUrl ?? 'unset'}).`;
    } else if (/model/i.test(message)) {
      hint = `The model "${config.stt.model}" may not exist for this provider.`;
    }
    return { status: 'fail', detail: message.slice(0, 100), hint };
  }
}

async function checkWritableDir(path: string, label: string): Promise<CheckResult> {
  const target = resolve(path);
  try {
    await mkdir(target, { recursive: true, mode: 0o700 });
    await access(target, constants.W_OK);
    const info = await stat(target);
    const mode = (info.mode & 0o777).toString(8);
    return { status: 'ok', detail: `${target} (mode ${mode})` };
  } catch (err) {
    return {
      status: 'fail',
      detail: toError(err).message.slice(0, 80),
      hint: `Cannot write to ${label} at ${target}. In an unprivileged LXC this is usually a uid/gid mapping problem.`,
    };
  }
}

async function checkRules(config: AppConfig): Promise<CheckResult> {
  try {
    const ruleset = await loadRuleset(config.moderation.rulesPath);
    const enabled = ruleset.rules.filter((r) => r.enabled).length;
    if (enabled === 0) {
      return {
        status: 'warn',
        detail: '0 enabled rules',
        hint: 'Nothing will ever match. Add rules with `/moderation add` or edit the config file.',
      };
    }
    return { status: 'ok', detail: `${enabled} enabled rule(s)` };
  } catch (err) {
    return {
      status: 'fail',
      detail: toError(err).message.split('\n')[0].slice(0, 100),
      hint: `Copy config/moderation.example.json to ${config.moderation.rulesPath}.`,
    };
  }
}

function checkVerifyModel(config: AppConfig): CheckResult {
  if (config.stt.weakVerify) {
    return {
      status: 'warn',
      detail: `verify uses the same model (${config.stt.verifyModel})`,
      hint:
        'Re-running identical audio through identical weights reproduces the same mistake, so ' +
        'low-confidence confirmation is weaker than it looks. Set STT_VERIFY_MODEL to a different model.',
    };
  }
  return { status: 'ok', detail: `${config.stt.model} → ${config.stt.verifyModel}` };
}

function checkSafetyPosture(config: AppConfig): CheckResult {
  const risky: string[] = [];
  if (!config.moderation.dryRun) risky.push('DRY_RUN=false');
  if (config.moderation.allowUnattendedBan) risky.push('ALLOW_UNATTENDED_BAN=true');
  if (!config.privacy.requireMonitoringNotice) risky.push('REQUIRE_MONITORING_NOTICE=false');
  if (config.evidence.enabled) risky.push('VIOLATION_AUDIO_LOGGING=true');

  if (risky.length === 0) return { status: 'ok', detail: 'conservative defaults' };

  return {
    status: 'warn',
    detail: risky.join(', '),
    hint: 'These settings act on real users or retain personal data. See the README legal section.',
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write(`\n${BOLD}Birdeye_Cop — diagnostics${RESET}\n`);

  section('Runtime');
  report('Node version', checkNodeVersion());
  report(
    'prism-media (Opus streams)',
    await checkModule('prism-media', true),
  );
  report(
    '@snazzah/davey (Discord E2EE)',
    await checkModule(
      '@snazzah/davey',
      true,
    ),
  );
  report(
    '@discordjs/opus (native decoder)',
    await checkModule(
      '@discordjs/opus',
      false,
      'Optional. Falls back to the pure-JS opusscript decoder, which costs noticeably more CPU per speaker.',
    ),
  );
  report(
    'opusscript (fallback decoder)',
    await checkModule('opusscript', false, 'Optional, but the only fallback if @discordjs/opus is missing.'),
  );
  report(
    'better-sqlite3 (storage)',
    await checkModule(
      'better-sqlite3',
      false,
      'Optional. Storage falls back to JSONL, which works but has no indexes.',
    ),
  );

  section('Configuration');
  report('.env file', await checkEnvFile());
  let config: AppConfig;
  try {
    config = loadEnv();
    report('.env parses', { status: 'ok' });
  } catch (err) {
    if (err instanceof ConfigError) {
      report('.env parses', {
        status: 'fail',
        detail: 'invalid',
        hint: 'Run `npm run setup`, or fix the problems below.',
      });
      process.stdout.write(`\n${err.message}\n`);
    } else {
      report('.env parses', { status: 'fail', detail: toError(err).message.slice(0, 100) });
    }
    printSummary();
    process.exit(1);
  }

  report('Moderation rules', await checkRules(config));
  report('Verify model independence', checkVerifyModel(config));
  report('Safety posture', checkSafetyPosture(config));

  section('Filesystem');
  report('Database directory', await checkWritableDir(dirname(config.storage.databasePath), 'DATABASE_PATH'));
  if (config.evidence.enabled) {
    report(
      'Evidence directory',
      await checkWritableDir(config.evidence.directory, 'VIOLATION_AUDIO_DIRECTORY'),
    );
  } else {
    report('Evidence directory', { status: 'skip', detail: 'violation audio logging disabled' });
  }

  section('Discord');
  report('Bot token', await checkDiscordToken(config));
  report('Server membership', await checkGuilds(config));
  report('Moderation log channel', await checkLogChannel(config));

  section('Speech-to-text');
  report('Provider reachable', await checkSttProvider(config));

  section('Voice receive');
  report('Receive smoke test', {
    status: 'skip',
    detail: 'requires a live voice channel',
    hint:
      'Run `npm run spike:voice` with two people in a voice channel. Discord does not document ' +
      'voice receive, so this is the one check that cannot be done offline.',
  });

  printSummary();
}

function printSummary(): void {
  const failed = results.filter((r) => r.result.status === 'fail');
  const warned = results.filter((r) => r.result.status === 'warn');

  process.stdout.write('\n');
  if (failed.length === 0) {
    process.stdout.write(
      `${GREEN}${BOLD}All checks passed${RESET}` +
        (warned.length ? ` ${YELLOW}(${warned.length} warning(s))${RESET}` : '') +
        '\n\n',
    );
    return;
  }

  process.stdout.write(`${RED}${BOLD}${failed.length} check(s) failed:${RESET}\n`);
  for (const { name } of failed) process.stdout.write(`  ${RED}✗${RESET} ${name}\n`);
  process.stdout.write('\n');
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\nDoctor failed unexpectedly: ${toError(err).stack ?? ''}\n`);
  process.exit(1);
});
