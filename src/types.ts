export type DraftKind = "post" | "delete";

export type DraftTarget = {
  replyToId?: string;
  quoteId?: string;
};

export type MediaRef = {
  path: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
};

export type DraftRecord = {
  id: string;
  kind: DraftKind;
  createdAt: string;
  texts: string[];
  textHash: string;
  media: MediaRef[];
  mediaHash: string;
  target: DraftTarget;
  targetHash: string;
  bindingHash: string;
  deletePostId?: string;
  warnings: string[];
  weightedLength: number;
  characterLimit: number;
  batchId?: string;
};

export type ApprovalRecord = {
  draftId: string;
  bindingHash: string;
  scheduledAtIso: string | null;
  approvedAt: string;
  expiresAt: string;
  signature: string;
  kind: DraftKind;
  batchId?: string;
  scheme: "ed25519";
};

export type ApproverStore = {
  saltHex: string;
  passphraseHashHex: string;
  wrapKeySaltHex: string;
  /** AES-256-GCM encrypted Ed25519 private key (PKCS8 DER), hex */
  encryptedPrivateKeyHex: string;
  ivHex: string;
  authTagHex: string;
  publicKeySpkiHex: string;
  failedAttempts: number;
  lockedUntil?: string;
  createdAt: string;
};

export type VerifyKeyStore = {
  scheme: "ed25519";
  publicKeySpkiHex: string;
  createdAt: string;
};

export type BatchMember = {
  draftId: string;
  atIso: string;
  timezone: string;
  /** Draft content binding hash at last add/update */
  contentBindingHash: string;
};

export type BatchRecord = {
  id: string;
  name: string;
  createdAt: string;
  members: BatchMember[];
  approved: boolean;
  approvedAt?: string;
};

export type ScheduleItem = {
  draftId: string;
  atIso: string;
  timezone: string;
  createdAt: string;
  batchId?: string;
};

export type PostedRecord = {
  draftId: string;
  textHash: string;
  postIds: string[];
  postedAt: string;
  urls: string[];
};

export type AppConfig = {
  characterLimit: number;
  approvalTtlHours: number;
  /** Hours after scheduled time that approval remains valid */
  scheduledApprovalGraceHours: number;
  /** Max hours after approval for scheduled approvals */
  scheduledApprovalMaxHours: number;
  dailyPostCap: number;
  defaultTimezone: string;
  ownerHandle: string;
};

export type AuthConfig = {
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  accessSecret?: string;
  oauth2Token?: string;
};

export type RuntimeState = {
  paused: boolean;
  pausedAt?: string;
  dailyCounts: Record<string, number>;
};

export type AuditEntry = {
  seq: number;
  prevHash: string;
  entryHash: string;
  time: string;
  action: string;
  draftId?: string;
  textHash?: string;
  postId?: string;
  url?: string;
  detail?: string;
};

export type CreateTweetInput = {
  text: string;
  replyToId?: string;
  quoteId?: string;
  mediaIds?: string[];
};

export type CreateTweetResult = {
  id: string;
  text: string;
};

export type MediaUploadResult = {
  mediaId: string;
};

export type UserInfo = {
  id: string;
  username: string;
  name: string;
};

export type TweetMetrics = {
  id: string;
  text: string;
  publicMetrics: {
    retweetCount: number;
    replyCount: number;
    likeCount: number;
    quoteCount: number;
    bookmarkCount?: number;
    impressionCount?: number;
  };
};

export type ExitCode =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15;

export const EXIT = {
  ok: 0 as const,
  generic: 1 as const,
  usage: 2 as const,
  auth: 3 as const,
  notApproved: 4 as const,
  hashMismatch: 5 as const,
  expired: 6 as const,
  paused: 7 as const,
  dailyLimit: 8 as const,
  duplicate: 9 as const,
  ttyRequired: 10 as const,
  lockout: 11 as const,
  forged: 12 as const,
  notFound: 13 as const,
  configPerms: 14 as const,
  dryRun: 15 as const,
};
