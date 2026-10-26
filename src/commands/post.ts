import { executePost, executeDelete } from "../lib/posting.js";
import { emitSuccess, type OutputMode, CliError } from "../lib/output.js";
import { EXIT } from "../types.js";

export async function cmdPost(
  mode: OutputMode,
  options: { id?: string; dryRun?: boolean }
): Promise<void> {
  if (!options.id) {
    throw new CliError("Missing --id. There is no raw post-text path.", EXIT.usage);
  }
  const result = await executePost(options.id, { dryRun: options.dryRun });
  if (result.dryRun) {
    emitSuccess(
      mode,
      {
        dryRun: true,
        id: options.id,
        tweets: result.plan.tweets.map((t) => ({
          text: t.text,
          replyToId: t.replyToId,
          quoteId: t.quoteId,
          media: t.mediaPaths,
        })),
        bindingHash: result.plan.draft.bindingHash,
      },
      [
        "DRY RUN: no API call made.",
        ...result.plan.tweets.map(
          (t, i) =>
            `would send [${i + 1}]: ${JSON.stringify(t.text)}${t.replyToId ? ` reply=${t.replyToId}` : ""}${t.quoteId ? ` quote=${t.quoteId}` : ""}${t.mediaPaths.length ? ` media=${t.mediaPaths.length}` : ""}`
        ),
      ]
    );
    return;
  }
  emitSuccess(
    mode,
    {
      id: options.id,
      postIds: result.postIds,
      urls: result.urls,
    },
    [
      `Posted draft ${options.id}`,
      ...result.urls.map((url, i) => `post ${i + 1}: ${url}`),
    ]
  );
}

export async function cmdDelete(
  mode: OutputMode,
  options: { id?: string; dryRun?: boolean }
): Promise<void> {
  if (!options.id) {
    throw new CliError(
      "Missing --id. Create a delete draft with `xpost draft-delete <post id|url>`, approve it, then delete.",
      EXIT.usage
    );
  }
  const result = await executeDelete(options.id, { dryRun: options.dryRun });
  if (result.dryRun) {
    emitSuccess(
      mode,
      { dryRun: true, id: options.id, postId: result.postId },
      [`DRY RUN: would delete post ${result.postId}`]
    );
    return;
  }
  emitSuccess(
    mode,
    { id: options.id, postId: result.postId, deleted: result.deleted },
    [`Deleted post ${result.postId}`]
  );
}
