import fs from "node:fs/promises";
import path from "node:path";
import { randomHex, sha256Hex, computeBindingHash, sha256FileSync } from "./crypto.js";
import { getPaths } from "./paths.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fsutil.js";
import { collectTextWarnings, validateWeightedLength } from "./weightedLength.js";
import { loadAppConfig } from "./config.js";
import type { DraftKind, DraftRecord, MediaRef } from "../types.js";
import { CliError } from "./output.js";
import { EXIT } from "../types.js";

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
  };
  return map[ext] ?? "application/octet-stream";
}

export async function buildMediaRefs(paths: string[]): Promise<MediaRef[]> {
  const refs: MediaRef[] = [];
  for (const mediaPath of paths) {
    const absolute = path.resolve(mediaPath);
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(absolute);
    } catch {
      throw new CliError(`Media file not found: ${mediaPath}`, EXIT.notFound);
    }
    refs.push({
      path: absolute,
      sha256: sha256FileSync(buffer),
      mimeType: mimeFromPath(absolute),
      sizeBytes: buffer.length,
    });
  }
  return refs;
}

export function computeTextHash(texts: string[]): string {
  return sha256Hex(JSON.stringify(texts));
}

export function computeMediaHash(media: MediaRef[]): string {
  return sha256Hex(JSON.stringify(media.map((m) => m.sha256)));
}

export function computeTargetHash(target: {
  replyToId?: string;
  quoteId?: string;
}): string {
  return sha256Hex(
    JSON.stringify({
      replyToId: target.replyToId ?? null,
      quoteId: target.quoteId ?? null,
    })
  );
}

export function computeDraftBindingHash(draft: DraftRecord): string {
  return computeBindingHash({
    texts: draft.texts,
    mediaSha256s: draft.media.map((m) => m.sha256),
    replyToId: draft.target.replyToId,
    quoteId: draft.target.quoteId,
    kind: draft.kind,
    deletePostId: draft.deletePostId,
  });
}

export async function createDraft(input: {
  kind?: DraftKind;
  texts: string[];
  replyToId?: string;
  quoteId?: string;
  mediaPaths?: string[];
  deletePostId?: string;
}): Promise<DraftRecord> {
  const config = await loadAppConfig();
  const kind = input.kind ?? "post";
  const texts = input.texts.map((t) => t.replace(/\r\n/g, "\n"));

  if (kind === "post") {
    if (texts.length === 0 || texts.some((t) => t.trim().length === 0)) {
      throw new CliError("Draft text cannot be empty.", EXIT.usage);
    }
    const lengthCheck = validateWeightedLength(texts, config.characterLimit);
    if (!lengthCheck.ok) {
      throw new CliError(lengthCheck.messages.join(" "), EXIT.usage, {
        lengths: lengthCheck.lengths,
      });
    }
  }

  const media = await buildMediaRefs(input.mediaPaths ?? []);
  const target = { replyToId: input.replyToId, quoteId: input.quoteId };
  const textHash = computeTextHash(texts);
  const mediaHash = computeMediaHash(media);
  const targetHash = computeTargetHash(target);
  const bindingHash = computeBindingHash({
    texts,
    mediaSha256s: media.map((m) => m.sha256),
    replyToId: target.replyToId,
    quoteId: target.quoteId,
    kind,
    deletePostId: input.deletePostId,
  });

  const warnings =
    kind === "post" ? collectTextWarnings(texts) : ([] as string[]);
  const weighted =
    kind === "post"
      ? validateWeightedLength(texts, config.characterLimit).lengths.reduce(
          (a, b) => Math.max(a, b),
          0
        )
      : 0;

  const draft: DraftRecord = {
    id: randomHex(8),
    kind,
    createdAt: new Date().toISOString(),
    texts,
    textHash,
    media,
    mediaHash,
    target,
    targetHash,
    bindingHash,
    deletePostId: input.deletePostId,
    warnings,
    weightedLength: weighted,
    characterLimit: config.characterLimit,
  };

  await saveDraft(draft);
  return draft;
}

export async function saveDraft(draft: DraftRecord): Promise<void> {
  const { draftsDir } = getPaths();
  await ensureDir(draftsDir, 0o700);
  await writeJsonFile(path.join(draftsDir, `${draft.id}.json`), draft, 0o600);
}

export async function loadDraft(id: string): Promise<DraftRecord> {
  const { draftsDir } = getPaths();
  const draft = await readJsonFile<DraftRecord | null>(
    path.join(draftsDir, `${id}.json`),
    null
  );
  if (!draft) {
    throw new CliError(`Draft not found: ${id}`, EXIT.notFound);
  }
  return draft;
}

export async function listDrafts(): Promise<DraftRecord[]> {
  const { draftsDir } = getPaths();
  await ensureDir(draftsDir, 0o700);
  const files = await fs.readdir(draftsDir);
  const drafts: DraftRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const draft = await readJsonFile<DraftRecord | null>(
      path.join(draftsDir, file),
      null
    );
    if (draft) drafts.push(draft);
  }
  return drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function extractPostId(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  const urlMatch = trimmed.match(/status\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  if (/^\d+$/.test(trimmed)) return trimmed;
  throw new CliError(`Could not parse post id from: ${idOrUrl}`, EXIT.usage);
}
