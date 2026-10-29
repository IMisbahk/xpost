# xpost

Human-approved CLI for posting to the owner's X account (`@mmisbbahh`).

An assistant may draft and post. Only the human owner may approve. There is no raw `xpost post "text"` path.

**Operator guide for AI assistants:** [docs/OPERATIONS.md](docs/OPERATIONS.md)

## Safety model (read this)

Text can only be posted if it was approved by the human owner, bound to the SHA-256 of the exact text (and media hashes, reply/quote targets, ordered thread texts, and scheduled time when set).

Two approval modes (config `XPOST_APPROVAL_MODES`, default `tty,chat`):

### TTY + passphrase (default interactive)

`xpost approve` / `xpost approve --batch <id>`:

- Requires an interactive TTY (refuses if stdin/stdout is not a TTY)
- Refuses when `CI` or `XPOST_NONINTERACTIVE` is set
- Shows the exact full text, hashes, media, target, and scheduled time
- Requires the owner passphrase set by `xpost init-approver`
- Stores only a scrypt hash with salt (mode 600), with failed-attempt lockout
- Signs each approval with **Ed25519**: private key encrypted by the passphrase stays in `XPOST_APPROVER_DIR`; public key is written to `XPOST_HOME/verify-key.json` so the assistant can verify but not forge

### Chat approval (non-interactive)

`xpost approve --chat <draft-id|batch-id> --quote "<owner's exact yes>" [--confirm-hash <prefix>]`:

- Runnable without a TTY (assistant machine / non-interactive)
- **Trust-based:** it relies on the assistant only running this after the owner gave an explicit yes to the exact text shown in chat. The log records the quoted yes for later review; it does not cryptographically prove the human typed into a terminal.
- First prints (and returns in `--json`) the exact text(s), media hashes, target, schedule time(s), and text sha256(s) being approved
- `--quote` is required and stored verbatim in the approval record and the hash-chained audit log (with mode `chat`, draft/batch id, text hashes, timestamp)
- Optional `--confirm-hash` / `--yes-hash`: first 8+ chars of a text sha256; refused on mismatch so the assistant must have shown the owner the exact hash (recommended)
- Signs with a local Ed25519 key auto-generated under `XPOST_HOME/chat-approver.json` on first use (no passphrase) so records are tamper-evident
- Same binding, expiry, and edit-invalidation rules as TTY approvals
- Disable with `XPOST_APPROVAL_MODES=tty`

`xpost post --id <id>` and `xpost run-due` accept both modes: they verify the signature (correct public key for the mode) and binding hash, and refuse if the text changed, the draft is not approved, the approval expired, posting is paused, the daily cap is exceeded, the text is a duplicate, or the scheduled time no longer matches.

### Honest limitations

TTY mode protects against an assistant misusing the CLI without the passphrase. Chat mode does **not** stop a compromised assistant from forging a quote; it records the claimed yes and binds content hashes for later review. Neither mode protects against someone who has the owner's approval passphrase or full control of the owner's account / machine.

Recommended setup:

1. Prefer `xpost approve` on the owner's own machine and terminal when possible.
2. Keep `XPOST_APPROVER_DIR` (passphrase hash + encrypted private key) off the assistant machine.
3. Copy only `verify-key.json` into the assistant's `XPOST_HOME` (TTY verify). Chat signing key lives on the machine that runs `--chat`.
4. Prefer env vars for API credentials on the posting machine (no config file required).
5. For chat mode, require the assistant to show exact text + hash, wait for a clear yes, then run `approve --chat` with `--quote` and `--confirm-hash`.

## Install

Node 20+ required.

```bash
npm install
npm run build
npm link
# or
npx --yes .
```

```bash
npm test
npm run lint
```

## X developer app setup

1. Open the [X developer portal](https://developer.x.com/) and create a project/app.
2. Set app permissions to **Read and Write**.
3. Create consumer API key and secret.
4. Generate a **user access token and secret** for `@mmisbbahh` (OAuth 1.0a user context). This is the primary auth mode.
5. Optional: create an OAuth2 user bearer token with tweet read/write and media write scopes.

Never commit credentials. Never paste them into chat logs.

## Configure credentials

Priority order:

1. Env vars (fully sufficient alone): `XPOST_API_KEY`, `XPOST_API_SECRET`, `XPOST_ACCESS_TOKEN`, `XPOST_ACCESS_SECRET`, optional `XPOST_OAUTH2_TOKEN`
2. Config file `~/.config/xpost/config` (created mode 600; refused if more permissive)
3. Interactive `xpost auth` (hidden input)

Data lives under `~/.local/share/xpost` (override with `XPOST_HOME`). Approver material: `XPOST_APPROVER_DIR`.

Approval modes: `XPOST_APPROVAL_MODES` (default `tty,chat`; set `tty` to disable chat).

## Owner one-time setup

```bash
export XPOST_APPROVER_DIR="$HOME/.config/xpost-approver"
export XPOST_HOME="$HOME/.local/share/xpost"
xpost init-approver
# optional if not using env vars:
xpost auth
xpost whoami
```

## Exact draft -> approve -> post sequence (TTY)

```bash
xpost draft "Shipping the release notes tonight."
xpost approve <draft-id>          # owner, interactive TTY + passphrase
xpost post --id <draft-id>        # optional: --dry-run first
```

## Exact draft -> batch -> chat approve -> schedule/run-due

```bash
xpost draft "Post A"
xpost draft "Post B"
xpost draft "Post C"
xpost batch create evening
xpost batch add <batch-id> <id-a> --at "2026-10-27 20:00 IST"
xpost batch add <batch-id> <id-b> --at "2026-10-27 21:00 IST"
xpost batch add <batch-id> <id-c> --at "2026-10-28 09:00 IST"
xpost batch show <batch-id>

# Assistant shows exact texts + text sha256s to the owner in chat.
# Owner replies with an explicit yes to that exact set.
xpost approve --chat <batch-id> --quote "yes, those three at those times" --confirm-hash <first8+ of a text sha256>

# Assistant / cron:
xpost schedule --list
xpost run-due
```

Or draft into a batch in one step:

```bash
xpost draft "Post A" --batch evening --at "2026-10-27 20:00 IST"
```

TTY batch path remains available:

```bash
xpost approve --batch <batch-id>
```

Adding, removing, or editing any draft after approval invalidates that post's approval; re-run approve.

### Expiry

- Unscheduled: default TTL 24h (configurable).
- Scheduled: expires at scheduled time + 6h, capped at 36h after approval (configurable).

Thread / reply / quote / media:

```bash
xpost draft --thread-file thread.json
xpost draft "Agree." --reply-to https://x.com/user/status/123
xpost draft "Context." --quote 123 --media ./chart.png --media ./clip.mp4
```

Delete (also requires approval):

```bash
xpost draft-delete https://x.com/mmisbbahh/status/123
xpost approve <draft-id>
# or: xpost approve --chat <draft-id> --quote "yes delete that" --confirm-hash ...
xpost delete --id <draft-id>
```

## Scheduling

Default timezone is `Asia/Calcutta` (IST). Explicit zones are parsed. Batch members are scheduled via `batch add --at`; `run-due` verifies each per-post signature.

```bash
xpost schedule <draft-id> --at "2026-10-27 20:00 IST"
xpost schedule --list
xpost unschedule <draft-id>
xpost run-due
xpost run-due --dry-run
```

## Safety controls

- `--dry-run` on mutating commands
- Daily post cap (default 8, configurable)
- Duplicate-text guard
- Kill switch: `xpost pause` / `xpost resume`
- Append-only JSONL audit log with hash chaining (never secrets)
- No follow / DM / like / retweet features

## Read helpers

```bash
xpost metrics <post id|url>
xpost timeline --me
xpost status
```

## Machine-friendly output

Every command supports `--json`. Exit codes are meaningful (not approved, hash mismatch, expired, paused, daily limit, duplicate, TTY required, lockout, forged, and others).

## Assistant workflow

See [docs/OPERATIONS.md](docs/OPERATIONS.md).

1. Assistant drafts (and may batch + schedule).
2. Owner approves via TTY passphrase **or** explicit yes in chat (then `approve --chat --quote ...`).
3. Assistant runs `xpost post --id ...` or cron `xpost run-due` only after approval.
4. Assistant must never run `init-approver` or interactive `approve` / `approve --batch`. Chat `--chat` only after a clear owner yes to the exact text.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
npm run lint
npm run check:secrets
```

Tests use a fake X API client. No live X API calls. No real credentials are required or embedded.

## License

MIT
