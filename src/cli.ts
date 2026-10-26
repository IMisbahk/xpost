import { Command } from "commander";
import { emitError, type OutputMode } from "./lib/output.js";
import { ensureDir } from "./lib/fsutil.js";
import { getPaths } from "./lib/paths.js";
import { cmdAuth } from "./commands/auth.js";
import { cmdInitApprover } from "./commands/initApprover.js";
import { cmdWhoami } from "./commands/whoami.js";
import { cmdDraft, cmdDraftDelete } from "./commands/draft.js";
import { cmdApprove, cmdRevoke } from "./commands/approve.js";
import { cmdPost, cmdDelete } from "./commands/post.js";
import { cmdSchedule, cmdUnschedule, cmdRunDue } from "./commands/scheduleCmd.js";
import { cmdStatus, cmdPause, cmdResume } from "./commands/status.js";
import { cmdMetrics, cmdTimeline } from "./commands/read.js";
import {
  cmdBatchCreate,
  cmdBatchAdd,
  cmdBatchRemove,
  cmdBatchShow,
  cmdBatchList,
} from "./commands/batch.js";

function modeFromOpts(opts: { json?: boolean }): OutputMode {
  return { json: Boolean(opts.json) };
}

async function prepareHome(): Promise<void> {
  const paths = getPaths();
  await ensureDir(paths.home, 0o700);
  await ensureDir(paths.draftsDir, 0o700);
}

export async function runCli(argv: string[]): Promise<void> {
  await prepareHome();
  const program = new Command();
  program
    .name("xpost")
    .description("Human-approved CLI for posting to X")
    .version("1.0.0")
    .option("--json", "Machine-friendly JSON output", false);

  program
    .command("auth")
    .description("Interactively save X API credentials (hidden input)")
    .option("--json", "JSON output")
    .option("--dry-run", "Show what would be written without saving")
    .action(async (opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        if (opts.dryRun) {
          const { emitSuccess } = await import("./lib/output.js");
          emitSuccess(mode, { dryRun: true }, [
            "DRY RUN: would prompt for credentials and write ~/.config/xpost/config mode 600",
          ]);
          return;
        }
        await cmdAuth(mode);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("init-approver")
    .description("Create the approval passphrase store (owner only, TTY required)")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdInitApprover(mode);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("whoami")
    .description("Verify auth and print the account handle")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdWhoami(mode);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("draft")
    .description("Create a draft bound to exact text/media/target hashes")
    .argument("[text]", "Post text")
    .option("--file <path>", "Read text from file")
    .option("--thread-file <path>", "JSON array of thread texts")
    .option("--reply-to <idOrUrl>", "Reply target")
    .option("--quote <idOrUrl>", "Quote target")
    .option("--media <file>", "Attach media (repeatable)", (value, prev: string[]) => {
      prev.push(value);
      return prev;
    }, [] as string[])
    .option("--batch <name>", "Create/add to a named batch (requires --at)")
    .option('--at <when>', 'Schedule time when using --batch')
    .option("--json", "JSON output")
    .option("--dry-run", "Validate and show binding without saving")
    .action(async (text, opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        if (opts.dryRun) {
          const { createDraft } = await import("./lib/drafts.js");
          const { emitSuccess } = await import("./lib/output.js");
          let texts: string[] = [];
          if (opts.threadFile) {
            const fs = await import("node:fs/promises");
            texts = JSON.parse(await fs.readFile(opts.threadFile, "utf8"));
          } else if (opts.file) {
            const fs = await import("node:fs/promises");
            texts = [await fs.readFile(opts.file, "utf8")];
          } else if (text !== undefined) {
            texts = [text];
          } else {
            throw new Error("Provide text, --file, or --thread-file");
          }
          // Build without persisting: reuse createDraft then delete? Simpler to just create and report.
          // For dry-run we still want no side effects - compute via createDraft internals.
          const draft = await createDraft({
            texts,
            replyToId: opts.replyTo,
            quoteId: opts.quote,
            mediaPaths: opts.media,
          });
          // Remove the accidentally saved draft for true dry-run
          const fs = await import("node:fs/promises");
          const { getPaths } = await import("./lib/paths.js");
          const path = await import("node:path");
          await fs.unlink(path.join(getPaths().draftsDir, `${draft.id}.json`)).catch(() => undefined);
          emitSuccess(
            mode,
            { dryRun: true, sha256: draft.bindingHash, warnings: draft.warnings },
            [
              "DRY RUN: draft not saved.",
              `binding sha256: ${draft.bindingHash}`,
              ...draft.warnings.map((w: string) => `warning: ${w}`),
            ]
          );
          return;
        }
        await cmdDraft(mode, {
          text,
          file: opts.file,
          threadFile: opts.threadFile,
          replyTo: opts.replyTo,
          quote: opts.quote,
          media: opts.media,
          batch: opts.batch,
          at: opts.at,
        });
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("draft-delete")
    .description("Create a delete draft for an own post (still needs approval)")
    .argument("<postIdOrUrl>", "Post id or URL to delete")
    .option("--json", "JSON output")
    .action(async (postIdOrUrl, opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdDraftDelete(mode, postIdOrUrl);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("approve")
    .description("Owner-only interactive approval (TTY + passphrase)")
    .argument("[id]", "Draft id (omit when using --batch)")
    .option("--batch <batchId>", "Approve every member of a batch in one passphrase step")
    .option("--json", "JSON output")
    .action(async (id, opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdApprove(mode, id, { batch: opts.batch });
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  const batch = program
    .command("batch")
    .description("Group drafts with per-post schedule times for batch approval");

  batch
    .command("create")
    .description("Create an empty batch")
    .argument("[name]", "Optional batch name")
    .option("--json", "JSON output")
    .action(async (name, opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdBatchCreate(mode, name);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  batch
    .command("add")
    .description("Add a draft to a batch with a scheduled time")
    .argument("<batchId>", "Batch id or name")
    .argument("<draftId>", "Draft id")
    .requiredOption('--at <when>', 'Schedule time, e.g. "2026-10-27 20:00 IST"')
    .option("--json", "JSON output")
    .action(async (batchId, draftId, opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdBatchAdd(mode, batchId, draftId, { at: opts.at });
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  batch
    .command("remove")
    .description("Remove a draft from a batch (invalidates batch approval)")
    .argument("<batchId>", "Batch id or name")
    .argument("<draftId>", "Draft id")
    .option("--json", "JSON output")
    .action(async (batchId, draftId, opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdBatchRemove(mode, batchId, draftId);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  batch
    .command("show")
    .description("Show a batch and its members")
    .argument("<batchId>", "Batch id or name")
    .option("--json", "JSON output")
    .action(async (batchId, opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdBatchShow(mode, batchId);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  batch
    .command("list")
    .description("List batches")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdBatchList(mode);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("revoke")
    .description("Revoke an approval")
    .argument("<id>", "Draft id")
    .option("--json", "JSON output")
    .option("--dry-run", "Show whether approval exists without revoking")
    .action(async (id, opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        if (opts.dryRun) {
          const { loadApprovals } = await import("./lib/approval.js");
          const { emitSuccess } = await import("./lib/output.js");
          const approvals = await loadApprovals();
          emitSuccess(
            mode,
            { dryRun: true, id, exists: Boolean(approvals[id]) },
            [
              approvals[id]
                ? `DRY RUN: would revoke approval for ${id}`
                : `DRY RUN: no approval for ${id}`,
            ]
          );
          return;
        }
        await cmdRevoke(mode, id);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("post")
    .description("Post an approved draft by id")
    .requiredOption("--id <id>", "Approved draft id")
    .option("--dry-run", "Validate and show payload without calling the API")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdPost(mode, { id: opts.id, dryRun: opts.dryRun });
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("delete")
    .description("Delete an own post via an approved delete draft")
    .requiredOption("--id <id>", "Approved delete draft id")
    .option("--dry-run", "Validate without calling the API")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdDelete(mode, { id: opts.id, dryRun: opts.dryRun });
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("schedule")
    .description("Schedule an approved draft, or list schedule with --list")
    .argument("[id]", "Draft id")
    .option('--at <when>', 'When to post, e.g. "2026-10-27 20:00 IST"')
    .option("--list", "List scheduled drafts")
    .option("--json", "JSON output")
    .option("--dry-run", "Parse time without writing schedule")
    .action(async (id, opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        if (opts.dryRun && !opts.list) {
          const { loadAppConfig } = await import("./lib/config.js");
          const { parseScheduleAt } = await import("./lib/timezone.js");
          const { emitSuccess } = await import("./lib/output.js");
          const config = await loadAppConfig();
          const parsed = parseScheduleAt(opts.at ?? "", config.defaultTimezone);
          emitSuccess(
            mode,
            { dryRun: true, id, atIso: parsed.atIso, timezone: parsed.timezone },
            [`DRY RUN: would schedule ${id} at ${parsed.atIso}`]
          );
          return;
        }
        await cmdSchedule(mode, id, { at: opts.at, list: opts.list });
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("unschedule")
    .description("Remove a draft from the schedule")
    .argument("<id>", "Draft id")
    .option("--json", "JSON output")
    .action(async (id, opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdUnschedule(mode, id);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("run-due")
    .description("Post due scheduled drafts (cron-friendly, lock-file idempotent)")
    .option("--dry-run", "Validate due items without posting")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdRunDue(mode, { dryRun: opts.dryRun });
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("pause")
    .description("Kill switch: block post, delete, and run-due")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdPause(mode);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("resume")
    .description("Clear the pause kill switch")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdResume(mode);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("status")
    .description("Show paused state, daily count, approvals, schedule")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdStatus(mode);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("metrics")
    .description("Public metrics for a post")
    .argument("<postIdOrUrl>", "Post id or URL")
    .option("--json", "JSON output")
    .action(async (postIdOrUrl, opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdMetrics(mode, postIdOrUrl);
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  program
    .command("timeline")
    .description("Read helpers for own posts")
    .option("--me", "Show your recent posts with public metrics")
    .option("--limit <n>", "Max results", "10")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const mode = modeFromOpts({ json: program.opts().json || opts.json });
      try {
        await cmdTimeline(mode, {
          me: opts.me,
          limit: Number(opts.limit) || 10,
        });
      } catch (error) {
        process.exitCode = emitError(mode, error);
      }
    });

  await program.parseAsync(argv);
}

export async function main(): Promise<void> {
  await runCli(process.argv);
}

const isDirectRun = process.argv[1] &&
  (process.argv[1].endsWith("/cli.ts") ||
    process.argv[1].endsWith("/cli.js") ||
    process.argv[1].endsWith("\\cli.ts") ||
    process.argv[1].endsWith("\\cli.js"));

if (isDirectRun) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(typeof (error as { exitCode?: number })?.exitCode === "number"
      ? (error as { exitCode: number }).exitCode
      : 1);
  });
}
