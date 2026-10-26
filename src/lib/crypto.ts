import crypto from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function sha256FileSync(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function randomHex(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      keylen,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      }
    );
  });
}

export async function hashPassphrase(
  passphrase: string,
  saltHex?: string
): Promise<{ saltHex: string; hashHex: string }> {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const derived = await scryptAsync(passphrase, salt, 64);
  return {
    saltHex: salt.toString("hex"),
    hashHex: derived.toString("hex"),
  };
}

export async function verifyPassphrase(
  passphrase: string,
  saltHex: string,
  expectedHashHex: string
): Promise<boolean> {
  const { hashHex } = await hashPassphrase(passphrase, saltHex);
  const a = Buffer.from(hashHex, "hex");
  const b = Buffer.from(expectedHashHex, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function deriveWrapKey(
  passphrase: string,
  saltHex: string
): Promise<Buffer> {
  const salt = Buffer.from(saltHex, "hex");
  return scryptAsync(passphrase, salt, 32);
}

export function generateEd25519KeyPair(): {
  publicKeySpki: Buffer;
  privateKeyPkcs8: Buffer;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeySpki: publicKey.export({ type: "spki", format: "der" }) as Buffer,
    privateKeyPkcs8: privateKey.export({ type: "pkcs8", format: "der" }) as Buffer,
  };
}

export function encryptPrivateKey(
  privateKeyPkcs8: Buffer,
  wrapKey: Buffer
): { ivHex: string; authTagHex: string; encryptedPrivateKeyHex: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", wrapKey, iv);
  const encrypted = Buffer.concat([cipher.update(privateKeyPkcs8), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ivHex: iv.toString("hex"),
    authTagHex: authTag.toString("hex"),
    encryptedPrivateKeyHex: encrypted.toString("hex"),
  };
}

export function decryptPrivateKey(
  encrypted: { ivHex: string; authTagHex: string; encryptedPrivateKeyHex: string },
  wrapKey: Buffer
): Buffer {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    wrapKey,
    Buffer.from(encrypted.ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.encryptedPrivateKeyHex, "hex")),
    decipher.final(),
  ]);
}

export function ed25519Sign(privateKeyPkcs8: Buffer, payload: string): string {
  const key = crypto.createPrivateKey({
    key: privateKeyPkcs8,
    format: "der",
    type: "pkcs8",
  });
  return crypto.sign(null, Buffer.from(payload, "utf8"), key).toString("hex");
}

export function ed25519Verify(
  publicKeySpki: Buffer,
  payload: string,
  signatureHex: string
): boolean {
  try {
    const key = crypto.createPublicKey({
      key: publicKeySpki,
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      Buffer.from(payload, "utf8"),
      key,
      Buffer.from(signatureHex, "hex")
    );
  } catch {
    return false;
  }
}

export function bindingPayload(parts: {
  texts: string[];
  mediaSha256s: string[];
  replyToId?: string;
  quoteId?: string;
  kind: string;
  deletePostId?: string;
}): string {
  return JSON.stringify({
    kind: parts.kind,
    texts: parts.texts,
    mediaSha256s: parts.mediaSha256s,
    replyToId: parts.replyToId ?? null,
    quoteId: parts.quoteId ?? null,
    deletePostId: parts.deletePostId ?? null,
  });
}

export function computeBindingHash(parts: {
  texts: string[];
  mediaSha256s: string[];
  replyToId?: string;
  quoteId?: string;
  kind: string;
  deletePostId?: string;
}): string {
  return sha256Hex(bindingPayload(parts));
}

/** Approval payload includes scheduled slot so changing --at invalidates the signature binding. */
export function approvalSignPayload(parts: {
  draftId: string;
  bindingHash: string;
  scheduledAtIso: string | null;
  approvedAt: string;
  expiresAt: string;
  kind: string;
  batchId?: string | null;
  mode?: "tty" | "chat";
  quote?: string | null;
}): string {
  if (parts.mode === "chat") {
    return JSON.stringify({
      draftId: parts.draftId,
      bindingHash: parts.bindingHash,
      scheduledAtIso: parts.scheduledAtIso,
      approvedAt: parts.approvedAt,
      expiresAt: parts.expiresAt,
      kind: parts.kind,
      batchId: parts.batchId ?? null,
      scheme: "ed25519",
      mode: "chat",
      quote: parts.quote ?? "",
    });
  }
  // TTY / legacy payload shape must stay stable for existing signatures.
  return JSON.stringify({
    draftId: parts.draftId,
    bindingHash: parts.bindingHash,
    scheduledAtIso: parts.scheduledAtIso,
    approvedAt: parts.approvedAt,
    expiresAt: parts.expiresAt,
    kind: parts.kind,
    batchId: parts.batchId ?? null,
    scheme: "ed25519",
  });
}

/** HMAC-SHA256 hex digest (available for chat signing alternatives / tests). */
export function hmacSha256Hex(key: Buffer | string, payload: string): string {
  return crypto.createHmac("sha256", key).update(payload, "utf8").digest("hex");
}

export function computeExpiryIso(input: {
  approvedAtMs: number;
  scheduledAtIso: string | null;
  approvalTtlHours: number;
  scheduledApprovalGraceHours: number;
  scheduledApprovalMaxHours: number;
}): string {
  if (!input.scheduledAtIso) {
    return new Date(
      input.approvedAtMs + input.approvalTtlHours * 3600_000
    ).toISOString();
  }
  const scheduledMs = Date.parse(input.scheduledAtIso);
  const graceMs = input.scheduledApprovalGraceHours * 3600_000;
  const maxMs = input.scheduledApprovalMaxHours * 3600_000;
  const slotExpiry = scheduledMs + graceMs;
  const cap = input.approvedAtMs + maxMs;
  return new Date(Math.min(slotExpiry, cap)).toISOString();
}
