import {
  approveDraftInteractive,
  approveManyInteractive,
  revokeApproval,
  loadApprovals,
} from "../lib/approval.js";
import { loadDraft } from "../lib/drafts.js";
import { emitSuccess, type OutputMode, CliError } from "../lib/output.js";
import { EXIT } from "../types.js";
import { appendAudit } from "../lib/audit.js";
import { assertInteractiveApprovalAllowed } from "../lib/tty.js";
import { loadBatch, markBatchApproved, refreshBatchValidity } from "../lib/batches.js";
import { getScheduleForDraft } from "../lib/schedule.js";

export async function cmdApprove(
  mode: OutputMode,
  id: string | undefined,
  options: { batch?: string } = {}
): Promise<void> {
  assertInteractiveApprovalAllowed();

  if (options.batch) {
    await approveBatch(mode, options.batch);
    return;
  }

  if (!id) {
    throw new CliError(
      "Missing draft id (or pass --batch <batch id>).",
      EXIT.usage
    );
  }
  const draft = await loadDraft(id);
  const schedule = await getScheduleForDraft(id);
  const approval = await approveDraftInteractive(draft, {
    scheduledAtIso: schedule?.atIso ?? null,
    timezone: schedule?.timezone,
    batchId: draft.batchId,
  });
  await appendAudit({
    action: "approve",
    draftId: id,
    textHash: draft.textHash,
    detail: `expires ${approval.expiresAt}`,
  });
  emitSuccess(
    mode,
    {
      id,
      approved: true,
      bindingHash: approval.bindingHash,
      scheduledAtIso: approval.scheduledAtIso,
      expiresAt: approval.expiresAt,
      scheme: approval.scheme,
    },
    [
      `Approved ${id}`,
      `binding sha256: ${approval.bindingHash}`,
      `scheduled: ${approval.scheduledAtIso ?? "(none)"}`,
      `expires: ${approval.expiresAt}`,
    ]
  );
}

async function approveBatch(mode: OutputMode, batchId: string): Promise<void> {
  const batch = await loadBatch(batchId);
  await refreshBatchValidity(batch);
  const current = await loadBatch(batch.id);
  if (current.members.length === 0) {
    throw new CliError("Batch has no members.", EXIT.usage);
  }

  const items = [];
  for (const member of current.members) {
    const draft = await loadDraft(member.draftId);
    if (draft.bindingHash !== member.contentBindingHash) {
      throw new CliError(
        `Draft ${member.draftId} changed since it was added to the batch. Re-add it, then approve.`,
        EXIT.hashMismatch
      );
    }
    items.push({
      draft,
      scheduledAtIso: member.atIso,
      timezone: member.timezone,
      batchId: current.id,
    });
  }

  const approvals = await approveManyInteractive(items);
  await markBatchApproved(current);
  await appendAudit({
    action: "approve-batch",
    detail: `batch=${current.id} count=${approvals.length}`,
  });
  emitSuccess(
    mode,
    {
      batchId: current.id,
      approved: true,
      approvals: approvals.map((a) => ({
        draftId: a.draftId,
        bindingHash: a.bindingHash,
        scheduledAtIso: a.scheduledAtIso,
        expiresAt: a.expiresAt,
      })),
    },
    [
      `Approved batch ${current.id} (${approvals.length} posts)`,
      ...approvals.map(
        (a) =>
          `  ${a.draftId} expires ${a.expiresAt} scheduled ${a.scheduledAtIso}`
      ),
    ]
  );
}

export async function cmdRevoke(mode: OutputMode, id: string): Promise<void> {
  if (!id) {
    throw new CliError("Missing draft id.", EXIT.usage);
  }
  const ok = await revokeApproval(id);
  if (!ok) {
    throw new CliError(`No approval found for ${id}`, EXIT.notFound);
  }
  await appendAudit({ action: "revoke", draftId: id });
  emitSuccess(mode, { id, revoked: true }, [`Revoked approval for ${id}`]);
}

export async function listPendingApprovals(): Promise<string[]> {
  const approvals = await loadApprovals();
  const now = Date.now();
  return Object.values(approvals)
    .filter((a) => Date.parse(a.expiresAt) >= now)
    .map((a) => a.draftId);
}
