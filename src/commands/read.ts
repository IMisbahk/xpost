import { getXApiClient } from "../xapi/factory.js";
import { extractPostId } from "../lib/drafts.js";
import { emitSuccess, type OutputMode, CliError } from "../lib/output.js";
import { EXIT } from "../types.js";

export async function cmdMetrics(
  mode: OutputMode,
  postIdOrUrl: string
): Promise<void> {
  if (!postIdOrUrl) throw new CliError("Missing post id or url.", EXIT.usage);
  const id = extractPostId(postIdOrUrl);
  const client = await getXApiClient();
  const metrics = await client.getTweetMetrics(id);
  emitSuccess(
    mode,
    {
      id: metrics.id,
      text: metrics.text,
      publicMetrics: metrics.publicMetrics,
    },
    [
      `id: ${metrics.id}`,
      `likes: ${metrics.publicMetrics.likeCount}`,
      `reposts: ${metrics.publicMetrics.retweetCount}`,
      `replies: ${metrics.publicMetrics.replyCount}`,
      `quotes: ${metrics.publicMetrics.quoteCount}`,
      metrics.publicMetrics.impressionCount !== undefined
        ? `impressions: ${metrics.publicMetrics.impressionCount}`
        : "",
    ].filter(Boolean)
  );
}

export async function cmdTimeline(
  mode: OutputMode,
  options: { me?: boolean; limit?: number }
): Promise<void> {
  if (!options.me) {
    throw new CliError("Only `--me` is supported (own recent posts).", EXIT.usage);
  }
  const client = await getXApiClient();
  const tweets = await client.getMyTimeline(options.limit ?? 10);
  emitSuccess(
    mode,
    { tweets },
    tweets.length === 0
      ? ["No recent posts."]
      : tweets.map(
          (t) =>
            `${t.id} likes=${t.publicMetrics.likeCount} ${t.text.slice(0, 80)}`
        )
  );
}
