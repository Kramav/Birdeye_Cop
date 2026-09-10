# Privacy Policy — Voice Moderation

> **This is a template.** Discord requires every application to have a publicly
> accessible privacy policy. Fill in the bracketed fields, publish it somewhere
> your members can reach, and paste the URL into the Discord Developer Portal
> under **General Information → Privacy Policy URL**.
>
> It is written to match what this bot actually does. If you change the
> configuration, change this document to match — a privacy policy that
> describes something other than the running system is worse than none.
>
> **This is not legal advice.** See [Legal and consent](../README.md#legal-and-consent)
> in the README for the obligations this feature can create.

---

**Operator:** [YOUR NAME OR ORGANISATION]
**Contact:** [EMAIL ADDRESS]
**Server(s) covered:** [SERVER NAME(S)]
**Last updated:** [DATE]

## What this bot does

While the bot is present in a voice channel, it listens to speech in that
channel, converts it to text, and compares that text against a list of terms
prohibited in this server. If a prohibited term is detected, it may remove the
speaker from voice, remove them from the server, or record the event for a
moderator to review.

The bot posts a notice in a voice channel when it begins monitoring. If you do
not consent to this, leave the channel.

## What is processed

| Data | Purpose | Retained |
| --- | --- | --- |
| Voice audio | Converted to text to check against the prohibited-term list | **In memory only.** Discarded as soon as the segment is transcribed, unless a violation occurs and evidence recording is enabled |
| Transcribed text | Compared against the prohibited-term list | [`TRANSCRIPT_LOGGING=false`: **not stored** — only a one-way hash is kept, which cannot be turned back into words / `TRANSCRIPT_LOGGING=true`: stored with the moderation record] |
| Discord user ID, server ID, channel ID | To attribute a moderation event to the correct person | [`MODERATION_LOG_RETENTION_DAYS`] days |
| Timestamps, matched rule ID, confidence score, action taken | Moderation record and appeals | [`MODERATION_LOG_RETENTION_DAYS`] days |
| Short audio clip of a violation | Evidence for moderator review | [Disabled / **Enabled**, retained [`VIOLATION_AUDIO_RETENTION_DAYS`] days, then deleted automatically] |

Audio is never mixed between speakers. Each person's audio is processed
separately, and any recorded evidence contains only the speech of the person the
moderation action was taken against.

## Where audio is sent

Speech is transcribed by: **[mock / OpenAI / Groq / Deepgram / a locally-hosted
Whisper server — state which]**.

- If a third-party service is used, short segments of speech audio are
  transmitted to that provider for transcription and are subject to that
  provider's own privacy policy and retention practices. [LINK TO PROVIDER
  POLICY]
- If a locally-hosted transcription server is used, audio does not leave the
  operator's own infrastructure.

Audio is not sold, shared for advertising, or used to train any model by this
bot. Whether the transcription provider does so is governed by their terms —
check them.

## What is not collected

- Text messages. The bot does not have the Message Content intent and cannot
  read your messages.
- Continuous recordings. Audio is not written to disk during normal
  conversation.
- Voice from channels the bot is not in. The bot only monitors channels
  explicitly opted in by a server administrator.
- Anything about you when you are not speaking in a monitored voice channel.

## Automated decisions

Moderation actions may be taken automatically, based on automated speech
recognition. **Speech recognition is not perfectly accurate**, particularly with
background noise, music, cross-talk, or accents. The system is configured to
reduce mistakes — low-confidence detections are re-checked against a second
model, and repeat offences escalate gradually rather than jumping to removal —
but false positives remain possible.

[If `ALLOW_UNATTENDED_BAN=false`, which is the default:] Permanent bans are never
issued automatically. Any escalation that would reach a ban is applied as a
lesser action and flagged for a human moderator to review.

## Your rights

Depending on where you live, you may have the right to access, correct, or
delete personal data held about you, to object to processing, or to withdraw
consent.

To exercise any of these, contact **[EMAIL ADDRESS]**. To request deletion of a
moderation record or an evidence recording, quote the evidence ID from the
moderation log if you have it.

You can avoid processing entirely by not speaking in a monitored voice channel.

## Retention and deletion

Records and recordings are deleted automatically once their retention period
expires; deletion is enforced by the bot itself, not by a manual process.
Administrators can also delete an evidence recording on request at any time.

## Changes

Material changes to what is processed, how long it is kept, or where it is sent
will be announced in [ANNOUNCEMENTS CHANNEL] before taking effect.
