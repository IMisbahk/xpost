import fs from "node:fs/promises";
import { sha256Hex } from "./crypto.js";
import { getPaths } from "./paths.js";
import { ensureDir } from "./fsutil.js";
import type { AuditEntry } from "../types.js";
import { redactText } from "./redactor.js";

async function readLastHash(): Promise<{ seq: number; hash: string }> {
  const { auditFile } = getPaths();
  try {
    const raw = await fs.readFile(auditFile, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length === 0) return { seq: 0, hash: "0".repeat(64) };
    const last = JSON.parse(lines[lines.length - 1]) as AuditEntry;
    return { seq: last.seq, hash: last.entryHash };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { seq: 0, hash: "0".repeat(64) };
    throw error;
  }
}

export async function appendAudit(input: {
  action: string;
  draftId?: string;
  textHash?: string;
  postId?: string;
  url?: string;
  detail?: string;
}): Promise<AuditEntry> {
  const { auditFile, home } = getPaths();
  await ensureDir(home, 0o700);
  const { seq, hash: prevHash } = await readLastHash();
  const time = new Date().toISOString();
  const body = {
    seq: seq + 1,
    prevHash,
    time,
    action: input.action,
    draftId: input.draftId,
    textHash: input.textHash,
    postId: input.postId,
    url: input.url,
    detail: input.detail ? redactText(input.detail) : undefined,
  };
  const entryHash = sha256Hex(JSON.stringify(body));
  const entry: AuditEntry = { ...body, entryHash };
  await fs.appendFile(auditFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  try {
    await fs.chmod(auditFile, 0o600);
  } catch {
    // ignore
  }
  return entry;
}

export async function readAudit(): Promise<AuditEntry[]> {
  const { auditFile } = getPaths();
  try {
    const raw = await fs.readFile(auditFile, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEntry);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return [];
    throw error;
  }
}
