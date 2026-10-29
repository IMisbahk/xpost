import {
  approveDraftInteractive,
  approveManyInteractive,
  approveDraftViaChat,
  approveManyViaChat,
  revokeApproval,
  loadApprovals,
  type ApprovalPreviewItem,
} from "../lib/approval.js";
import { loadDraft } from "../lib/drafts.js";
import { emitSuccess, type OutputMode, CliError } from "../lib/output.js";
import { EXIT } from "../types.js";
import { appendAudit } from "../lib/audit.js";
import { assertInteractiveApprovalAllowed } from "../lib/tty.js";
import { loadBatch, markBatchApproved, refreshBatchValidity } from "../lib/batches.js";
import { getScheduleForDraft } from "../lib/schedule.js";
import type { ApprovalRecord } from "../types.js";

export type ApproveOptions = {
  batch?: string;
  chat?: string;
  quote?: string;
  confirmHash?: string;
  yesHash?: string;
};

export async function cmdApprove(
  mode: OutputMode,
  id: string | undefined,
  options: ApproveOptions = {}
): Promise<void> {
  if (options.chat) {
    await approveViaChat(mode, options.chat, {
      quote: options.quote,
      confirmHash: options.confirmHash ?? options.yesHash,
    });
    return;
  }

  assertInteractiveApprovalAllowed();

  if (options.batch) {
    await approveBatch(mode, options.batch);
    return;
  }

  if (!id) {
    throw new CliError(
      "Missing draft id (or pass --batch <batch id>, or --chat <draft-or-batch-id>).",
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
    detail: `mode=tty expires ${approval.expiresAt}`,
  });
  emitSuccess(
    mode,
    {
      id,
      approved: true,
      mode: "tty",
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

async function resolveChatTarget(id: string): Promise<
  | { kind: "draft"; draftId: string }
  | { kind: "batch"; batchId: string }
> {
  try {
    await loadDraft(id);
    return { kind: "draft", draftId: id };
  } catch (error) {
    if (!(error instanceof CliError) || error.exitCode !== EXIT.notFound) {
      throw error;
    }
  }
  try {
    const batch = await loadBatch(id);
    return { kind: "batch", batchId: batch.id };
  } catch (error) {
    if (!(error instanceof CliError) || error.exitCode !== EXIT.notFound) {
      throw error;
    }
  }
  throw new CliError(`Draft or batch not found: ${id}`, EXIT.notFound);
}

async function approveViaChat(
  mode: OutputMode,
  id: string,
  options: { quote?: string; confirmHash?: string }
): Promise<void> {
  if (typeof options.quote !== "string" || options.quote.trim().length === 0) {
    throw new CliError(
      "Chat approval requires --quote with the owner's exact yes message.",
      EXIT.usage
    );
  }
  const quote = options.quote;
  const target = await resolveChatTarget(id);

  if (target.kind === "batch") {
    await approveBatchViaChat(mode, target.batchId, {
      quote,
      confirmHash: options.confirmHash,
      json: mode.json,
    });
    return;
  }

  const draft = await loadDraft(target.draftId);
  const schedule = await getScheduleForDraft(draft.id);
  const { approval, preview } = await approveDraftViaChat(draft, {
    quote,
    scheduledAtIso: schedule?.atIso ?? null,
    timezone: schedule?.timezone,
    batchId: draft.batchId,
    confirmHash: options.confirmHash,
    printPreview: !mode.json,
  });

  await appendAudit({
    action: "approve-chat",
    draftId: draft.id,
    textHash: draft.textHash,
    detail: `mode=chat quote=${JSON.stringify(quote)} binding=${approval.bindingHash} expires ${approval.expiresAt}`,
  });

  emitChatSuccess(mode, {
    id: draft.id,
    batchId: undefined,
    quote,
    approvals: [approval],
    previews: [preview],
  });
}

async function approveBatchViaChat(
  mode: OutputMode,
  batchId: string,
  options: { quote: string; confirmHash?: string; json: boolean }
): Promise<void> {
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

  const { approvals, previews } = await approveManyViaChat(items, {
    quote: options.quote,
    confirmHash: options.confirmHash,
    printPreview: !options.json,
  });
  await markBatchApproved(current);

  const textHashes = previews.map((p) => p.textHash).join(",");
  await appendAudit({
    action: "approve-chat-batch",
    detail: `mode=chat batch=${current.id} quote=${JSON.stringify(options.quote)} count=${approvals.length} textHashes=${textHashes}`,
  });

  emitChatSuccess(mode, {
    id: current.id,
    batchId: current.id,
    quote: options.quote,
    approvals,
    previews,
  });
}

function emitChatSuccess(
  mode: OutputMode,
  data: {
    id: string;
    batchId?: string;
    quote: string;
    approvals: ApprovalRecord[];
    previews: ApprovalPreviewItem[];
  }
): void {
  const posts = data.previews.map((preview, index) => {
    const approval = data.approvals[index];
    return {
      draftId: preview.draftId,
      kind: preview.kind,
      texts: preview.texts,
      textHash: preview.textHash,
      bindingHash: preview.bindingHash,
      media: preview.media,
      mediaHash: preview.mediaHash,
      target: preview.target,
      scheduledAtIso: preview.scheduledAtIso,
      timezone: preview.timezone,
      deletePostId: preview.deletePostId,
      expiresAt: approval.expiresAt,
      approvedAt: approval.approvedAt,
      mode: "chat" as const,
      quote: data.quote,
      scheme: approval.scheme,
    };
  });

  emitSuccess(
    mode,
    {
      id: data.id,
      batchId: data.batchId,
      approved: true,
      mode: "chat",
      quote: data.quote,
      posts,
      approvals: data.approvals.map((a) => ({
        draftId: a.draftId,
        bindingHash: a.bindingHash,
        textHash: data.previews.find((p) => p.draftId === a.draftId)?.textHash,
        scheduledAtIso: a.scheduledAtIso,
        expiresAt: a.expiresAt,
        mode: a.mode,
        quote: a.quote,
      })),
    },
    [
      data.batchId
        ? `Chat-approved batch ${data.batchId} (${data.approvals.length} posts)`
        : `Chat-approved ${data.id}`,
      `quote: ${data.quote}`,
      ...posts.map(
        (p) =>
          `  ${p.draftId} text sha256=${p.textHash} scheduled ${p.scheduledAtIso ?? "(none)"} expires ${p.expiresAt}`
      ),
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
    detail: `mode=tty batch=${current.id} count=${approvals.length}`,
  });
  emitSuccess(
    mode,
    {
      batchId: current.id,
      approved: true,
      mode: "tty",
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
