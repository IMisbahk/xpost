import {
  scheduleDraft,
  unscheduleDraft,
  listSchedule,
  assertScheduleAtPresent,
  getDueItems,
  withRunDueLock,
} from "../lib/schedule.js";
import { loadDraft } from "../lib/drafts.js";
import { executePost } from "../lib/posting.js";
import { emitSuccess, type OutputMode, CliError } from "../lib/output.js";
import { EXIT } from "../types.js";
import { appendAudit } from "../lib/audit.js";
import { assertNotPaused } from "../lib/safety.js";

export async function cmdSchedule(
  mode: OutputMode,
  id: string | undefined,
  options: { at?: string; list?: boolean }
): Promise<void> {
  if (options.list) {
    const items = await listSchedule();
    emitSuccess(
      mode,
      { items },
      items.length === 0
        ? ["No scheduled drafts."]
        : items.map((i) => `${i.draftId} at ${i.atLocal} (utc ${i.atIso})`)
    );
    return;
  }
  if (!id) {
    throw new CliError("Missing draft id (or pass --list).", EXIT.usage);
  }
  await loadDraft(id);
  const at = assertScheduleAtPresent(options.at);
  const item = await scheduleDraft(id, at);
  await appendAudit({
    action: "schedule",
    draftId: id,
    detail: item.atIso,
  });
  emitSuccess(
    mode,
    { id, atIso: item.atIso, timezone: item.timezone },
    [`Scheduled ${id} for ${item.atIso} (${item.timezone})`]
  );
}

export async function cmdUnschedule(mode: OutputMode, id: string): Promise<void> {
  if (!id) throw new CliError("Missing draft id.", EXIT.usage);
  const ok = await unscheduleDraft(id);
  if (!ok) throw new CliError(`No schedule entry for ${id}`, EXIT.notFound);
  await appendAudit({ action: "unschedule", draftId: id });
  emitSuccess(mode, { id, unscheduled: true }, [`Unscheduled ${id}`]);
}

export async function cmdRunDue(
  mode: OutputMode,
  options: { dryRun?: boolean } = {}
): Promise<void> {
  await assertNotPaused();
  const summary = await withRunDueLock(async () => {
    const due = await getDueItems();
    const results: Array<Record<string, unknown>> = [];
    for (const item of due) {
      try {
        if (options.dryRun) {
          const { buildPostPlan } = await import("../lib/posting.js");
          await buildPostPlan(item.draftId);
          results.push({ id: item.draftId, dryRun: true, ok: true });
          continue;
        }
        const posted = await executePost(item.draftId);
        results.push({
          id: item.draftId,
          ok: true,
          postIds: posted.postIds,
          urls: posted.urls,
        });
      } catch (error) {
        results.push({
          id: item.draftId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { dueCount: due.length, results };
  });

  await appendAudit({
    action: "run-due",
    detail: `due=${summary.dueCount} dryRun=${Boolean(options.dryRun)}`,
  });

  emitSuccess(
    mode,
    summary,
    [
      `Due items: ${summary.dueCount}`,
      ...summary.results.map((r) =>
        r.ok
          ? `${r.id}: ok${r.dryRun ? " (dry-run)" : ""}`
          : `${r.id}: failed - ${r.error}`
      ),
    ]
  );
}
