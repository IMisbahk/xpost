# xpost operations guide (for Friday / AI assistants)

This guide is for an AI assistant operating `xpost` on behalf of the account owner `@mmisbbahh`.

You may draft, schedule, and (after human approval) post. You must never approve.

Full product docs: [README.md](../README.md).

## Hard rules (non-negotiable)

1. Never ask for, print, log, or commit API tokens, secrets, or the approval passphrase.
2. Never run `xpost approve`, `xpost approve --batch`, or `xpost init-approver`.
3. Never post without the owner's explicit yes on the exact text (approval record is the proof).
4. Prefer `--json` and `--dry-run` when checking state. Never invent a raw `post "text"` path (it does not exist).
5. If `xpost status` shows paused, stop mutating posts until the owner resumes.
6. Treat env vars as credentials. Do not echo `$XPOST_*` values.

## Directory split (owner vs assistant)

| Role | Env | Contents |
|------|-----|----------|
| Owner (approver) | `XPOST_APPROVER_DIR` | Passphrase scrypt hash + encrypted Ed25519 private key (`approver.json`, mode 600) |
| Assistant (drafter/poster) | `XPOST_HOME` | Drafts, signed approvals, batches, schedule, audit log, `verify-key.json` (public only) |

The assistant can verify Ed25519 signatures with the public key. The assistant cannot forge approvals without the private key.

## One-time owner setup

Run on the owner's machine / terminal (TTY required).

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

xpost whoami --json
```

No `~/.config/xpost/config` and no `xpost auth` are required when these env vars are set.

## Daily flow (typical: 3 posts in a batch)

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

### 3. Owner approves at a real terminal

Owner machine with `XPOST_APPROVER_DIR` and the same (or synced) `XPOST_HOME`:

```bash
xpost approve --batch <batch-id>
```

One passphrase step. Shows every post's full text, hash, media, target, and scheduled time. Writes a separate Ed25519-signed approval per post (bound to text/media/target and scheduled time).

### 4. Schedule is already set by batch add

`batch add` writes schedule entries. Confirm:

```bash
xpost schedule --list --json
```

To change a time after approval, re-add / reschedule and ask the owner to approve again:

```bash
xpost schedule <draft-id> --at "2026-10-27 22:00 IST"
# approval for that post is invalidated; re-run approve --batch
```

### 5. Cron: run-due every 5 minutes

Posts only due, approved, still-valid items. Idempotent (lock file). Verifies each per-post signature at execution.

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

# Owner (TTY, separate approver dir)
xpost approve --batch <batch-id>

# Assistant / cron
xpost schedule --list
xpost run-due
```

Single post (no batch):

```bash
xpost draft "One-off update." --json
# Owner: xpost approve <draft-id>
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
# Owner: xpost approve <delete-draft-id>
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
| exit 10 on approve | Not a TTY / `CI` / `XPOST_NONINTERACTIVE` | Owner must approve locally; assistant must not approve |
| exit 4 not approved | Missing approval | Ask owner to approve exact draft/batch |
| exit 5 hash mismatch | Text/media/target/schedule changed | Re-draft or re-add; owner re-approves |
| exit 6 expired | TTL or schedule window passed | Re-approve or reschedule within window |
| exit 7 paused | Kill switch | Owner: `xpost resume` |
| exit 8 daily limit | Cap (default 8) | Wait or owner raises cap in app config |
| exit 9 duplicate | Same text hash already posted/recent | Change text |
| exit 12 forged | Bad signature / wrong verify key | Ensure `verify-key.json` matches owner init; never edit approvals by hand |
| exit 3 auth | Missing creds or verify key | Set env vars; copy `verify-key.json` |
| whoami fails | Bad or missing OAuth1 env vars | Fix env; never print values while debugging |
| run-due no-ops | Not due, not approved, or lock held | `schedule --list`, `status`, retry |

## What Friday must not do

- Do not request the approval passphrase.
- Do not attempt to bypass approval by editing `approvals.json`.
- Do not copy or read `XPOST_APPROVER_DIR`.
- Do not follow, DM, like, or retweet (unsupported on purpose).
- Do not post draft text the owner has not approved as shown.
