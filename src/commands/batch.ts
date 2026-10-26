import {
  createBatch,
  addDraftToBatch,
  removeDraftFromBatch,
  loadBatch,
  listBatches,
  refreshBatchValidity,
} from "../lib/batches.js";
import { loadDraft } from "../lib/drafts.js";
import { emitSuccess, type OutputMode, CliError } from "../lib/output.js";
import { EXIT } from "../types.js";
import { appendAudit } from "../lib/audit.js";
import { assertScheduleAtPresent } from "../lib/schedule.js";

export async function cmdBatchCreate(
  mode: OutputMode,
  name?: string
): Promise<void> {
  const batch = await createBatch(name);
  await appendAudit({
    action: "batch-create",
    detail: `${batch.id} name=${batch.name}`,
  });
  emitSuccess(
    mode,
    { id: batch.id, name: batch.name },
    [
      `batch id: ${batch.id}`,
      `name: ${batch.name}`,
      `Next: xpost batch add ${batch.id} <draft-id> --at "2026-10-27 20:00 IST"`,
    ]
  );
}

export async function cmdBatchAdd(
  mode: OutputMode,
  batchId: string,
  draftId: string,
  options: { at?: string }
): Promise<void> {
  if (!batchId || !draftId) {
    throw new CliError("Usage: xpost batch add <batch id> <draft id> --at ...", EXIT.usage);
  }
  const at = assertScheduleAtPresent(options.at);
  const batch = await addDraftToBatch(batchId, draftId, at);
  const member = batch.members.find((m) => m.draftId === draftId)!;
  await appendAudit({
    action: "batch-add",
    draftId,
    detail: `batch=${batch.id} at=${member.atIso}`,
  });
  emitSuccess(
    mode,
    {
      batchId: batch.id,
      draftId,
      atIso: member.atIso,
      timezone: member.timezone,
      approved: batch.approved,
      memberCount: batch.members.length,
    },
    [
      `Added ${draftId} to batch ${batch.id}`,
      `scheduled: ${member.atIso} (${member.timezone})`,
      batch.approved
        ? "Batch still marked approved."
        : "Batch requires approval (or re-approval).",
    ]
  );
}

export async function cmdBatchRemove(
  mode: OutputMode,
  batchId: string,
  draftId: string
): Promise<void> {
  const batch = await removeDraftFromBatch(batchId, draftId);
  await appendAudit({
    action: "batch-remove",
    draftId,
    detail: `batch=${batch.id}`,
  });
  emitSuccess(
    mode,
    { batchId: batch.id, draftId, memberCount: batch.members.length },
    [`Removed ${draftId} from batch ${batch.id}`]
  );
}

export async function cmdBatchShow(
  mode: OutputMode,
  batchId: string
): Promise<void> {
  if (!batchId) throw new CliError("Missing batch id or name.", EXIT.usage);
  const batch = await loadBatch(batchId);
  await refreshBatchValidity(batch);
  const refreshed = await loadBatch(batch.id);
  const members = [];
  for (const member of refreshed.members) {
    let textPreview = "";
    try {
      const draft = await loadDraft(member.draftId);
      textPreview = draft.texts[0]?.slice(0, 80) ?? "";
    } catch {
      textPreview = "(draft missing)";
    }
    members.push({ ...member, textPreview });
  }
  emitSuccess(
    mode,
    {
      id: refreshed.id,
      name: refreshed.name,
      approved: refreshed.approved,
      approvedAt: refreshed.approvedAt,
      members,
    },
    [
      `batch ${refreshed.id} (${refreshed.name})`,
      `approved: ${refreshed.approved}`,
      ...members.map(
        (m) =>
          `  - ${m.draftId} at ${m.atIso} (${m.timezone}) ${m.textPreview}`
      ),
    ]
  );
}

export async function cmdBatchList(mode: OutputMode): Promise<void> {
  const batches = await listBatches();
  emitSuccess(
    mode,
    { batches },
    batches.length === 0
      ? ["No batches."]
      : batches.map(
          (b) =>
            `${b.id} ${b.name} members=${b.members.length} approved=${b.approved}`
        )
  );
}
