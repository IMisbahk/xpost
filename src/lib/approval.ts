import {
  approvalSignPayload,
  computeExpiryIso,
  decryptPrivateKey,
  deriveWrapKey,
  ed25519Sign,
  ed25519Verify,
  encryptPrivateKey,
  generateEd25519KeyPair,
  hashPassphrase,
  randomHex,
  verifyPassphrase,
} from "./crypto.js";
import { getPaths } from "./paths.js";
import { ensureDir, readJsonFile, writeJsonFile } from "./fsutil.js";
import type {
  ApprovalMode,
  ApprovalRecord,
  ApproverStore,
  ChatApproverStore,
  DraftRecord,
  VerifyKeyStore,
} from "../types.js";
import { CliError } from "./output.js";
import { EXIT } from "../types.js";
import { assertInteractiveApprovalAllowed, promptHidden } from "./tty.js";
import {
  assertApprovalModeEnabled,
  isApprovalModeEnabled,
  loadAppConfig,
} from "./config.js";
import { computeDraftBindingHash } from "./drafts.js";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000;

/**
 * Approver dir (XPOST_APPROVER_DIR): passphrase hash + encrypted Ed25519 private key.
 * Data dir (XPOST_HOME): public verify key only. Assistant can verify, not forge.
 */
export async function initApprover(passphrase: string): Promise<{
  approverFile: string;
  verifyKeyFile: string;
}> {
  if (passphrase.length < 8) {
    throw new CliError("Passphrase must be at least 8 characters.", EXIT.usage);
  }
  const { approverDir, approverFile, verifyKeyFile, home } = getPaths();
  await ensureDir(approverDir, 0o700);
  await ensureDir(home, 0o700);

  const { saltHex, hashHex } = await hashPassphrase(passphrase);
  const wrapKeySaltHex = randomHex(16);
  const wrapKey = await deriveWrapKey(passphrase, wrapKeySaltHex);
  const { publicKeySpki, privateKeyPkcs8 } = generateEd25519KeyPair();
  const encrypted = encryptPrivateKey(privateKeyPkcs8, wrapKey);

  const store: ApproverStore = {
    saltHex,
    passphraseHashHex: hashHex,
    wrapKeySaltHex,
    encryptedPrivateKeyHex: encrypted.encryptedPrivateKeyHex,
    ivHex: encrypted.ivHex,
    authTagHex: encrypted.authTagHex,
    publicKeySpkiHex: publicKeySpki.toString("hex"),
    failedAttempts: 0,
    createdAt: new Date().toISOString(),
  };
  await writeJsonFile(approverFile, store, 0o600);

  const verifyKey: VerifyKeyStore = {
    scheme: "ed25519",
    publicKeySpkiHex: publicKeySpki.toString("hex"),
    createdAt: store.createdAt,
  };
  await writeJsonFile(verifyKeyFile, verifyKey, 0o644);

  return { approverFile, verifyKeyFile };
}

export async function loadApproverStore(): Promise<ApproverStore> {
  const { approverFile } = getPaths();
  const store = await readJsonFile<ApproverStore | null>(approverFile, null);
  if (!store || !store.encryptedPrivateKeyHex) {
    throw new CliError(
      "Approver not initialized. Run `xpost init-approver` on the owner's machine first.",
      EXIT.auth
    );
  }
  return store;
}

async function saveApproverStore(store: ApproverStore): Promise<void> {
  const { approverFile } = getPaths();
  await writeJsonFile(approverFile, store, 0o600);
}

export async function loadVerifyPublicKey(): Promise<Buffer> {
  const { verifyKeyFile } = getPaths();
  const stored = await readJsonFile<VerifyKeyStore | null>(verifyKeyFile, null);
  if (stored?.publicKeySpkiHex) {
    return Buffer.from(stored.publicKeySpkiHex, "hex");
  }
  // Fallback: read public key from approver store if present on this machine
  try {
    const store = await loadApproverStore();
    return Buffer.from(store.publicKeySpkiHex, "hex");
  } catch {
    throw new CliError(
      "Missing verify-key.json in XPOST_HOME. Run init-approver (copies the public key) or copy verify-key.json to the assistant data dir.",
      EXIT.auth
    );
  }
}

export async function unlockApproverWithPassphrase(
  passphrase: string
): Promise<{ privateKeyPkcs8: Buffer; store: ApproverStore }> {
  const store = await loadApproverStore();
  if (store.lockedUntil) {
    const until = Date.parse(store.lockedUntil);
    if (Date.now() < until) {
      throw new CliError(
        `Approver locked until ${store.lockedUntil} after too many failed attempts.`,
        EXIT.lockout
      );
    }
  }

  const ok = await verifyPassphrase(
    passphrase,
    store.saltHex,
    store.passphraseHashHex
  );
  if (!ok) {
    store.failedAttempts = (store.failedAttempts ?? 0) + 1;
    if (store.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      store.lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
      store.failedAttempts = 0;
      await saveApproverStore(store);
      throw new CliError(
        `Wrong passphrase. Approver locked until ${store.lockedUntil}.`,
        EXIT.lockout
      );
    }
    await saveApproverStore(store);
    throw new CliError(
      `Wrong passphrase (${store.failedAttempts}/${MAX_FAILED_ATTEMPTS} failed attempts).`,
      EXIT.auth
    );
  }

  store.failedAttempts = 0;
  store.lockedUntil = undefined;
  await saveApproverStore(store);

  const wrapKey = await deriveWrapKey(passphrase, store.wrapKeySaltHex);
  const privateKeyPkcs8 = decryptPrivateKey(store, wrapKey);
  return { privateKeyPkcs8, store };
}

export async function loadApprovals(): Promise<Record<string, ApprovalRecord>> {
  const { approvalsFile } = getPaths();
  return readJsonFile<Record<string, ApprovalRecord>>(approvalsFile, {});
}

export async function saveApprovals(
  approvals: Record<string, ApprovalRecord>
): Promise<void> {
  const { approvalsFile } = getPaths();
  await writeJsonFile(approvalsFile, approvals, 0o600);
}

/**
 * Load or auto-generate the chat approval Ed25519 key under XPOST_HOME.
 * No passphrase; used so chat approvals are tamper-evident.
 */
export async function loadOrCreateChatApprover(): Promise<{
  privateKeyPkcs8: Buffer;
  publicKeySpki: Buffer;
  store: ChatApproverStore;
}> {
  const { chatApproverFile, home } = getPaths();
  await ensureDir(home, 0o700);
  const existing = await readJsonFile<ChatApproverStore | null>(
    chatApproverFile,
    null
  );
  if (
    existing?.privateKeyPkcs8Hex &&
    existing?.publicKeySpkiHex &&
    existing.scheme === "ed25519"
  ) {
    return {
      privateKeyPkcs8: Buffer.from(existing.privateKeyPkcs8Hex, "hex"),
      publicKeySpki: Buffer.from(existing.publicKeySpkiHex, "hex"),
      store: existing,
    };
  }
  const { publicKeySpki, privateKeyPkcs8 } = generateEd25519KeyPair();
  const store: ChatApproverStore = {
    scheme: "ed25519",
    publicKeySpkiHex: publicKeySpki.toString("hex"),
    privateKeyPkcs8Hex: privateKeyPkcs8.toString("hex"),
    createdAt: new Date().toISOString(),
  };
  await writeJsonFile(chatApproverFile, store, 0o600);
  return { privateKeyPkcs8, publicKeySpki, store };
}

export async function loadChatPublicKey(): Promise<Buffer> {
  const { publicKeySpki } = await loadOrCreateChatApprover();
  return publicKeySpki;
}

export function signApproval(
  privateKeyPkcs8: Buffer,
  draft: DraftRecord,
  options: {
    scheduledAtIso: string | null;
    batchId?: string;
    approvalTtlHours: number;
    scheduledApprovalGraceHours: number;
    scheduledApprovalMaxHours: number;
    mode?: ApprovalMode;
    quote?: string;
  }
): ApprovalRecord {
  const mode: ApprovalMode = options.mode ?? "tty";
  const approvedAtMs = Date.now();
  const approvedAt = new Date(approvedAtMs).toISOString();
  const expiresAt = computeExpiryIso({
    approvedAtMs,
    scheduledAtIso: options.scheduledAtIso,
    approvalTtlHours: options.approvalTtlHours,
    scheduledApprovalGraceHours: options.scheduledApprovalGraceHours,
    scheduledApprovalMaxHours: options.scheduledApprovalMaxHours,
  });
  const payload = approvalSignPayload({
    draftId: draft.id,
    bindingHash: draft.bindingHash,
    scheduledAtIso: options.scheduledAtIso,
    approvedAt,
    expiresAt,
    kind: draft.kind,
    batchId: options.batchId ?? null,
    mode,
    quote: mode === "chat" ? options.quote ?? "" : null,
  });
  const record: ApprovalRecord = {
    draftId: draft.id,
    bindingHash: draft.bindingHash,
    scheduledAtIso: options.scheduledAtIso,
    approvedAt,
    expiresAt,
    signature: ed25519Sign(privateKeyPkcs8, payload),
    kind: draft.kind,
    batchId: options.batchId,
    scheme: "ed25519",
    mode,
  };
  if (mode === "chat") {
    record.quote = options.quote ?? "";
  }
  return record;
}

export function verifyApprovalWithPublicKey(
  approval: ApprovalRecord,
  publicKeySpki: Buffer
): boolean {
  const mode: ApprovalMode = approval.mode ?? "tty";
  const payload = approvalSignPayload({
    draftId: approval.draftId,
    bindingHash: approval.bindingHash,
    scheduledAtIso: approval.scheduledAtIso,
    approvedAt: approval.approvedAt,
    expiresAt: approval.expiresAt,
    kind: approval.kind,
    batchId: approval.batchId ?? null,
    mode,
    quote: mode === "chat" ? approval.quote ?? "" : null,
  });
  return ed25519Verify(publicKeySpki, payload, approval.signature);
}

export type ApprovalPreviewItem = {
  draftId: string;
  kind: DraftRecord["kind"];
  texts: string[];
  textHash: string;
  bindingHash: string;
  media: Array<{ path: string; sha256: string; mimeType: string }>;
  mediaHash: string;
  target: DraftRecord["target"];
  scheduledAtIso: string | null;
  timezone?: string;
  deletePostId?: string;
};

export function buildApprovalPreview(
  draft: DraftRecord,
  scheduledAtIso: string | null,
  timezone?: string
): ApprovalPreviewItem {
  return {
    draftId: draft.id,
    kind: draft.kind,
    texts: [...draft.texts],
    textHash: draft.textHash,
    bindingHash: draft.bindingHash,
    media: draft.media.map((m) => ({
      path: m.path,
      sha256: m.sha256,
      mimeType: m.mimeType,
    })),
    mediaHash: draft.mediaHash,
    target: { ...draft.target },
    scheduledAtIso,
    timezone,
    deletePostId: draft.deletePostId,
  };
}

export function assertConfirmHashMatches(
  confirmHash: string | undefined,
  textHashes: string[]
): void {
  if (confirmHash === undefined || confirmHash === "") return;
  const prefix = confirmHash.trim().toLowerCase();
  if (prefix.length < 8) {
    throw new CliError(
      "Confirm hash must be at least 8 characters of the text sha256.",
      EXIT.usage
    );
  }
  const ok = textHashes.some((hash) => hash.toLowerCase().startsWith(prefix));
  if (!ok) {
    throw new CliError(
      "Confirm hash does not match any text sha256 being approved. Show the owner the exact text and hash first.",
      EXIT.hashMismatch
    );
  }
}

/** @deprecated use unlock + signApproval; kept for tests that need a private key helper */
export async function getPrivateKeyForTests(passphrase: string): Promise<Buffer> {
  const { privateKeyPkcs8 } = await unlockApproverWithPassphrase(passphrase);
  return privateKeyPkcs8;
}

function printDraftForApproval(
  draft: DraftRecord,
  scheduledAtIso: string | null,
  timezone?: string
): void {
  process.stdout.write(`\n=== draft ${draft.id} ===\n`);
  process.stdout.write(`Kind: ${draft.kind}\n`);
  process.stdout.write(`Content binding SHA-256: ${draft.bindingHash}\n`);
  if (scheduledAtIso) {
    process.stdout.write(
      `Scheduled: ${scheduledAtIso}${timezone ? ` (${timezone})` : ""}\n`
    );
  } else {
    process.stdout.write("Scheduled: (none / immediate)\n");
  }
  if (draft.kind === "delete") {
    process.stdout.write(`Delete post id: ${draft.deletePostId}\n`);
    return;
  }
  draft.texts.forEach((text, index) => {
    process.stdout.write(`\n--- text ${index + 1}/${draft.texts.length} ---\n`);
    process.stdout.write(`${text}\n`);
    process.stdout.write(`--- end text ${index + 1} ---\n`);
  });
  process.stdout.write(`Text set SHA-256: ${draft.textHash}\n`);
  if (draft.target.replyToId) {
    process.stdout.write(`Reply to: ${draft.target.replyToId}\n`);
  }
  if (draft.target.quoteId) {
    process.stdout.write(`Quote: ${draft.target.quoteId}\n`);
  }
  if (draft.media.length === 0) {
    process.stdout.write("Media: (none)\n");
  } else {
    process.stdout.write("Media:\n");
    for (const media of draft.media) {
      process.stdout.write(
        `  - ${media.path} sha256=${media.sha256} (${media.mimeType})\n`
      );
    }
  }
}

export async function approveDraftInteractive(
  draft: DraftRecord,
  options?: { scheduledAtIso?: string | null; batchId?: string; timezone?: string }
): Promise<ApprovalRecord> {
  assertApprovalModeEnabled("tty");
  assertInteractiveApprovalAllowed();
  const config = await loadAppConfig();
  const scheduledAtIso = options?.scheduledAtIso ?? null;

  process.stdout.write("\n=== xpost approval ===\n");
  printDraftForApproval(draft, scheduledAtIso, options?.timezone);
  process.stdout.write("\nType the approval passphrase to bind this exact content.\n");

  const passphrase = await promptHidden("Passphrase: ");
  const { privateKeyPkcs8 } = await unlockApproverWithPassphrase(passphrase);
  const approval = signApproval(privateKeyPkcs8, draft, {
    scheduledAtIso,
    batchId: options?.batchId,
    approvalTtlHours: config.approvalTtlHours,
    scheduledApprovalGraceHours: config.scheduledApprovalGraceHours,
    scheduledApprovalMaxHours: config.scheduledApprovalMaxHours,
    mode: "tty",
  });
  const approvals = await loadApprovals();
  approvals[draft.id] = approval;
  await saveApprovals(approvals);
  return approval;
}

export async function approveManyInteractive(
  items: Array<{
    draft: DraftRecord;
    scheduledAtIso: string | null;
    timezone?: string;
    batchId?: string;
  }>
): Promise<ApprovalRecord[]> {
  assertApprovalModeEnabled("tty");
  assertInteractiveApprovalAllowed();
  const config = await loadAppConfig();

  process.stdout.write("\n=== xpost batch approval ===\n");
  process.stdout.write(`Posts in this approval: ${items.length}\n`);
  for (const item of items) {
    printDraftForApproval(item.draft, item.scheduledAtIso, item.timezone);
  }
  process.stdout.write(
    "\nType the approval passphrase to bind EVERY post above (one step).\n"
  );

  const passphrase = await promptHidden("Passphrase: ");
  const { privateKeyPkcs8 } = await unlockApproverWithPassphrase(passphrase);
  const approvals = await loadApprovals();
  const created: ApprovalRecord[] = [];
  for (const item of items) {
    const approval = signApproval(privateKeyPkcs8, item.draft, {
      scheduledAtIso: item.scheduledAtIso,
      batchId: item.batchId,
      approvalTtlHours: config.approvalTtlHours,
      scheduledApprovalGraceHours: config.scheduledApprovalGraceHours,
      scheduledApprovalMaxHours: config.scheduledApprovalMaxHours,
      mode: "tty",
    });
    approvals[item.draft.id] = approval;
    created.push(approval);
  }
  await saveApprovals(approvals);
  return created;
}

/**
 * Non-interactive chat approval: binds the owner's exact yes quote into a
 * signed record. No TTY or passphrase required. Relies on the assistant only
 * running this after the owner explicitly said yes to the exact text shown.
 */
export async function approveDraftViaChat(
  draft: DraftRecord,
  options: {
    quote: string;
    scheduledAtIso: string | null;
    batchId?: string;
    timezone?: string;
    confirmHash?: string;
    printPreview?: boolean;
  }
): Promise<{ approval: ApprovalRecord; preview: ApprovalPreviewItem }> {
  assertApprovalModeEnabled("chat");
  const quote = options.quote;
  if (typeof quote !== "string" || quote.trim().length === 0) {
    throw new CliError(
      "Chat approval requires a non-empty --quote with the owner's exact yes message.",
      EXIT.usage
    );
  }

  const scheduledAtIso = options.scheduledAtIso ?? null;
  const preview = buildApprovalPreview(draft, scheduledAtIso, options.timezone);
  assertConfirmHashMatches(options.confirmHash, [draft.textHash]);

  if (options.printPreview !== false) {
    process.stdout.write("\n=== xpost chat approval (preview) ===\n");
    printDraftForApproval(draft, scheduledAtIso, options.timezone);
    process.stdout.write(`Quote (verbatim): ${quote}\n`);
  }

  const config = await loadAppConfig();
  const { privateKeyPkcs8 } = await loadOrCreateChatApprover();
  const approval = signApproval(privateKeyPkcs8, draft, {
    scheduledAtIso,
    batchId: options.batchId,
    approvalTtlHours: config.approvalTtlHours,
    scheduledApprovalGraceHours: config.scheduledApprovalGraceHours,
    scheduledApprovalMaxHours: config.scheduledApprovalMaxHours,
    mode: "chat",
    quote,
  });
  const approvals = await loadApprovals();
  approvals[draft.id] = approval;
  await saveApprovals(approvals);
  return { approval, preview };
}

export async function approveManyViaChat(
  items: Array<{
    draft: DraftRecord;
    scheduledAtIso: string | null;
    timezone?: string;
    batchId?: string;
  }>,
  options: {
    quote: string;
    confirmHash?: string;
    printPreview?: boolean;
  }
): Promise<{ approvals: ApprovalRecord[]; previews: ApprovalPreviewItem[] }> {
  assertApprovalModeEnabled("chat");
  const quote = options.quote;
  if (typeof quote !== "string" || quote.trim().length === 0) {
    throw new CliError(
      "Chat approval requires a non-empty --quote with the owner's exact yes message.",
      EXIT.usage
    );
  }
  if (items.length === 0) {
    throw new CliError("Nothing to approve.", EXIT.usage);
  }

  const previews = items.map((item) =>
    buildApprovalPreview(item.draft, item.scheduledAtIso, item.timezone)
  );
  assertConfirmHashMatches(
    options.confirmHash,
    previews.map((p) => p.textHash)
  );

  if (options.printPreview !== false) {
    process.stdout.write("\n=== xpost chat batch approval (preview) ===\n");
    process.stdout.write(`Posts in this approval: ${items.length}\n`);
    for (const item of items) {
      printDraftForApproval(item.draft, item.scheduledAtIso, item.timezone);
    }
    process.stdout.write(`Quote (verbatim): ${quote}\n`);
  }

  const config = await loadAppConfig();
  const { privateKeyPkcs8 } = await loadOrCreateChatApprover();
  const approvalsStore = await loadApprovals();
  const created: ApprovalRecord[] = [];
  for (const item of items) {
    const approval = signApproval(privateKeyPkcs8, item.draft, {
      scheduledAtIso: item.scheduledAtIso,
      batchId: item.batchId,
      approvalTtlHours: config.approvalTtlHours,
      scheduledApprovalGraceHours: config.scheduledApprovalGraceHours,
      scheduledApprovalMaxHours: config.scheduledApprovalMaxHours,
      mode: "chat",
      quote,
    });
    approvalsStore[item.draft.id] = approval;
    created.push(approval);
  }
  await saveApprovals(approvalsStore);
  return { approvals: created, previews };
}

export type ApprovalCheckResult =
  | { ok: true; approval: ApprovalRecord }
  | { ok: false; reason: string; exitCode: (typeof EXIT)[keyof typeof EXIT] };

export async function checkApprovalForDraft(
  draft: DraftRecord,
  scheduledAtIso?: string | null
): Promise<ApprovalCheckResult> {
  const approvals = await loadApprovals();
  const approval = approvals[draft.id];
  if (!approval) {
    return { ok: false, reason: "Draft is not approved.", exitCode: EXIT.notApproved };
  }

  const mode: ApprovalMode = approval.mode ?? "tty";
  if (!isApprovalModeEnabled(mode)) {
    return {
      ok: false,
      reason: `Approval mode "${mode}" is disabled via XPOST_APPROVAL_MODES.`,
      exitCode: EXIT.auth,
    };
  }

  if (mode === "chat") {
    if (typeof approval.quote !== "string" || approval.quote.trim().length === 0) {
      return {
        ok: false,
        reason: "Chat approval is missing the owner's quote.",
        exitCode: EXIT.forged,
      };
    }
  }

  const liveBinding = computeDraftBindingHash(draft);
  if (liveBinding !== draft.bindingHash || approval.bindingHash !== liveBinding) {
    return {
      ok: false,
      reason:
        "Approval binding hash does not match draft (text/media/target changed). Re-approve.",
      exitCode: EXIT.hashMismatch,
    };
  }

  const expectedSchedule =
    scheduledAtIso === undefined
      ? approval.scheduledAtIso
      : scheduledAtIso;
  if ((approval.scheduledAtIso ?? null) !== (expectedSchedule ?? null)) {
    return {
      ok: false,
      reason:
        "Approval scheduled time does not match current schedule. Re-approve.",
      exitCode: EXIT.hashMismatch,
    };
  }

  if (Date.parse(approval.expiresAt) < Date.now()) {
    return { ok: false, reason: "Approval has expired.", exitCode: EXIT.expired };
  }

  try {
    const publicKey =
      mode === "chat"
        ? await loadChatPublicKey()
        : await loadVerifyPublicKey();
    if (!verifyApprovalWithPublicKey(approval, publicKey)) {
      return {
        ok: false,
        reason: "Approval signature is invalid (possible forgery).",
        exitCode: EXIT.forged,
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? error.message
          : "Cannot verify approval signature (public verify key missing).",
      exitCode: EXIT.auth,
    };
  }

  return { ok: true, approval };
}

export async function revokeApproval(draftId: string): Promise<boolean> {
  const approvals = await loadApprovals();
  if (!approvals[draftId]) return false;
  delete approvals[draftId];
  await saveApprovals(approvals);
  return true;
}

export async function revokeApprovals(draftIds: string[]): Promise<void> {
  const approvals = await loadApprovals();
  let changed = false;
  for (const id of draftIds) {
    if (approvals[id]) {
      delete approvals[id];
      changed = true;
    }
  }
  if (changed) await saveApprovals(approvals);
}
