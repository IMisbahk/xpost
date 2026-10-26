import fs from "node:fs/promises";
import path from "node:path";
import type { AuthConfig } from "../types.js";
import type {
  CreateTweetInput,
  CreateTweetResult,
  MediaUploadResult,
  TweetMetrics,
  UserInfo,
} from "../types.js";
import type { XApiClient } from "./client.js";
import { buildOAuth1Header, type OAuth1Creds } from "./oauth1.js";
import { redactText } from "../lib/redactor.js";
import { CliError } from "../lib/output.js";
import { EXIT } from "../types.js";

const API_BASE = "https://api.x.com";

type RequestOptions = {
  method: string;
  url: string;
  body?: unknown;
  formData?: FormData;
  oauthExtra?: Record<string, string>;
  contentType?: string;
};

export class RealXApiClient implements XApiClient {
  private readonly auth: AuthConfig;

  constructor(auth: AuthConfig) {
    this.auth = auth;
  }

  private oauth1Creds(): OAuth1Creds | null {
    if (
      this.auth.apiKey &&
      this.auth.apiSecret &&
      this.auth.accessToken &&
      this.auth.accessSecret
    ) {
      return {
        apiKey: this.auth.apiKey,
        apiSecret: this.auth.apiSecret,
        accessToken: this.auth.accessToken,
        accessSecret: this.auth.accessSecret,
      };
    }
    return null;
  }

  private async request<T>(options: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "xpost-cli/1.0",
    };

    const oauth1 = this.oauth1Creds();
    if (oauth1) {
      headers.Authorization = buildOAuth1Header(
        options.method,
        options.url,
        oauth1,
        options.oauthExtra
      );
    } else if (this.auth.oauth2Token) {
      headers.Authorization = `Bearer ${this.auth.oauth2Token}`;
    } else {
      throw new CliError("No usable X credentials configured.", EXIT.auth);
    }

    let body: BodyInit | undefined;
    if (options.formData) {
      body = options.formData;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = options.contentType ?? "application/json";
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(options.url, {
        method: options.method,
        headers,
        body,
      });
    } catch (error) {
      throw new CliError(
        redactText(`Network error calling X API: ${error instanceof Error ? error.message : String(error)}`),
        EXIT.generic
      );
    }

    const text = await response.text();
    const safeText = redactText(text);
    if (!response.ok) {
      throw new CliError(
        `X API ${options.method} ${options.url} failed (${response.status}): ${safeText}`,
        EXIT.generic
      );
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError(`X API returned non-JSON: ${safeText}`, EXIT.generic);
    }
  }

  async verifyCredentials(): Promise<UserInfo> {
    const data = await this.request<{
      data: { id: string; username: string; name: string };
    }>({
      method: "GET",
      url: `${API_BASE}/2/users/me?user.fields=username,name`,
    });
    return {
      id: data.data.id,
      username: data.data.username,
      name: data.data.name,
    };
  }

  async createTweet(input: CreateTweetInput): Promise<CreateTweetResult> {
    const payload: Record<string, unknown> = { text: input.text };
    if (input.replyToId) {
      payload.reply = { in_reply_to_tweet_id: input.replyToId };
    }
    if (input.quoteId) {
      payload.quote_tweet_id = input.quoteId;
    }
    if (input.mediaIds && input.mediaIds.length > 0) {
      payload.media = { media_ids: input.mediaIds };
    }
    const data = await this.request<{ data: { id: string; text: string } }>({
      method: "POST",
      url: `${API_BASE}/2/tweets`,
      body: payload,
    });
    return { id: data.data.id, text: data.data.text };
  }

  async deleteTweet(id: string): Promise<{ deleted: boolean; id: string }> {
    const data = await this.request<{ data: { deleted: boolean } }>({
      method: "DELETE",
      url: `${API_BASE}/2/tweets/${id}`,
    });
    return { deleted: data.data.deleted, id };
  }

  async uploadMedia(filePath: string, mimeType: string): Promise<MediaUploadResult> {
    const buffer = await fs.readFile(filePath);
    const totalBytes = buffer.length;
    const mediaCategory = mimeType.startsWith("video/")
      ? "tweet_video"
      : mimeType === "image/gif"
        ? "tweet_gif"
        : "tweet_image";

    // X API v2 dedicated media upload endpoints
    const init = await this.request<{
      data: { id: string; media_key?: string };
    }>({
      method: "POST",
      url: `${API_BASE}/2/media/upload/initialize`,
      body: {
        media_type: mimeType,
        total_bytes: totalBytes,
        media_category: mediaCategory,
      },
    });

    const mediaId = init.data.id;
    const chunkSize = 4 * 1024 * 1024;
    let segmentIndex = 0;
    for (let offset = 0; offset < totalBytes; offset += chunkSize) {
      const chunk = buffer.subarray(offset, Math.min(offset + chunkSize, totalBytes));
      const form = new FormData();
      form.append("segment_index", String(segmentIndex));
      form.append(
        "media",
        new Blob([new Uint8Array(chunk)], { type: "application/octet-stream" }),
        path.basename(filePath)
      );
      await this.request({
        method: "POST",
        url: `${API_BASE}/2/media/upload/${mediaId}/append`,
        formData: form,
      });
      segmentIndex += 1;
    }

    await this.request({
      method: "POST",
      url: `${API_BASE}/2/media/upload/${mediaId}/finalize`,
      body: {},
    });

    if (mimeType.startsWith("video/")) {
      await this.waitForMediaProcessing(mediaId);
    }

    return { mediaId };
  }

  private async waitForMediaProcessing(mediaId: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const status = await this.request<{
        data?: {
          processing_info?: {
            state?: string;
            check_after_secs?: number;
            error?: { message?: string };
          };
        };
      }>({
        method: "GET",
        url: `${API_BASE}/2/media/upload?command=STATUS&media_id=${mediaId}`,
      });
      const info = status.data?.processing_info;
      if (!info || info.state === "succeeded") return;
      if (info.state === "failed") {
        throw new CliError(
          `Media processing failed: ${info.error?.message ?? "unknown"}`,
          EXIT.generic
        );
      }
      const waitSecs = info.check_after_secs ?? 2;
      await new Promise((resolve) => setTimeout(resolve, waitSecs * 1000));
    }
    throw new CliError("Timed out waiting for media processing.", EXIT.generic);
  }

  async getTweetMetrics(id: string): Promise<TweetMetrics> {
    const data = await this.request<{
      data: {
        id: string;
        text: string;
        public_metrics: {
          retweet_count: number;
          reply_count: number;
          like_count: number;
          quote_count: number;
          bookmark_count?: number;
          impression_count?: number;
        };
      };
    }>({
      method: "GET",
      url: `${API_BASE}/2/tweets/${id}?tweet.fields=public_metrics,text`,
    });
    const m = data.data.public_metrics;
    return {
      id: data.data.id,
      text: data.data.text,
      publicMetrics: {
        retweetCount: m.retweet_count,
        replyCount: m.reply_count,
        likeCount: m.like_count,
        quoteCount: m.quote_count,
        bookmarkCount: m.bookmark_count,
        impressionCount: m.impression_count,
      },
    };
  }

  async getMyTimeline(maxResults = 10): Promise<TweetMetrics[]> {
    const me = await this.verifyCredentials();
    const data = await this.request<{
      data?: Array<{
        id: string;
        text: string;
        public_metrics: {
          retweet_count: number;
          reply_count: number;
          like_count: number;
          quote_count: number;
          bookmark_count?: number;
          impression_count?: number;
        };
      }>;
    }>({
      method: "GET",
      url: `${API_BASE}/2/users/${me.id}/tweets?max_results=${Math.min(Math.max(maxResults, 5), 100)}&tweet.fields=public_metrics,text`,
    });
    return (data.data ?? []).map((t) => ({
      id: t.id,
      text: t.text,
      publicMetrics: {
        retweetCount: t.public_metrics.retweet_count,
        replyCount: t.public_metrics.reply_count,
        likeCount: t.public_metrics.like_count,
        quoteCount: t.public_metrics.quote_count,
        bookmarkCount: t.public_metrics.bookmark_count,
        impressionCount: t.public_metrics.impression_count,
      },
    }));
  }
}

export function createRealClient(auth: AuthConfig): RealXApiClient {
  return new RealXApiClient(auth);
}
