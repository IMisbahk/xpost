import { describe, expect, it } from "vitest";
import {
  computeBindingHash,
  hashPassphrase,
  sha256Hex,
  verifyPassphrase,
  generateEd25519KeyPair,
  ed25519Sign,
  ed25519Verify,
  encryptPrivateKey,
  decryptPrivateKey,
  deriveWrapKey,
} from "../src/lib/crypto.js";

describe("crypto", () => {
  it("hashes passphrase with salt and verifies", async () => {
    const { saltHex, hashHex } = await hashPassphrase("correct-horse");
    expect(await verifyPassphrase("correct-horse", saltHex, hashHex)).toBe(true);
    expect(await verifyPassphrase("wrong", saltHex, hashHex)).toBe(false);
  });

  it("binding hash changes when text changes", () => {
    const a = computeBindingHash({
      texts: ["hello"],
      mediaSha256s: [],
      kind: "post",
    });
    const b = computeBindingHash({
      texts: ["hello!"],
      mediaSha256s: [],
      kind: "post",
    });
    expect(a).not.toBe(b);
    expect(a).toBe(
      sha256Hex(
        JSON.stringify({
          kind: "post",
          texts: ["hello"],
          mediaSha256s: [],
          replyToId: null,
          quoteId: null,
          deletePostId: null,
        })
      )
    );
  });

  it("ed25519 verify rejects forged signature; private key wraps with passphrase", async () => {
    const { publicKeySpki, privateKeyPkcs8 } = generateEd25519KeyPair();
    const sig = ed25519Sign(privateKeyPkcs8, "payload");
    expect(ed25519Verify(publicKeySpki, "payload", sig)).toBe(true);
    expect(ed25519Verify(publicKeySpki, "payload", "00".repeat(64))).toBe(false);
    expect(ed25519Verify(publicKeySpki, "other", sig)).toBe(false);

    const wrapKey = await deriveWrapKey("passphrase-here", "ab".repeat(16));
    const enc = encryptPrivateKey(privateKeyPkcs8, wrapKey);
    const roundTrip = decryptPrivateKey(enc, wrapKey);
    expect(ed25519Verify(publicKeySpki, "payload", ed25519Sign(roundTrip, "payload"))).toBe(
      true
    );
  });
});
