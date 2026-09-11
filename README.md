# Birdeye_Cop

A Discord bot that listens to voice channels, transcribes **each speaker
separately**, checks what they said against a configurable list of prohibited
terms, and takes a moderation action against the person who said it.

It is built around one requirement above all others: **never moderate the wrong
person.** Audio is never mixed before recognition, a speaker's identity is
stamped once at capture and re-asserted before any action, and every failure
mode — an unavailable transcription service, a saturated queue, a disagreeing
second opinion — resolves to doing nothing rather than guessing.

> ⚠️ **Read [Legal and consent](#legal-and-consent) before pointing this at real
> people.** Transcribing a conversation without informing the participants is
> unlawful in a number of jurisdictions regardless of who owns the server, and
> Discord now tells users their voice calls are end-to-end encrypted.

---

## Contents

- [Quickstart](#quickstart)
- [Discord Developer Portal setup](#discord-developer-portal-setup)
- [Speech-to-text providers](#speech-to-text-providers)
- [Running locally](#running-locally)
- [Deployment](#deployment)
- [Commands](#commands)
- [How moderation decides](#how-moderation-decides)
- [Configuration reference](#configuration-reference)
- [Violation audio evidence](#violation-audio-evidence)
- [Legal and consent](#legal-and-consent)
- [Privacy and data flow](#privacy-and-data-flow)
- [Discord voice receive limitations](#discord-voice-receive-limitations)
- [Architecture](#architecture)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

---

## Quickstart

**Deploying to a server, a Raspberry Pi, or any Debian/Ubuntu box? Skip this
section — run [`sudo ./scripts/install.sh`](#systemd) instead.** It installs the
right Node version, the build toolchain, a service user, and a systemd unit. The
manual steps below assume Node >= 22.12 is already correct on your machine;
distro packages usually give you something older (see
[Node version](#node-version)).

For a first look on your own laptop — roughly five minutes, no credentials
needed:

```bash
git clone <this repo> && cd Birdeye_Cop
node -v            # must be >= 22.12, or npm install will fight you
npm install
npm run setup      # validates your token live, prints an invite URL
npm run doctor     # ✓/✗ checklist with a fix for every failure
npm run dev
```

Then, in Discord, join a voice channel and run `/moderation join`.

The setup wizard reads your application ID from the token, lists your servers
and channels rather than making you copy IDs, and defaults to the `mock`
transcription provider — so you can have a working bot before signing up for
anything. It starts in **dry-run mode**: violations are logged, nobody is
removed.

When you are happy with what the log channel shows, run
`/moderation dry-run false`.

---

## Discord Developer Portal setup

1. Go to <https://discord.com/developers/applications> and **New Application**.
2. **Bot → Reset Token** → copy it. This is `DISCORD_TOKEN`. Treat it like a
   password; anyone holding it controls the bot.
3. **Privileged Gateway Intents:** leave them all **off**. This bot needs only
   the non-privileged `Guilds` and `GuildVoiceStates` intents. It deliberately
   does not request Message Content — it cannot read your messages.
4. **General Information → Privacy Policy URL:** required by Discord's
   Developer Policy. Publish [`docs/PRIVACY.md`](docs/PRIVACY.md) and paste the
   link.
5. **Invite the bot.** `npm run setup` prints a URL with exactly the permissions
   your chosen action needs. To build one by hand, use scopes
   `bot applications.commands` and these permissions:

   | Permission | Why |
   | --- | --- |
   | View Channel | See the voice and log channels |
   | Connect | Join voice channels |
   | Speak | Transmit the silence keepalive frame ([why](#discord-voice-receive-limitations)) |
   | Send Messages | Post the monitoring notice, and the moderation log |
   | Embed Links | Moderation report embeds |
   | Move Members | Required for the `disconnect` action |
   | Kick Members | Required for `kick` |
   | Ban Members | Required for `ban` |
   | Attach Files | Only if `EVIDENCE_ALLOW_DISCORD_UPLOAD=true` |

   Grant only what your configured `MODERATION_ACTION` needs. The bot verifies
   its permissions at startup and downgrades the action rather than silently
   failing to moderate.

6. **Role position matters.** Discord refuses to disconnect, kick, or ban anyone
   whose highest role sits at or above the bot's. Drag the bot's role above the
   roles it needs to act on. It cannot moderate the server owner, ever.

---

## Speech-to-text providers

Set with `STT_PROVIDER`. All three are interchangeable behind one interface, so
switching is a config change, not a code change.

### `mock` — no credentials

Returns scripted results. Use it to verify the Discord half of the setup, run
the tests, or demo dry-run behaviour without spending anything.

### `deepgram` — lowest latency, real confidence scores

```env
STT_PROVIDER=deepgram
STT_API_KEY=<your key>
STT_MODEL=nova-3
```

Raw PCM is posted directly, so there is no container-encoding step in the
latency path. Deepgram is the only supported provider that returns a genuine
per-word confidence score, which is what `CONFIDENCE_THRESHOLD` is really meant
to compare against. Roughly 0.2–0.5s per segment.

### `openai` — OpenAI, Groq, **or a local Whisper server**

This one provider covers three very different deployments, because they all
speak the same `/audio/transcriptions` API.

```env
# OpenAI
STT_PROVIDER=openai
STT_BASE_URL=https://api.openai.com/v1
STT_API_KEY=sk-...
STT_MODEL=gpt-4o-mini-transcribe

# Groq
STT_BASE_URL=https://api.groq.com/openai/v1

# Local whisper.cpp — no key, no audio ever leaves your network
STT_BASE_URL=http://localhost:8080/v1
STT_MODEL=base.en
```

For a fully local setup, [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
ships `whisper-server`, which exposes an OpenAI-compatible endpoint:

```bash
./build/bin/whisper-server -m models/ggml-base.en.bin --port 8080
```

Confidence is derived from log-probabilities and the model's own
`no_speech_prob`, which is weaker than a native score but usable.

### The verify pass

When a match arrives below `CONFIDENCE_THRESHOLD`, the same audio is
re-transcribed with `STT_VERIFY_MODEL` and the action only proceeds if **both
passes match the same rule**.

Left unset, a different model is chosen automatically (`gpt-4o-mini-transcribe`
→ `gpt-4o-transcribe`, `nova-3` → `nova-2`, `base.en` → `small.en`). This is
not a detail: re-running identical audio through identical weights reproduces
the same systematic error, so "both passes agreed" would prove almost nothing.
If the bot cannot find a different model it starts anyway but warns loudly, and
`/moderation status` shows the weakened guarantee.

A good pairing on modest hardware is a cheap local model for the first pass and
a cloud model for verification — the expensive call then only happens on the
rare ambiguous segment.

---

## Running locally

```bash
npm run dev          # tsx, watch mode
npm run build        # compile to dist/
npm start            # run the compiled output
npm test             # 337 tests
npm run typecheck
npm run lint
npm run doctor       # diagnose a broken setup
npm run spike:voice -- <voiceChannelId>   # prove voice receive works
```

### Node version

**Requires Node >= 22.12** (`@discordjs/voice` enforces this).

Every Debian-family distro — including Raspberry Pi OS — ships something older
and will happily install it: Bookworm's `nodejs` is 18. Worse, `apt install npm`
pulls that old `nodejs` in as a dependency, so it shadows any newer Node you
installed afterwards. `scripts/install.sh` handles all of this; if you are doing
it by hand:

```bash
sudo apt remove -y nodejs npm libnode-dev        # remove the apt Node first
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
hash -r && node -v && which -a node npm          # one path each, v22.12+
```

npm ships inside Node — never `apt install npm` again.

On ARM, check `uname -m` first: `aarch64` works with the above. `armv7l` (32-bit
Pi OS) may have no NodeSource candidate — use [nvm](https://github.com/nvm-sh/nvm)
and `nvm install 22`. `armv6l` (Pi Zero W, Pi 1) has no official Node past v11;
use a 64-bit-capable Pi. ARM also has no prebuilt binaries for the optional
native modules, so install `build-essential` and `python3` before `npm ci` if you
want them.

---

## Deployment

### Docker (recommended)

The image bakes in the build toolchain, so the native modules never compile on
your server — which on an older machine is the difference between a working
install and an afternoon of build errors.

```bash
cp .env.example .env    # or run `npm run setup` first
docker compose up -d
docker compose logs -f
```

Named volumes hold the rules file, the database, and any evidence audio. No
ports are published: the bot exposes no network service, by design.

### Proxmox

Both an LXC container and a VM work, and the bot itself needs nothing special —
Discord voice is pure network, so there is no host audio device to pass through.

**Prefer an unprivileged LXC**, especially if you might later run local Whisper
on a GPU:

- GPU access in LXC is a bind-mount of `/dev/dri` plus a cgroup device rule. The
  host keeps the driver; there is no VFIO, no IOMMU groups, and no
  `vfio-pci` binding to get wrong. On older consumer boards, PCI passthrough to
  a VM is frequently broken outright, so this is usually the only path that
  works.
- The classic gotcha is idmapping: in an unprivileged container the `render` and
  `video` group GIDs must be mapped through, or the device nodes are present but
  unusable.
- Running **Docker inside LXC** needs `features: nesting=1,keyctl=1` on the
  container. If you would rather avoid that, use the systemd path below.

A sensible split is to run the bot in one container with no GPU at all, run
`whisper-server` in a sibling container that has `/dev/dri`, and point
`STT_BASE_URL` at it. That keeps the moderation bot's attack surface small and
lets you restart either half independently.

### systemd

**The path of least resistance on a Raspberry Pi or any bare Debian/Ubuntu
host.** One command does the whole install — don't hand-roll the Quickstart
steps on a server.

```bash
git clone <this repo> && cd Birdeye_Cop
sudo ./scripts/install.sh
cd /opt/birdeye-cop
sudo -u birdeye npm run setup
sudo -u birdeye npm run doctor
sudo systemctl enable --now birdeye-cop
journalctl -u birdeye-cop -f
```

The installer is idempotent — re-run it to upgrade. It installs Node 22 from
NodeSource if the system Node is missing or too old (see
[Node version](#node-version)),
creates a `birdeye` system user, builds, seeds the rules file, and installs the
unit from [`deploy/birdeye-cop.service`](deploy/birdeye-cop.service). That unit
is hardened (`ProtectSystem=strict`, `PrivateDevices`, a syscall filter, and a
narrow `ReadWritePaths`) because this process handles other people's voice data.

Shutdown is graceful on `SIGTERM`: leave voice, drain the transcription queue,
close the database.

---

## Commands

All require **Manage Server**, or the role in `MODERATOR_ROLE_ID`. Every reply
is ephemeral. Authorization is re-checked at execution time, not just hidden in
the UI — a server administrator can override Discord's own permission gate, so
the bot does not rely on it.

| Command | Effect |
| --- | --- |
| `/moderation status` | Current settings, rule count, monitored channels, privacy posture |
| `/moderation enable` · `disable` | Turn moderation on or off for this server |
| `/moderation action <warn\|disconnect\|kick\|ban>` | Set the **most severe** action permitted |
| `/moderation dry-run <true\|false>` | Log violations without acting |
| `/moderation add <term> [severity] [whole-word]` | Add a banned word or phrase |
| `/moderation remove <term-or-id>` | Remove a rule |
| `/moderation list` | List rule IDs and their settings |
| `/moderation join [channel]` | Monitor a voice channel, and remember it |
| `/moderation leave` | Stop monitoring and disconnect |
| `/moderation evidence <id>` | Show one evidence record |
| `/moderation evidence-list [user]` | Recent evidence records |
| `/moderation evidence-delete <id>` | Permanently delete a record and its audio |

Runtime changes are persisted, so a moderator's change survives a restart.

`/moderation add` never creates regex rules — patterns arriving from a Discord
command are untrusted input, and a regex there would be a denial-of-service
vector against the matcher. Regex rules can only be written into the config
file.

---

## How moderation decides

```
speech → per-user buffer → VAD/segmentation → transcription → identity assertion
       → term matching → confidence check → verify pass → dedupe → escalation
       → evidence capture → action → record → report
```

Choices worth knowing about:

**Escalation, not a flat hammer.** `MODERATION_ACTION` is a *ceiling*, not the
action. A first offence warns; repeats climb `warn → disconnect → kick` within
`ESCALATION_WINDOW_HOURS`. High-severity rules start one rung higher.

**Bans are gated.** With `ALLOW_UNATTENDED_BAN=false` (the default), any
escalation reaching `ban` is applied as `kick` and flagged in the log for a human
to review. Speech recognition on noisy voice chat is not accurate enough to make
an irreversible decision with nobody in the loop.

**Failure means inaction.** If transcription fails, times out, is dropped under
load, or the circuit breaker is open, **nobody is moderated**. An unavailable
speech service must never be able to cause a kick.

**Nothing is dropped silently.** When the transcription queue saturates, the
*longest* per-speaker queue sheds work — never an arbitrary oldest item — and
every drop is reported as `STT_DEGRADED`. A plain FIFO with drop-oldest would be
an evasion route: several people talking over each other would flush earlier
audio out of the pipeline before it was ever analysed, and the logs would look
identical to a quiet channel.

**One action per utterance.** Deduplication is keyed on the segment, so the
verify pass and any coalesced retries cannot produce two actions, plus a
short-window content key catches equivalent transcripts across segments.

### Rules

Rules live in `config/moderation.json` (gitignored; see
[`config/moderation.example.json`](config/moderation.example.json), which
contains placeholders only).

```jsonc
{
  "id": "example-whole-word",
  "type": "word",              // word | phrase | regex
  "pattern": "BANNEDWORDONE",
  "wholeWord": true,           // token match, not substring
  "severity": "high",          // low | medium | high
  "action": "disconnect",      // optional per-rule floor
  "exceptions": ["SAFECOMPOUND"],
  "enabled": true
}
```

Transcripts are normalized before matching: Unicode NFKD, diacritics stripped,
lowercased, punctuation folded to spaces, whitespace collapsed. Optional
`mapLookalikes` folds `0→o`, `@→a` and friends; optional `collapseRepeats`
defeats `baaaad`.

`wholeWord` is what keeps a rule for `BANNEDWORDONE` from firing on
`BANNEDWORDONEXTRA`. For substring rules, the global `allowlist` and per-rule
`exceptions` suppress any match that falls inside an allowed term.

---

## Configuration reference

Every variable is documented inline in [`.env.example`](.env.example), grouped
so that only five are required:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
MODERATION_LOG_CHANNEL_ID=
STT_PROVIDER=mock
STT_API_KEY=            # unnecessary for mock, or for a local whisper server
```

Monitored channels come from `/moderation join`. Everything else has a working
default. Invalid configuration is reported **all at once** at startup, with the
offending variable named — not one failure per restart.

---

## Violation audio evidence

Disabled by default. When enabled, the bot keeps a short **in-memory** rolling
buffer per speaker and writes a clip to disk *only* when a violation actually
occurs.

```env
VIOLATION_AUDIO_LOGGING=true
I_ACKNOWLEDGE_BIOMETRIC_RISK=true    # required; see below
VIOLATION_AUDIO_DIRECTORY=./violation-audio
VIOLATION_AUDIO_RETENTION_DAYS=7
VIOLATION_AUDIO_PREBUFFER_MS=1000
VIOLATION_AUDIO_POSTBUFFER_MS=500
```

- **Only the violating speaker's audio is saved.** The buffer is owned by that
  speaker's stream instance, never pooled or shared, and the recorder asserts
  the buffer's owner matches the segment's speaker before writing a single byte.
  There is no code path from one person's microphone to another person's
  evidence file.
- Filenames are generated, never user-controlled:
  `2026-09-09T18-42-31Z_<uuid>.wav`. Evidence IDs must match a canonical UUID
  and the resolved path must still be inside the evidence directory — two
  independent checks on every read and delete.
- Files are written `0600` in a `0700` directory, and **the project ships no
  HTTP server**, so evidence has no web-exposed surface by construction.
- Retention is enforced by the bot on an hourly sweep, not left to a cron job
  you might forget — "we delete recordings after N days" is a promise made to
  the people being recorded.
- `EVIDENCE_ALLOW_DISCORD_UPLOAD` defaults to **false**: attaching a clip to a
  Discord reply places it on Discord's CDN, which is at odds with treating it as
  private evidence.

**Post-roll is best-effort.** Once someone is disconnected they stop
transmitting, so there may be no trailing audio to capture; the clip is padded
with real silence rather than borrowed audio. Set
`VIOLATION_AUDIO_DELAY_ACTION=true` to delay the action by the post-buffer
window if you would rather capture the real tail.

**Memory cost:** roughly **1.1 MB per concurrent speaker** at the default
buffer sizes. Nothing is allocated at all when the feature is off.

`I_ACKNOWLEDGE_BIOMETRIC_RISK=true` is required to start with recording enabled.
Recordings of an identifiable voice are treated as biometric data in some
jurisdictions — Illinois BIPA provides statutory damages per violation with no
injury required.

---

## Legal and consent

**This section is not legal advice.** It exists because this is the part of the
project most likely to cause real harm, and the part least likely to be caught
by a code review.

A bot that transcribes a conversation is doing something the law in many places
treats very differently from a bot that reads messages.

- **All-party consent.** Around eleven US states — California, Delaware,
  Florida, Illinois, Maryland, Massachusetts, Montana, Nevada, New Hampshire,
  Pennsylvania and Washington — require *every* participant to consent to a
  conversation being recorded, with several more contested. Most wiretap
  statutes trigger on **interception or processing**, not on storage, so "we
  don't save the audio" is not an exemption.
- **Biometric law.** Illinois BIPA treats voiceprints as biometric identifiers,
  with a private right of action and statutory damages per violation and no
  requirement to show injury. The evidence feature stores exactly that kind of
  data.
- **GDPR.** Legitimate interest is hard to sustain for transcription that goes
  beyond what participants would reasonably anticipate, and consent must be a
  specific, affirmative act. Sending EU members' audio to a US-hosted
  transcription provider is an international transfer with its own requirements.
- **Discord's own rules.** Every application must have a published privacy
  policy, and the Developer Policy restricts using API data beyond your stated
  functionality. Discord has previously acted against bots that monitored users
  covertly.
- **What your members have been told.** Discord now advertises that voice calls
  are end-to-end encrypted and that "even Discord can't listen in." A silently
  transcribing bot defeats an expectation Discord itself created. People who
  discover it after the fact are entitled to feel deceived.

**What this bot does about it, by default:**

1. It **announces itself** in the channel before listening, describing what is
   processed, what is retained, and which provider receives the audio. If it
   cannot post that notice, it **refuses to join** rather than listening
   silently. (`REQUIRE_MONITORING_NOTICE`)
2. Monitoring is **opt-in per channel**. There is no "monitor everything"
   setting — nobody should be transcribed because an operator forgot to narrow a
   default.
3. Transcripts are **not stored**, only hashed, unless you deliberately enable
   storage.
4. Recording is **off**, and refuses to turn on without an explicit
   acknowledgement.
5. Being **dragged into a channel is not consent** — if a moderator moves the
   bot into a channel it was not asked to monitor, it leaves.

Turning `REQUIRE_MONITORING_NOTICE` off is supported, because you may be
informing people another way (a server rule, an onboarding gate, a channel
name). It is not supported as a way to monitor people who do not know.

Before deploying against real members: publish
[`docs/PRIVACY.md`](docs/PRIVACY.md), decide whether your members' jurisdictions
permit this, and consider whether an explicit opt-in — a rules gate, a
consent role — is warranted for your community.

---

## Privacy and data flow

```
microphone → Discord (E2EE) → bot process (memory only)
                                   ↓
                         transcription provider ← the only egress
                                   ↓
                       matched? → moderation record (no audio)
                                   ↓
                    violation + recording enabled? → local .wav, 0600
```

- Audio exists **in memory only** unless a violation occurs with recording
  enabled.
- The **only** place audio leaves the host is the transcription provider you
  configured — and with a local Whisper server, not even that.
- The logger **structurally cannot** emit audio: any `Buffer` or typed array is
  replaced with a byte count before serialization. Secrets are redacted by field
  name. Transcripts are replaced by a one-way hash unless
  `TRANSCRIPT_LOGGING=true`. These are enforced in one place, so no call site can
  bypass them.
- No API keys, tokens, or raw audio ever reach a log line. There is a test
  suite asserting exactly that.

---

## Discord voice receive limitations

Read this before assuming a problem is a bug in this project.

**Discord does not document voice receive.** The `@discordjs/voice` README says
plainly: *"Audio receive is not documented by Discord so stable support is not
guaranteed."* Everything below follows from that.

### DAVE (end-to-end encryption) — the big one

Discord made **end-to-end encryption mandatory on all non-Stage voice calls in
early March 2026** and removed the unencrypted fallback entirely. This **broke
bot voice receive** in `@discordjs/voice` 0.19.0 and 0.19.1: healthy-looking
connections, speaking events firing, and zero audio, or reconnect loops with
`DecryptionFailed(UnencryptedWhenPassthroughDisabled)`
([discord.js#11419](https://github.com/discordjs/discord.js/issues/11419)).

It was fixed in **0.19.2** and this project pins that version **exactly**, not
with a caret range, because a future release could regress it and the failure is
silent.

Bots can still receive audio — DAVE was extended to support them, and they join
the encryption group as legitimate participants — but `@snazzah/davey` is now a
hard dependency, not an optional extra. `npm run doctor` checks it loads.

Because this failure mode is invisible, the bot ships an **audio-liveness
watchdog**: if a channel has people producing speaking events but no audio is
decoded for `VOICE_LIVENESS_TIMEOUT_MS`, it logs `VOICE_LIVENESS_WARNING` and
alerts the moderation channel. Never assume silence means compliance.

### Other library-specific requirements

- **`selfDeaf: false` is mandatory.** A self-deafened bot receives nothing at
  all. This is the single most common "it connects but hears nothing" cause.
- **The silence keepalive.** The bot transmits one silence frame on join, a
  long-standing workaround for the receive path not opening until the bot has
  sent something. It predates DAVE and may now be redundant, so it is behind
  `VOICE_SILENCE_KEEPALIVE=true`. It requires the **Speak** permission. Run
  `npm run spike:voice` with it on and off to find out what your deployment
  needs.
- **`AfterSilence` cuts streams mid-speech.**
  [discord.js#8105](https://github.com/discordjs/discord.js/issues/8105) has
  been open since 2022 with no official fix. Naively waiting out a coalescing
  window on every utterance would tax all speech with that delay, so instead the
  bot inspects the last ~150ms of audio: a stream that ended quietly really did
  end and flushes immediately, while an energetic tail waits
  `SEGMENT_COALESCE_MS` for a continuation. 600ms is a **tunable hypothesis**,
  not a validated constant.
- **An Opus decoder is required.** `@discordjs/opus` (native, much cheaper per
  speaker) is preferred, with pure-JS `opusscript` as an automatic fallback.
  Both are optional dependencies so a failed native build degrades performance
  instead of breaking the install.

  `npm install` prints six `npm warn deprecated` lines — `inflight`, `npmlog`,
  `gauge`, `are-we-there-yet`, `glob@7`, `rimraf@3`. **This is expected.** All
  six come from `@discordjs/node-pre-gyp`, the build-time tooling
  `@discordjs/opus` uses to fetch or compile its native binary. None of them run
  at runtime, and `npm audit` reports zero vulnerabilities.

  They are deliberately left alone. Forcing newer majors through `overrides`
  would break the native build — `glob` 7→10 is a breaking API change — and on
  ARM there is no prebuilt binary to fall back to, so the "fix" costs you the
  native decoder on exactly the hardware that needs it most. The one override
  that *is* applied, `tar@^7`, was a real advisory in the same tree. Dropping
  `@discordjs/opus` outright would silence the warnings at the price of higher
  CPU per speaker; on a Raspberry Pi that is the wrong trade. Revisit only if
  upstream republishes on a maintained node-pre-gyp.
- **`prism-media` is unmaintained** (last published 2023). It remains the
  library discord.js itself recommends, but treat it as frozen: no fixes are
  coming if a new edge case appears.
- **No encryption library is needed.** The sodium/noble packages are only
  required if your system lacks `aes-256-gcm`, which Node's OpenSSL provides.
- **One voice connection per guild.** Discord permits no more, so the bot
  monitors one channel per server at a time.

---

## Architecture

```
src/
  bot/          Discord client, commands, events, permissions, reporting
  voice/        receiver · user-stream · speech-detector · ring-buffer · pcm
  speech/       stt providers · fair queue · circuit breaker · transcription
  moderation/   normalize · matcher · rules · dedupe · escalation · actions · pipeline
  evidence/     recorder · retention sweeper · path safety
  storage/      sqlite · jsonl · memory (one interface) · settings
  observability/ structured logger with hard privacy guarantees
  config/       env validation and typed configuration
  scripts/      setup wizard · doctor · voice-receive spike
```

Every replaceable part sits behind an interface — `IAudioReceiver`,
`ISpeechDetector`, `ISttProvider`, `IMatcher`, `IModerationAction`,
`IEvidenceRecorder`, `ModerationStore` — and `index.ts` is the only file that
names a concrete implementation. Swapping the transcription provider, the
storage backend, or the Discord layer touches one file each.

### Attribution safety

The property the whole design protects:

1. Per-speaker state lives in a map keyed `guildId:userId`, created in one place.
   Nothing is pooled or reused between speakers.
2. `AudioSegment.userId` is stamped **once**, at capture, from the subscription
   it came from — and never re-derived downstream.
3. The pipeline asserts segment, transcription, and evidence all agree on the
   speaker before acting. A mismatch throws, logs `IDENTITY_MISMATCH`, and
   moderates nobody.
4. A per-user mutex serializes subscribe and teardown, so a late speaking event
   cannot resurrect a dead stream or bind to its successor.
5. Rolling audio buffers are instance-owned, so User A's audio has no route into
   User B's evidence.

### Storage

SQLite via `better-sqlite3` by default, with automatic fallback to append-only
JSONL if the native module is unavailable — a failed build degrades the
deployment rather than stopping it. All three implementations are tested against
the same conformance suite.

### Observability

Structured JSON, one object per line, with a fixed event vocabulary:
`VOICE_USER_STARTED`, `VOICE_USER_STOPPED`, `VOICE_LIVENESS_WARNING`,
`TRANSCRIPTION_COMPLETED`, `TRANSCRIPTION_VERIFY`, `STT_ERROR`, `STT_DEGRADED`,
`STT_BREAKER_OPEN`, `MODERATION_MATCH`, `MODERATION_ACTION`,
`MODERATION_SKIPPED`, `MODERATION_DEDUPED`, `IDENTITY_MISMATCH`,
`EVIDENCE_SAVED`, `EVIDENCE_PRUNED`, `PERMISSION_ERROR`, `DISCORD_VOICE_ERROR`.

---

## Testing

```bash
npm test                # 337 tests
npm run test:coverage
```

Covered: multi-speaker separation and attribution, speech segmentation and the
coalescing heuristic, case/punctuation/Unicode normalization, whole-word and
phrase matching, regex rules, allowlist false-positives, duplicate transcription
events, low-confidence and verify-pass behaviour, STT failures/timeouts/circuit
breaking, queue saturation not silently dropping a quiet speaker, users leaving
mid-processing, permission downgrades, dry-run, every moderation action,
escalation and ban gating, evidence on/off, cross-speaker evidence
contamination, pre/post-buffer durations, failed evidence writes not blocking the
action, retention expiry, path traversal, and logger redaction.

### Integration testing in a real server

Automated tests cannot cover Discord's undocumented voice-receive path. Do this
manually, in this order:

1. **Create a throwaway test server.** Never do first-time testing where real
   members are.
2. **Prove voice receive works** — this gates everything else:
   ```bash
   npm run spike:voice -- <voiceChannelId>
   ```
   Join with **two accounts** (a phone plus a desktop works) and both talk,
   ideally at the same time. A PASS means real decoded audio arrived from each,
   attributed to distinct user IDs. A FAIL naming DAVE means voice receive is
   broken and nothing downstream matters yet.
3. **Dry run.** With `DRY_RUN=true`, add a harmless rule
   (`/moderation add pineapple`) and say it. The log channel should show a match
   with `dry run — not applied`.
4. **Check attribution.** Both accounts speak simultaneously; confirm the events
   carry the *correct distinct* user IDs.
5. **Check a false positive.** Say a word that merely *contains* your banned
   term. With whole-word matching it must not fire.
6. **Go live.** `/moderation dry-run false`, then trigger the rule and confirm
   only the speaker is removed.
7. **Test the failure path.** Point `STT_BASE_URL` at a dead port mid-session.
   Confirm `STT_ERROR`, the breaker opening, and **nobody being kicked**.
8. **Evidence, if enabled.** Trigger a violation while both accounts talk;
   confirm exactly one `.wav`, `0600`, containing only the violator's voice.
9. **Permissions.** Remove Move Members and restart; confirm the action
   downgrades with a `PERMISSION_ERROR` rather than silently no-op'ing.

---

## Troubleshooting

**Start here:**

```bash
npm run doctor
```

It checks the Node version, every native module, your token, server membership,
the log channel, the rules file, filesystem permissions, and makes a live
transcription call — with a specific fix for each failure.

| Symptom | Cause and fix |
| --- | --- |
| `EBADENGINE` / `npm install` pulls older versions than `package.json` asks for | Your Node is older than 22.12, so npm falls back to versions that fit it instead of erroring. `node -v`, then [fix Node](#node-version) and `rm -rf node_modules && npm ci`. |
| `npm warn deprecated` for `inflight`, `npmlog`, `gauge`, `glob@7`, `rimraf@3`, `are-we-there-yet` | Expected, safe to ignore, deliberately not fixed — see [Other library-specific requirements](#other-library-specific-requirements). Do not `overrides` them to newer majors; it breaks the native build. |
| `npm warn install-scripts ... blocked because they are not covered by allowScripts` | npm >= 12 blocks dependency install scripts by default. The approvals are committed in `package.json`, so this means your checkout is stale or a dependency version moved. `npm install-scripts ls` to review, `npm install-scripts approve esbuild @discordjs/opus better-sqlite3`, then `npm rebuild`. **esbuild matters most** — `tsx` and `vitest` are built on it, so `npm run dev`, `setup`, `doctor`, and `test` all fail without it. |
| Bot joins but never reacts | Almost always voice receive. Run `npm run spike:voice`. If speaking events arrive with zero bytes, see [DAVE](#dave-end-to-end-encryption--the-big-one). |
| `VOICE_LIVENESS_WARNING` in the logs | Confirmed broken receive: speaking events but no audio. Verify `@discordjs/voice` is exactly `0.19.2` and `@snazzah/davey` loads. |
| Connects, hears nothing, no errors | `selfDeaf` must be false, and the bot must not be server-deafened in that channel. |
| `npm install` fails on `@discordjs/opus` or `better-sqlite3` | Both are optional; install continues with fallbacks. For the native versions: `sudo apt install -y build-essential python3 && npm ci`. |
| `Cannot find module '@snazzah/davey'` | Not optional — voice will not work. Reinstall with build tools available. |
| Commands don't appear | The bot needs the `applications.commands` scope. Re-invite with the URL from `npm run setup`; guild commands appear instantly. |
| "You need Manage Server" as an admin | Set `MODERATOR_ROLE_ID`, or grant Manage Server. |
| Nothing ever matches | `/moderation status` — check rules > 0, moderation enabled, and the channel is monitored. Whole-word matching is on by default. |
| Everything matches | A substring rule (`wholeWord: false`). Add an `exceptions` entry or switch it to whole-word. |
| Action logged but nobody removed | `dry run` is on, or the target's highest role sits at or above the bot's, or the owner. Check `PERMISSION_ERROR`. |
| `STT_DEGRADED` in the logs | The queue saturated and audio went untranscribed. Raise `STT_MAX_CONCURRENCY` (cloud providers can take 8+) or `STT_QUEUE_MAX`. **Coverage gapped — silence is not compliance.** |
| Transcription slow or timing out | Local Whisper on a CPU without AVX2 is far too slow. Use a smaller model, a GPU build, or a cloud provider. Raise `STT_TIMEOUT_MS` only after checking. |
| Bot refuses to join a channel | It could not post the monitoring notice. Grant **Send Messages** there. This is deliberate. |
| Won't start: biometric acknowledgement | You enabled `VIOLATION_AUDIO_LOGGING`. Read [the evidence section](#violation-audio-evidence), then set `I_ACKNOWLEDGE_BIOMETRIC_RISK=true`. |
| Evidence dir unwritable in LXC | uid/gid mapping. `chown` it to the service user inside the container. |
| Config errors on startup | They are listed all at once with the variable named. Fix them together. |

---

## Known limitations

Stated plainly, because a moderation tool that oversells itself is worse than
one that admits its edges.

**It can be evaded.** Mumbling, talking over game audio, or slight
mispronunciation will defeat speech recognition. The deliberately fail-safe
design adds more: no action on low confidence, none while the transcription
service is down, and none for audio dropped under load. A determined person has
several cheap routes around this. It raises the cost of saying something
prohibited; it does not prevent it.

**It will produce false positives.** Word-error rates on gaming voice chat —
cross-talk, music, accents, slang — are materially worse than on clean audio. A
movie quote, a name, or a discussion *about* a word can trigger a rule. The
escalation ladder, confidence threshold, verify pass and dry-run mode exist
because of this, not in spite of it. Keep `DRY_RUN=true` until the logs convince
you otherwise.

**Voice receive is unsupported by Discord** and has broken before. Treat this as
a tool that needs monitoring, not one you deploy and forget.

**One channel per server** at a time.

**Latency** is roughly 1.5–2.5s from end-of-speech to action, and up to 6s when
the verify pass runs. It is near-real-time, not instant.

---

## License

See [LICENSE](LICENSE).
