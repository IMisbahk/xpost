import path from "node:path";
import { randomHex } from "./crypto.js";
import { getPaths } from "./paths.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fsutil.js";
import type { BatchMember, BatchRecord } from "../types.js";
import { CliError } from "./output.js";
import { EXIT } from "../types.js";
import { loadDraft, saveDraft } from "./drafts.js";
import { parseScheduleAt } from "./timezone.js";
import { loadAppConfig } from "./config.js";
import { revokeApprovals } from "./approval.js";
import { scheduleDraft, unscheduleDraft } from "./schedule.js";

async function loadIndex(): Promise<Record<string, string>> {
  const { batchesIndexFile, batchesDir } = getPaths();
  await ensureDir(batchesDir, 0o700);
  return readJsonFile<Record<string, string>>(batchesIndexFile, {});
}

async function saveIndex(index: Record<string, string>): Promise<void> {
  const { batchesIndexFile } = getPaths();
  await writeJsonFile(batchesIndexFile, index, 0o600);
}

export async function saveBatch(batch: BatchRecord): Promise<void> {
  const { batchesDir } = getPaths();
  await ensureDir(batchesDir, 0o700);
  await writeJsonFile(path.join(batchesDir, `${batch.id}.json`), batch, 0o600);
}

export async function loadBatch(idOrName: string): Promise<BatchRecord> {
  const { batchesDir } = getPaths();
  const byId = await readJsonFile<BatchRecord | null>(
    path.join(batchesDir, `${idOrName}.json`),
    null
  );
  if (byId) return byId;

  const index = await loadIndex();
  const id = index[idOrName];
  if (!id) {
    throw new CliError(`Batch not found: ${idOrName}`, EXIT.notFound);
  }
  const batch = await readJsonFile<BatchRecord | null>(
    path.join(batchesDir, `${id}.json`),
    null
  );
  if (!batch) {
    throw new CliError(`Batch not found: ${idOrName}`, EXIT.notFound);
  }
  return batch;
}

async function invalidateBatchApprovals(batch: BatchRecord): Promise<void> {
  if (!batch.approved && !batch.approvedAt) return;
  await revokeApprovals(batch.members.map((m) => m.draftId));
  batch.approved = false;
  batch.approvedAt = undefined;
}

export async function createBatch(name?: string): Promise<BatchRecord> {
  const batchName = (name ?? `batch-${Date.now()}`).trim();
  if (!batchName) {
    throw new CliError("Batch name cannot be empty.", EXIT.usage);
  }
  const index = await loadIndex();
  if (index[batchName]) {
    throw new CliError(`Batch name already exists: ${batchName}`, EXIT.usage);
  }
  const batch: BatchRecord = {
    id: randomHex(8),
    name: batchName,
    createdAt: new Date().toISOString(),
    members: [],
    approved: false,
  };
  index[batchName] = batch.id;
  await saveIndex(index);
  await saveBatch(batch);
  return batch;
}

export async function addDraftToBatch(
  batchIdOrName: string,
  draftId: string,
  atRaw: string
): Promise<BatchRecord> {
  const batch = await loadBatch(batchIdOrName);
  const draft = await loadDraft(draftId);
  if (draft.kind !== "post") {
    throw new CliError("Only post drafts can be added to a batch.", EXIT.usage);
  }
  const config = await loadAppConfig();
  const parsed = parseScheduleAt(atRaw, config.defaultTimezone);

  await invalidateBatchApprovals(batch);

  const member: BatchMember = {
    draftId: draft.id,
    atIso: parsed.atIso,
    timezone: parsed.timezone,
    contentBindingHash: draft.bindingHash,
  };
  const existing = batch.members.findIndex((m) => m.draftId === draft.id);
  if (existing >= 0) batch.members[existing] = member;
  else batch.members.push(member);

  draft.batchId = batch.id;
  await saveDraft(draft);
  await scheduleDraft(draft.id, atRaw, { batchId: batch.id });
  await saveBatch(batch);
  return batch;
}

export async function removeDraftFromBatch(
  batchIdOrName: string,
  draftId: string
): Promise<BatchRecord> {
  const batch = await loadBatch(batchIdOrName);
  const before = batch.members.length;
  batch.members = batch.members.filter((m) => m.draftId !== draftId);
  if (batch.members.length === before) {
    throw new CliError(`Draft ${draftId} is not in batch ${batch.id}`, EXIT.notFound);
  }
  await invalidateBatchApprovals(batch);
  await unscheduleDraft(draftId);
  try {
    const draft = await loadDraft(draftId);
    if (draft.batchId === batch.id) {
      draft.batchId = undefined;
      await saveDraft(draft);
    }
  } catch {
    // draft may already be gone
  }
  await saveBatch(batch);
  return batch;
}

export async function markBatchApproved(batch: BatchRecord): Promise<void> {
  batch.approved = true;
  batch.approvedAt = new Date().toISOString();
  // Refresh content binding hashes at approval time
  for (const member of batch.members) {
    const draft = await loadDraft(member.draftId);
    member.contentBindingHash = draft.bindingHash;
  }
  await saveBatch(batch);
}

export async function listBatches(): Promise<BatchRecord[]> {
  const index = await loadIndex();
  const batches: BatchRecord[] = [];
  const seen = new Set<string>();
  for (const id of Object.values(index)) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      batches.push(await loadBatch(id));
    } catch {
      // skip missing
    }
  }
  return batches.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * If a batch member's draft content hash drifted, invalidate that approval.
 * Returns true if the batch was marked unapproved.
 */
export async function refreshBatchValidity(batch: BatchRecord): Promise<boolean> {
  let dirty = false;
  for (const member of batch.members) {
    try {
      const draft = await loadDraft(member.draftId);
      if (draft.bindingHash !== member.contentBindingHash) {
        dirty = true;
        break;
      }
    } catch {
      dirty = true;
      break;
    }
  }
  if (dirty && batch.approved) {
    await invalidateBatchApprovals(batch);
    await saveBatch(batch);
    return true;
  }
  return false;
}
