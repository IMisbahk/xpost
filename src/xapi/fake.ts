import { randomHex } from "../lib/crypto.js";
import type { XApiClient } from "./client.js";
import type {
  CreateTweetInput,
  CreateTweetResult,
  MediaUploadResult,
  TweetMetrics,
  UserInfo,
} from "../types.js";

export class FakeXApiClient implements XApiClient {
  user: UserInfo = {
    id: "123456789",
    username: "mmisbbahh",
    name: "Owner",
  };
  tweets = new Map<string, TweetMetrics>();
  mediaUploads: Array<{ path: string; mimeType: string; mediaId: string }> = [];
  created: CreateTweetInput[] = [];
  deleted: string[] = [];
  failNextCreate = false;

  async verifyCredentials(): Promise<UserInfo> {
    return this.user;
  }

  async createTweet(input: CreateTweetInput): Promise<CreateTweetResult> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("Fake API createTweet failure");
    }
    this.created.push(input);
    const id = randomHex(6).replace(/\D/g, "").padEnd(10, "0").slice(0, 10) || "1000000001";
    const tweet: TweetMetrics = {
      id,
      text: input.text,
      publicMetrics: {
        retweetCount: 0,
        replyCount: 0,
        likeCount: 0,
        quoteCount: 0,
        bookmarkCount: 0,
        impressionCount: 0,
      },
    };
    this.tweets.set(id, tweet);
    return { id, text: input.text };
  }

  async deleteTweet(id: string): Promise<{ deleted: boolean; id: string }> {
    this.deleted.push(id);
    const existed = this.tweets.delete(id);
    return { deleted: existed || true, id };
  }

  async uploadMedia(filePath: string, mimeType: string): Promise<MediaUploadResult> {
    const mediaId = `media_${this.mediaUploads.length + 1}`;
    this.mediaUploads.push({ path: filePath, mimeType, mediaId });
    return { mediaId };
  }

  async getTweetMetrics(id: string): Promise<TweetMetrics> {
    const tweet = this.tweets.get(id);
    if (!tweet) {
      return {
        id,
        text: "(unknown)",
        publicMetrics: {
          retweetCount: 0,
          replyCount: 0,
          likeCount: 0,
          quoteCount: 0,
        },
      };
    }
    return tweet;
  }

  async getMyTimeline(maxResults = 10): Promise<TweetMetrics[]> {
    return [...this.tweets.values()].slice(0, maxResults);
  }
}
