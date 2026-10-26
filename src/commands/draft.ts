import fs from "node:fs/promises";
import { createDraft, extractPostId } from "../lib/drafts.js";
import { assertNotDuplicateTextExcluding } from "../lib/safety.js";
import { emitSuccess, type OutputMode, CliError } from "../lib/output.js";
import { EXIT } from "../types.js";
import { appendAudit } from "../lib/audit.js";
import { addDraftToBatch, createBatch, loadBatch } from "../lib/batches.js";

export type DraftOptions = {
  text?: string;
  file?: string;
  threadFile?: string;
  replyTo?: string;
  quote?: string;
  media?: string[];
  batch?: string;
  at?: string;
};

export async function cmdDraft(
  mode: OutputMode,
  options: DraftOptions
): Promise<void> {
  let texts: string[] = [];

  if (options.threadFile) {
    const raw = await fs.readFile(options.threadFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) {
      throw new CliError(
        "thread-file must be a JSON array of strings.",
        EXIT.usage
      );
    }
    texts = parsed;
  } else if (options.file) {
    texts = [await fs.readFile(options.file, "utf8")];
  } else if (options.text !== undefined) {
    texts = [options.text];
  } else {
    throw new CliError(
      'Provide text, --file, or --thread-file. Example: xpost draft "hello"',
      EXIT.usage
    );
  }

  if (options.batch && !options.at) {
    throw new CliError(
      'When using --batch, also pass --at "2026-10-27 20:00 IST".',
      EXIT.usage
    );
  }

  const replyToId = options.replyTo
    ? extractPostId(options.replyTo)
    : undefined;
  const quoteId = options.quote ? extractPostId(options.quote) : undefined;

  const draft = await createDraft({
    kind: "post",
    texts,
    replyToId,
    quoteId,
    mediaPaths: options.media ?? [],
  });

  try {
    await assertNotDuplicateTextExcluding(draft.textHash, draft.id);
  } catch (error) {
    throw error;
  }

  let batchId: string | undefined;
  if (options.batch && options.at) {
    let batch;
    try {
      batch = await loadBatch(options.batch);
    } catch {
      batch = await createBatch(options.batch);
    }
    const updated = await addDraftToBatch(batch.id, draft.id, options.at);
    batchId = updated.id;
  }

  await appendAudit({
    action: "draft",
    draftId: draft.id,
    textHash: draft.textHash,
    detail: batchId ? `batch=${batchId}` : undefined,
  });

  emitSuccess(
    mode,
    {
      id: draft.id,
      sha256: draft.bindingHash,
      textHash: draft.textHash,
      weightedLength: draft.weightedLength,
      characterLimit: draft.characterLimit,
      warnings: draft.warnings,
      replyToId,
      quoteId,
      media: draft.media.map((m) => ({ path: m.path, sha256: m.sha256 })),
      batchId,
    },
    [
      `draft id: ${draft.id}`,
      `binding sha256: ${draft.bindingHash}`,
      `weighted length: ${draft.weightedLength}/${draft.characterLimit}`,
      ...(batchId ? [`batch: ${batchId}`] : []),
      ...draft.warnings.map((w) => `warning: ${w}`),
      batchId
        ? `Next: owner runs \`xpost approve --batch ${batchId}\` in an interactive terminal.`
        : "Next: owner runs `xpost approve " + draft.id + "` in an interactive terminal.",
    ]
  );
}

export async function cmdDraftDelete(
  mode: OutputMode,
  postIdOrUrl: string
): Promise<void> {
  const postId = extractPostId(postIdOrUrl);
  const draft = await createDraft({
    kind: "delete",
    texts: [],
    deletePostId: postId,
  });
  await appendAudit({
    action: "draft-delete",
    draftId: draft.id,
    postId,
  });
  emitSuccess(
    mode,
    { id: draft.id, sha256: draft.bindingHash, deletePostId: postId },
    [
      `delete draft id: ${draft.id}`,
      `target post: ${postId}`,
      `binding sha256: ${draft.bindingHash}`,
      `Next: owner runs \`xpost approve ${draft.id}\` then \`xpost delete --id ${draft.id}\`.`,
    ]
  );
}
