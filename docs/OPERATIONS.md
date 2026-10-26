# xpost operations guide (for Friday / AI assistants)

This guide is for an AI assistant operating `xpost` on behalf of the account owner `@mmisbbahh`.

You may draft, schedule, and (after human approval) post. You must never invent approval.

Full product docs: [README.md](../README.md).

## Hard rules (non-negotiable)

1. Never ask for, print, log, or commit API tokens, secrets, or the approval passphrase.
2. Never run interactive `xpost approve`, `xpost approve --batch`, or `xpost init-approver`.
3. Chat approval (`xpost approve --chat`) is allowed **only** after the owner gives an explicit yes to the exact text (and hashes) you showed. Never invent a yes. Never reuse an old yes. Never edit a draft/batch after approval without a new yes.
4. Never post without the owner's explicit yes on the exact text (approval record is the proof).
5. Prefer `--json` and `--dry-run` when checking state. Never invent a raw `post "text"` path (it does not exist).
6. If `xpost status` shows paused, stop mutating posts until the owner resumes.
7. Treat env vars as credentials. Do not echo `$XPOST_*` values.

## Chat approval honesty

Chat mode is **trust-based**. It relies on you (the assistant) only running `approve --chat` after the owner explicitly said yes to the exact text you showed. The command stores the `--quote` verbatim in the approval record and audit log for later review. It does **not** prove the human typed into a secure terminal. Prefer TTY passphrase approval when the owner can run it locally.

### Assistant rules for chat approval

1. Show the owner the exact text(s), media hashes, target, schedule time(s), and text sha256(s) first.
2. Run `xpost approve --chat ...` only after a clear yes to that exact set.
3. One batch (or draft) per yes. Do not bundle unrelated approvals under one quote.
4. Never reuse an old yes quote for a new draft or edited text.
5. Never edit a draft or batch after approval; if anything changes, show again and get a new yes.
6. Always pass `--confirm-hash` with the first 8+ characters of a text sha256 you showed (recommended).
7. Pass the owner's yes message verbatim in `--quote`.

## Directory split (owner vs assistant)

| Role | Env | Contents |
|------|-----|----------|
| Owner (TTY approver) | `XPOST_APPROVER_DIR` | Passphrase scrypt hash + encrypted Ed25519 private key (`approver.json`, mode 600) |
| Assistant (drafter/poster) | `XPOST_HOME` | Drafts, signed approvals, batches, schedule, audit log, `verify-key.json` (TTY public), `chat-approver.json` (chat signing key, auto-created) |

The assistant can verify TTY Ed25519 signatures with the public key and cannot forge TTY approvals without the private key. Chat approvals are signed with a local key under `XPOST_HOME` (tamper-evident, not a human passphrase gate).

`XPOST_APPROVAL_MODES` defaults to `tty,chat`. Owner may set `tty` only to disable chat mode.

## One-time owner setup

Run on the owner's machine / terminal (TTY required for init-approver).

```bash
# Approver material stays off the assistant machine
export XPOST_APPROVER_DIR="$HOME/.config/xpost-approver"
export XPOST_HOME="$HOME/.local/share/xpost"   # shared data dir, or sync later

xpost init-approver
# Creates:
#   $XPOST_APPROVER_DIR/approver.json     (private; encrypted key)
#   $XPOST_HOME/verify-key.json           (public; safe to copy to assistant)

# Optional interactive auth (owner machine). Prefer env vars for the assistant.
xpost auth

xpost whoami   # should print mmisbbahh when creds are set
```

If the assistant uses a different `XPOST_HOME`, copy only `verify-key.json` into that data dir:

```bash
cp "$OWNER_XPOST_HOME/verify-key.json" "$ASSISTANT_XPOST_HOME/verify-key.json"
chmod 644 "$ASSISTANT_XPOST_HOME/verify-key.json"
```

Do not copy `approver.json` or `XPOST_APPROVER_DIR` to the assistant.

## Assistant credentials (env only; no config file required)

```bash
export XPOST_HOME="$HOME/.local/share/xpost"
export XPOST_API_KEY="..."
export XPOST_API_SECRET="..."
export XPOST_ACCESS_TOKEN="..."
export XPOST_ACCESS_SECRET="..."
# optional:
# export XPOST_OAUTH2_TOKEN="..."
# export XPOST_APPROVAL_MODES="tty,chat"

xpost whoami --json
```

No `~/.config/xpost/config` and no `xpost auth` are required when these env vars are set.

## Daily flow (typical: 3 posts in a batch via chat approval)

Default timezone is Asia/Calcutta (IST).

### 1. Assistant drafts

```bash
xpost draft "First post text for tonight." --json
xpost draft "Second post text." --json
xpost draft "Third post text." --json
# note each draft id from JSON: .id
```

Or draft directly into a batch:

```bash
xpost draft "First post text for tonight." \
  --batch release-fri \
  --at "2026-10-27 20:00 IST" --json
```

### 2. Batch create / add with IST times

```bash
xpost batch create release-fri --json
# note batch id

xpost batch add <batch-id> <draft-id-1> --at "2026-10-27 20:00 IST" --json
xpost batch add <batch-id> <draft-id-2> --at "2026-10-27 21:00 IST" --json
xpost batch add <batch-id> <draft-id-3> --at "2026-10-28 09:00 IST" --json

xpost batch show <batch-id> --json
```

Adding, removing, or editing a draft after approval invalidates approvals. The batch must be re-approved.

### 3. Show owner exact content, then chat-approve after yes

Show the owner every post's full text, text sha256, media hashes, target, and scheduled time. After a clear yes:

```bash
xpost approve --chat <batch-id> \
  --quote "yes, those three at those times" \
  --confirm-hash <first8+ of a text sha256> \
  --json
```

The command prints/returns the exact texts, hashes, targets, and schedule times being approved, then writes a separate signed chat approval per post (bound to text/media/target and scheduled time). The quote is stored verbatim in each record and the audit log.

TTY alternative (owner machine with `XPOST_APPROVER_DIR`):

```bash
xpost approve --batch <batch-id>
```

### 4. Schedule is already set by batch add

`batch add` writes schedule entries. Confirm:

```bash
xpost schedule --list --json
```

To change a time after approval, re-add / reschedule and get a new yes / re-approve:

```bash
xpost schedule <draft-id> --at "2026-10-27 22:00 IST"
# approval for that post is invalidated; re-run approve --chat or approve --batch
```

### 5. Cron: run-due every 5 minutes

Posts only due, approved, still-valid items. Idempotent (lock file). Verifies each per-post signature at execution (TTY or chat mode).

```cron
*/5 * * * * XPOST_HOME=/path/to/data XPOST_API_KEY=... XPOST_API_SECRET=... XPOST_ACCESS_TOKEN=... XPOST_ACCESS_SECRET=... /path/to/node /path/to/xpost/bin/xpost.js run-due --json >> /var/log/xpost-run-due.log 2>&1
```

Manual:

```bash
xpost run-due --dry-run --json
xpost run-due --json
```

### Exact command sequence (copy/paste shape)

```bash
# Assistant
xpost draft "Post A" --json
xpost draft "Post B" --json
xpost draft "Post C" --json
xpost batch create evening --json
xpost batch add <batch-id> <id-a> --at "2026-10-27 20:00 IST"
xpost batch add <batch-id> <id-b> --at "2026-10-27 21:00 IST"
xpost batch add <batch-id> <id-c> --at "2026-10-28 09:00 IST"
xpost batch show <batch-id>

# Show owner exact texts + text sha256s + times. Owner says yes in chat.
xpost approve --chat <batch-id> --quote "yes, those three at those times" --confirm-hash <prefix>

# Assistant / cron
xpost schedule --list
xpost run-due
```

Single post (no batch):

```bash
xpost draft "One-off update." --json
# Show text + hash; owner says yes
xpost approve --chat <draft-id> --quote "yes" --confirm-hash <prefix> --json
xpost post --id <draft-id> --dry-run --json
xpost post --id <draft-id> --json
```

## Replies, quotes, threads, media

```bash
xpost draft "Agree with this." --reply-to https://x.com/user/status/123456 --json
xpost draft "More context." --quote 123456 --json
xpost draft --thread-file ./thread.json --json
# thread.json: ["First","Second","Third"]

xpost draft "Chart drop." --media ./chart.png --media ./clip.mp4 --json
```

Media is hash-bound. Changing a file after approval fails at post time.

## Delete (also requires approval)

```bash
xpost draft-delete https://x.com/mmisbbahh/status/123456 --json
# Owner yes in chat, or TTY approve:
xpost approve --chat <delete-draft-id> --quote "yes delete that" --confirm-hash <prefix> --json
xpost delete --id <delete-draft-id> --dry-run --json
xpost delete --id <delete-draft-id> --json
```

## Pause / resume / status / metrics

```bash
xpost pause --json          # blocks post, delete, run-due
xpost resume --json
xpost status --json         # paused, daily count, pending approvals, schedule
xpost metrics <post-id-or-url> --json
xpost timeline --me --json
```

## Expiry notes

- Unscheduled approvals: default TTL 24h (configurable).
- Scheduled approvals: expire at scheduled time + 6h, capped at 36h after approval (configurable via app config).
- Expired or hash-mismatched items are skipped / refused by `post` and `run-due`.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| exit 10 on approve (no --chat) | Not a TTY / `CI` / `XPOST_NONINTERACTIVE` | Use owner TTY approve, or chat mode after owner yes |
| exit 2 usage on --chat | Missing `--quote`, or chat mode disabled | Pass `--quote`; check `XPOST_APPROVAL_MODES` |
| exit 5 confirm-hash / binding | Wrong hash prefix or text/media/target/schedule changed | Re-show exact content; new yes; re-approve |
| exit 4 not approved | Missing approval | Get owner yes / TTY approve |
| exit 6 expired | TTL or schedule window passed | Re-approve or reschedule within window |
| exit 7 paused | Kill switch | Owner: `xpost resume` |
| exit 8 daily limit | Cap (default 8) | Wait or owner raises cap in app config |
| exit 9 duplicate | Same text hash already posted/recent | Change text |
| exit 12 forged | Bad signature / wrong verify key | Ensure keys match; never edit approvals by hand |
| exit 3 auth | Missing creds or verify key | Set env vars; copy `verify-key.json` for TTY |
| whoami fails | Bad or missing OAuth1 env vars | Fix env; never print values while debugging |
| run-due no-ops | Not due, not approved, or lock held | `schedule --list`, `status`, retry |

## What Friday must not do

- Do not request the approval passphrase.
- Do not run interactive `approve` / `approve --batch` / `init-approver`.
- Do not run `approve --chat` without a fresh, explicit owner yes to the exact shown text.
- Do not reuse an old yes quote or approve after silent edits.
- Do not attempt to bypass approval by editing `approvals.json`.
- Do not copy or read `XPOST_APPROVER_DIR`.
- Do not follow, DM, like, or retweet (unsupported on purpose).
- Do not post draft text the owner has not approved as shown.
