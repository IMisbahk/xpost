import { checkApprovalForDraft } from "./approval.js";
import { loadDraft } from "./drafts.js";
import {
  assertNotDuplicateTextExcluding,
  assertNotPaused,
  assertUnderDailyCap,
  incrementDailyCount,
  recordPosted,
} from "./safety.js";
import { appendAudit } from "./audit.js";
import { getXApiClient } from "../xapi/factory.js";
import type { DraftRecord } from "../types.js";
import { CliError } from "./output.js";
import { EXIT } from "../types.js";
import { unscheduleDraft } from "./schedule.js";

export type PostPlan = {
  draft: DraftRecord;
  tweets: Array<{
    text: string;
    replyToId?: string;
    quoteId?: string;
    mediaPaths: string[];
  }>;
};

export async function buildPostPlan(draftId: string): Promise<PostPlan> {
  const draft = await loadDraft(draftId);
  if (draft.kind !== "post") {
    throw new CliError("Draft is not a post draft.", EXIT.usage);
  }

  await assertNotPaused();
  await assertUnderDailyCap(draft.texts.length);
  await assertNotDuplicateTextExcluding(draft.textHash, draft.id);

  const { getScheduleForDraft } = await import("./schedule.js");
  const schedule = await getScheduleForDraft(draftId);
  const approval = await checkApprovalForDraft(
    draft,
    schedule ? schedule.atIso : null
  );
  if (!approval.ok) {
    throw new CliError(approval.reason, approval.exitCode);
  }

  // Re-check media files still match hashes
  if (draft.media.length > 0) {
    const { buildMediaRefs } = await import("./drafts.js");
    const current = await buildMediaRefs(draft.media.map((m) => m.path));
    for (let i = 0; i < draft.media.length; i++) {
      if (current[i].sha256 !== draft.media[i].sha256) {
        throw new CliError(
          `Media file changed since draft: ${draft.media[i].path}`,
          EXIT.hashMismatch
        );
      }
    }
  }

  const tweets = draft.texts.map((text, index) => ({
    text,
    replyToId: index === 0 ? draft.target.replyToId : undefined,
    quoteId: index === 0 ? draft.target.quoteId : undefined,
    mediaPaths:
      index === 0 ? draft.media.map((m) => m.path) : ([] as string[]),
  }));

  return { draft, tweets };
}

export async function executePost(
  draftId: string,
  options: { dryRun?: boolean } = {}
): Promise<{
  dryRun: boolean;
  postIds: string[];
  urls: string[];
  plan: PostPlan;
}> {
  const plan = await buildPostPlan(draftId);

  if (options.dryRun) {
    return { dryRun: true, postIds: [], urls: [], plan };
  }

  const client = await getXApiClient();
  const postIds: string[] = [];
  const urls: string[] = [];
  let previousId: string | undefined;

  for (let i = 0; i < plan.tweets.length; i++) {
    const tweet = plan.tweets[i];
    let mediaIds: string[] | undefined;
    if (tweet.mediaPaths.length > 0) {
      mediaIds = [];
      for (const mediaPath of tweet.mediaPaths) {
        const media = plan.draft.media.find((m) => m.path === mediaPath)!;
        const uploaded = await client.uploadMedia(mediaPath, media.mimeType);
        mediaIds.push(uploaded.mediaId);
      }
    }

    const replyToId =
      i === 0 ? tweet.replyToId : previousId;
    const created = await client.createTweet({
      text: tweet.text,
      replyToId,
      quoteId: tweet.quoteId,
      mediaIds,
    });
    postIds.push(created.id);
    urls.push(`https://x.com/i/status/${created.id}`);
    previousId = created.id;
  }

  await recordPosted({
    draftId: plan.draft.id,
    textHash: plan.draft.textHash,
    postIds,
    postedAt: new Date().toISOString(),
    urls,
  });
  await incrementDailyCount(postIds.length);
  await unscheduleDraft(draftId);
  await appendAudit({
    action: "post",
    draftId,
    textHash: plan.draft.textHash,
    postId: postIds[0],
    url: urls[0],
    detail: `posted ${postIds.length} status(es)`,
  });

  return { dryRun: false, postIds, urls, plan };
}

export async function executeDelete(
  draftId: string,
  options: { dryRun?: boolean } = {}
): Promise<{ dryRun: boolean; postId: string; deleted: boolean }> {
  const draft = await loadDraft(draftId);
  if (draft.kind !== "delete" || !draft.deletePostId) {
    throw new CliError("Draft is not a delete draft.", EXIT.usage);
  }

  await assertNotPaused();

  const approval = await checkApprovalForDraft(draft);
  if (!approval.ok) {
    throw new CliError(approval.reason, approval.exitCode);
  }

  if (options.dryRun) {
    return { dryRun: true, postId: draft.deletePostId, deleted: false };
  }

  const client = await getXApiClient();
  // Verify ownership via whoami is implicit: API only allows deleting own tweets
  const result = await client.deleteTweet(draft.deletePostId);
  await appendAudit({
    action: "delete",
    draftId,
    postId: draft.deletePostId,
    detail: "deleted own post",
  });
  return { dryRun: false, postId: draft.deletePostId, deleted: result.deleted };
}
