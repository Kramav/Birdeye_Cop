/**
 * `npm run doctor` — one command that says what is wrong and how to fix it.
 *
 * Ordered so the cheapest, most common failures surface first. Every failure
 * carries numbered steps rather than a stack trace, because the people
 * running this are setting up a bot, not debugging TypeScript.
 */
import { access, constants, mkdir, readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { parse } from 'dotenv';
import { invitePermissions } from '../bot/permissions.js';
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
  /** Numbered, copy-pasteable fix. */
  steps?: string[];
}

const results: Array<{ name: string; result: CheckResult }> = [];
const ENV_PATH = resolve('.env');
const RERUN = 'Re-run `npm run doctor`.';
let botName = 'the bot';

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
  result.steps?.forEach((step, i) => process.stdout.write(`        ${i + 1}. ${step}\n`));
}

function section(title: string): void {
  process.stdout.write(`\n${BOLD}${title}${RESET}\n`);
}

async function discordGet<T>(path: string, token: string): Promise<T | undefined> {
  try {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    return response.ok ? ((await response.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

function inviteUrl(config: AppConfig): string {
  const permissions = invitePermissions(
    config.moderation.actionCeiling,
    config.evidence.allowDiscordUpload,
  );
  return (
    `https://discord.com/oauth2/authorize?client_id=${config.discord.clientId}` +
    `&permissions=${permissions.toString()}&scope=bot%20applications.commands`
  );
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
        hint: '@discordjs/voice requires Node >= 22.12.',
        steps: [
          'Easiest on Debian/Ubuntu: `sudo bash scripts/install.sh` (installs Node 22 for you). Or by hand:',
          '`sudo apt remove -y nodejs npm libnode-dev`',
          '`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -` then `sudo apt install -y nodejs`',
          '`hash -r && node -v` — must print v22.12 or newer.',
          '`rm -rf node_modules && npm ci`, then ' + RERUN,
        ],
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
      hint: `${name} did not install or build correctly.`,
      steps: [
        'Install the build tools: `sudo apt install -y build-essential python3`',
        'Reinstall dependencies: `rm -rf node_modules && npm ci`',
        'If npm printed "install-scripts ... blocked", run `npm rebuild` (see README → Troubleshooting).',
        RERUN,
      ],
    };
  }
}

/**
 * dotenv swallows every read error, so a missing or unreadable .env looks
 * exactly like an empty one. Must run before loadEnv() mutates process.env.
 */
async function checkEnvFile(): Promise<CheckResult> {
  const user = userInfo().username;
  let text: string;
  try {
    text = await readFile(ENV_PATH, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        status: 'warn',
        detail: `not found at ${ENV_PATH}`,
        hint: 'Fine if the variables come from the environment (Docker, systemd); otherwise create it.',
        steps: [
          `\`cd ${dirname(ENV_PATH)}\``,
          `\`npm run setup\` — on a systemd install: \`sudo -u birdeye npm run setup\``,
          RERUN,
        ],
      };
    }
    return {
      status: 'fail',
      detail: `${code ?? toError(err).message}: ${ENV_PATH}`,
      hint: `User "${user}" cannot read it — setup was probably run as a different user.`,
      steps: [
        `See who owns it: \`ls -l ${ENV_PATH}\``,
        `Give it to "${user}": \`sudo chown ${user} ${ENV_PATH} && sudo chmod 600 ${ENV_PATH}\``,
        RERUN,
      ],
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
      hint: 'These are already set in your shell, and the shell wins over .env.',
      steps: [
        `\`unset ${shadowed.join(' ')}\``,
        'If they come back in new terminals, remove the `export` lines from ~/.bashrc or ~/.profile.',
        RERUN,
      ],
    };
  }
  return { status: 'ok', detail: ENV_PATH };
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
        hint: 'DISCORD_TOKEN is wrong, or was reset in the Developer Portal.',
        steps: [
          'Open https://discord.com/developers/applications → your app → Bot.',
          'Click Reset Token and copy the new token (it is only shown once).',
          `Put it in ${ENV_PATH} as \`DISCORD_TOKEN=...\` — or re-run \`npm run setup\`, which asks for it.`,
          RERUN,
        ],
      };
    }
    if (!response.ok) {
      return {
        status: 'fail',
        detail: `HTTP ${response.status}`,
        hint: 'Discord returned an unexpected error. Check https://discordstatus.com, then ' + RERUN,
      };
    }

    const me = (await response.json()) as { id: string; username: string };
    botName = `@${me.username}`;
    if (me.id !== config.discord.clientId) {
      return {
        status: 'fail',
        detail: `token belongs to ${me.id}`,
        hint: 'DISCORD_CLIENT_ID does not match the application this token belongs to.',
        steps: [`In ${ENV_PATH}, set \`DISCORD_CLIENT_ID=${me.id}\``, RERUN],
      };
    }
    return { status: 'ok', detail: botName };
  } catch (err) {
    return {
      status: 'fail',
      detail: toError(err).message.slice(0, 80),
      hint: 'Could not reach discord.com from this host.',
      steps: [
        'Test DNS: `getent hosts discord.com` — no output means DNS is broken on this host.',
        'Test HTTPS: `curl -sI https://discord.com/api/v10/gateway` — expect `HTTP/2 200`.',
        'In an LXC or VM, check its network and DNS settings on the host side.',
        RERUN,
      ],
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
    const invite = [
      `Open this invite link: ${inviteUrl(config)}`,
      'Pick your server and click Authorize (you need Manage Server there).',
      RERUN,
    ];
    if (guilds.length === 0) {
      return {
        status: 'fail',
        detail: 'not in any server',
        hint: `${botName} has not been invited anywhere yet.`,
        steps: invite,
      };
    }

    const configured = config.discord.guildIds;
    if (configured.length > 0) {
      const missing = configured.filter((id) => !guilds.some((g) => g.id === id));
      if (missing.length > 0) {
        return {
          status: 'fail',
          detail: `not in ${missing.join(', ')}`,
          hint: `GUILD_IDS lists servers ${botName} is not in. Either invite it, or remove those IDs.`,
          steps: [
            ...invite.slice(0, 2),
            `Or edit GUILD_IDS in ${ENV_PATH}. Servers it is in: ${guilds.map((g) => `${g.name} (${g.id})`).join(', ')}`,
            RERUN,
          ],
        };
      }
    }

    return { status: 'ok', detail: `${guilds.length} server(s)` };
  } catch (err) {
    return { status: 'fail', detail: toError(err).message.slice(0, 80) };
  }
}

/** Guild channel lists include channels the bot cannot open, so this names them. */
async function locateChannel(
  token: string,
  channelId: string,
): Promise<{ name: string; guildId: string; guildName: string } | undefined> {
  const guilds = (await discordGet<Array<{ id: string; name: string }>>('/users/@me/guilds', token)) ?? [];
  for (const guild of guilds) {
    const channels = await discordGet<Array<{ id: string; name: string }>>(`/guilds/${guild.id}/channels`, token);
    const channel = channels?.find((c) => c.id === channelId);
    if (channel) return { name: channel.name, guildId: guild.id, guildName: guild.name };
  }
  return undefined;
}

const CHANNEL_TYPE_NAMES: Record<number, string> = {
  2: 'a voice channel',
  4: 'a category',
  13: 'a stage channel',
  15: 'a forum',
  16: 'a media channel',
};

async function checkLogChannel(config: AppConfig): Promise<CheckResult> {
  const id = config.discord.moderationLogChannelId;
  const pickAnother = [
    'In Discord: User Settings → Advanced → turn on Developer Mode.',
    'Right-click the text channel you want reports in → Copy Channel ID.',
    `In ${ENV_PATH}, set \`MODERATION_LOG_CHANNEL_ID=<that ID>\` — or re-run \`npm run setup\` and pick from the list.`,
    RERUN,
  ];
  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${id}`, {
      headers: { Authorization: `Bot ${config.discord.token}` },
    });

    if (response.status === 404) {
      return {
        status: 'fail',
        detail: 'not found',
        hint: `No channel with ID ${id} exists — it was deleted, or the ID was mistyped.`,
        steps: pickAnother,
      };
    }
    if (response.status === 403) {
      const where = await locateChannel(config.discord.token, id);
      const perms = ['View Channel', 'Send Messages', 'Embed Links'];
      if (config.evidence.allowDiscordUpload) perms.push('Attach Files');
      return {
        status: 'fail',
        detail: '403 Forbidden',
        hint: where
          ? `${botName} cannot see #${where.name} in "${where.guildName}" — it is private, or its permissions hide it from the bot.`
          : `${botName} cannot see channel ${id} — it is private, or its permissions hide it from the bot.`,
        steps: [
          where
            ? `Open the channel in Discord: https://discord.com/channels/${where.guildId}/${id}`
            : `Find the channel: Discord search, or paste ${id} after enabling Developer Mode.`,
          'Right-click the channel name in the sidebar → Edit Channel → Permissions.',
          `Private channel: click "Add members or roles". Otherwise: click + next to "Roles/Members" under Advanced permissions. Choose ${botName} (or the role with the same name).`,
          `Set these to ✓ (green): ${perms.join(', ')}. Click Save Changes.`,
          'Or skip 1–4 and use a channel the bot can already see: re-run `npm run setup` and pick it.',
          RERUN,
        ],
      };
    }
    if (!response.ok) return { status: 'fail', detail: `HTTP ${response.status}` };

    const channel = (await response.json()) as { name?: string; type: number };
    if (channel.type !== 0 && channel.type !== 5) {
      return {
        status: 'fail',
        detail: `type ${channel.type}`,
        hint: `#${channel.name ?? id} is ${CHANNEL_TYPE_NAMES[channel.type] ?? 'not a text channel'}. Reports need a text or announcement channel.`,
        steps: pickAnother,
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
    const baseUrl = config.stt.baseUrl ?? 'unset';
    const local = config.stt.baseUrl?.includes('localhost') ?? false;
    const keyPage =
      config.stt.provider === 'deepgram'
        ? 'https://console.deepgram.com → API Keys'
        : baseUrl.includes('groq')
          ? 'https://console.groq.com/keys'
          : 'https://platform.openai.com/api-keys';
    const whisperSteps = [
      'systemd install: `systemctl status birdeye-whisper`. Not running? `sudo systemctl start birdeye-whisper`, and read why it stopped with `journalctl -u birdeye-whisper -n 50`.',
      'Not installed as a service? `sudo WITH_WHISPER=1 bash scripts/install.sh`, or run `npm run whisper` in another terminal and wait for "whisper server listening".',
      `The port in STT_BASE_URL (${baseUrl}) must match the server's port (default 8080).`,
      RERUN,
    ];

    let hint = 'Check STT_API_KEY and STT_BASE_URL.';
    let steps: string[] | undefined;
    if (/401|403|unauthor/i.test(message)) {
      hint = `STT_API_KEY was rejected by ${config.stt.provider}.`;
      steps = [`Create a key at ${keyPage}.`, `In ${ENV_PATH}, set \`STT_API_KEY=<key>\``, RERUN];
    } else if (/ECONNREFUSED|fetch failed/i.test(message)) {
      if (local) {
        hint = `Nothing is listening at ${baseUrl}.`;
        steps = whisperSteps;
      } else {
        hint = `Could not reach ${baseUrl} from this host.`;
        steps = [`Test it: \`curl -sI ${baseUrl}\``, 'Check STT_BASE_URL for typos, and this host\'s network/DNS.', RERUN];
      }
    } else if (/404/.test(message)) {
      if (local) {
        hint = 'The server is up but not on the path the bot uses — started without `--inference-path /v1/audio/transcriptions`.';
        steps = [
          'Stop the hand-started server: `pkill -f whisper-server`',
          'Start it the supported way (sets the path for you):',
          ...whisperSteps,
        ];
      } else {
        hint = `STT_BASE_URL looks wrong (currently ${baseUrl}).`;
        steps = [
          `In ${ENV_PATH}, set STT_BASE_URL to one of: https://api.openai.com/v1, https://api.groq.com/openai/v1 — it must end in /v1.`,
          RERUN,
        ];
      }
    } else if (/model/i.test(message)) {
      hint = `The model "${config.stt.model}" may not exist for this provider.`;
      steps = [
        `In ${ENV_PATH}, set STT_MODEL — openai: gpt-4o-mini-transcribe, groq: whisper-large-v3, deepgram: nova-3, local whisper: base.en`,
        RERUN,
      ];
    }
    return { status: 'fail', detail: message.slice(0, 100), hint, ...(steps ? { steps } : {}) };
  }
}

async function checkWritableDir(path: string, label: string): Promise<CheckResult> {
  const target = resolve(path);
  const user = userInfo().username;
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
      hint: `User "${user}" cannot write ${label} at ${target}.`,
      steps: [
        `See who owns it: \`ls -ld ${target}\``,
        `Give it to "${user}": \`sudo mkdir -p ${target} && sudo chown -R ${user} ${target} && sudo chmod 700 ${target}\``,
        'Still failing in an unprivileged LXC? The container uid is mapped to a different host uid — run the chown inside the container, not on the Proxmox host.',
        `Or point ${label} somewhere "${user}" can write, in ${ENV_PATH}.`,
        RERUN,
      ],
    };
  }
}

async function checkRules(config: AppConfig): Promise<CheckResult> {
  const path = config.moderation.rulesPath;
  try {
    const ruleset = await loadRuleset(path);
    const enabled = ruleset.rules.filter((r) => r.enabled);
    const addWords = [
      'In Discord, once the bot is running: `/moderation add term:<word or phrase>` — active immediately.',
      '`/moderation list` shows rule IDs; `/moderation remove term:<ID>` deletes one (e.g. the `example-*` placeholders).',
      `Or edit ${path} by hand (format: README → Banned words), then restart the bot.`,
    ];
    if (enabled.length === 0) {
      return { status: 'warn', detail: '0 enabled rules', hint: 'Nothing will ever match.', steps: addWords };
    }
    if (enabled.every((r) => r.id.startsWith('example-'))) {
      return {
        status: 'warn',
        detail: `only the ${enabled.length} example placeholder rule(s)`,
        hint: 'These match made-up words like BANNEDWORDONE, so nothing real will ever match.',
        steps: addWords,
      };
    }
    return { status: 'ok', detail: `${enabled.length} enabled rule(s)` };
  } catch (err) {
    return {
      status: 'fail',
      detail: toError(err).message.split('\n')[0].slice(0, 100),
      hint: `The rules file at ${path} is missing or invalid.`,
      steps: [
        `Missing: \`cp config/moderation.example.json ${path}\``,
        `Invalid: the error above names the problem — fix it in ${path}, or restore the example (this discards your rules).`,
        RERUN,
      ],
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
        'low-confidence confirmation is weaker than it looks.',
      steps: [`In ${ENV_PATH}, set STT_VERIFY_MODEL to a different model than ${config.stt.model}.`],
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
        hint: 'Each problem is listed below.',
        steps: [`Open ${ENV_PATH} and fix each listed variable — or re-run \`npm run setup\`.`, RERUN],
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
  process.stdout.write(
    `\n${DIM}Follow the numbered steps under each ✗ above. After changing .env, restart a running ` +
      `bot so it picks up the change: \`sudo systemctl restart birdeye-cop\` (or stop and re-run \`npm run dev\`).${RESET}\n\n`,
  );
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\nDoctor failed unexpectedly: ${toError(err).stack ?? ''}\n`);
  process.exit(1);
});
