import type {
  CreateTweetInput,
  CreateTweetResult,
  MediaUploadResult,
  TweetMetrics,
  UserInfo,
} from "../types.js";

export interface XApiClient {
  verifyCredentials(): Promise<UserInfo>;
  createTweet(input: CreateTweetInput): Promise<CreateTweetResult>;
  deleteTweet(id: string): Promise<{ deleted: boolean; id: string }>;
  uploadMedia(filePath: string, mimeType: string): Promise<MediaUploadResult>;
  getTweetMetrics(id: string): Promise<TweetMetrics>;
  getMyTimeline(maxResults?: number): Promise<TweetMetrics[]>;
}

export type XApiClientFactory = () => Promise<XApiClient>;

let clientOverride: XApiClient | null = null;

export function setXApiClientOverride(client: XApiClient | null): void {
  clientOverride = client;
}

export function getXApiClientOverride(): XApiClient | null {
  return clientOverride;
}
