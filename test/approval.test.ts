import { describe, expect, it } from "vitest";
import { withTempHome } from "./helpers.js";
import {
  initApprover,
  signApproval,
  checkApprovalForDraft,
  getPrivateKeyForTests,
  verifyApprovalWithPublicKey,
  loadApprovals,
  saveApprovals,
  loadVerifyPublicKey,
} from "../src/lib/approval.js";
import { createDraft, saveDraft } from "../src/lib/drafts.js";
import { assertInteractiveApprovalAllowed } from "../src/lib/tty.js";
import { EXIT } from "../src/types.js";
import { computeExpiryIso } from "../src/lib/crypto.js";
import fs from "node:fs/promises";
import path from "node:path";

describe("approval gate", () => {
  it("binds approval to exact text hash and rejects mismatch", async () => {
    await withTempHome(async () => {
      await initApprover("owner-secret-pass");
      const draft = await createDraft({ texts: ["Ship the feature today."] });
      const key = await getPrivateKeyForTests("owner-secret-pass");
      const approval = signApproval(key, draft, {
        scheduledAtIso: null,
        approvalTtlHours: 24,
        scheduledApprovalGraceHours: 6,
        scheduledApprovalMaxHours: 36,
      });
      const approvals = await loadApprovals();
      approvals[draft.id] = approval;
      await saveApprovals(approvals);

      const ok = await checkApprovalForDraft(draft, null);
      expect(ok.ok).toBe(true);

      draft.texts = ["Ship the feature tomorrow."];
      draft.bindingHash = "deadbeef";
      await saveDraft(draft);
      const bad = await checkApprovalForDraft(draft, null);
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.exitCode).toBe(EXIT.hashMismatch);
    });
  });

  it("rejects forged approval signatures with only the public key", async () => {
    await withTempHome(async (home) => {
      await initApprover("owner-secret-pass");
      // Simulate assistant machine: remove approver dir, keep verify-key.json
      await fs.rm(path.join(home, "approver"), { recursive: true, force: true });
      const draft = await createDraft({ texts: ["Exact text only."] });
      const approvals = await loadApprovals();
      approvals[draft.id] = {
        draftId: draft.id,
        bindingHash: draft.bindingHash,
        scheduledAtIso: null,
        approvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        signature: "ab".repeat(64),
        kind: "post",
        scheme: "ed25519",
      };
      await saveApprovals(approvals);
      const publicKey = await loadVerifyPublicKey();
      expect(
        verifyApprovalWithPublicKey(approvals[draft.id], publicKey)
      ).toBe(false);
      const result = await checkApprovalForDraft(draft, null);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.exitCode).toBe(EXIT.forged);
    });
  });

  it("rejects expired approvals", async () => {
    await withTempHome(async () => {
      await initApprover("owner-secret-pass");
      const draft = await createDraft({ texts: ["Expiring soon."] });
      const key = await getPrivateKeyForTests("owner-secret-pass");
      const approval = signApproval(key, draft, {
        scheduledAtIso: null,
        approvalTtlHours: 24,
        scheduledApprovalGraceHours: 6,
        scheduledApprovalMaxHours: 36,
      });
      approval.expiresAt = new Date(Date.now() - 1000).toISOString();
      const { approvalSignPayload, ed25519Sign } = await import("../src/lib/crypto.js");
      approval.signature = ed25519Sign(
        key,
        approvalSignPayload({
          draftId: approval.draftId,
          bindingHash: approval.bindingHash,
          scheduledAtIso: approval.scheduledAtIso,
          approvedAt: approval.approvedAt,
          expiresAt: approval.expiresAt,
          kind: approval.kind,
          batchId: null,
        })
      );
      const approvals = await loadApprovals();
      approvals[draft.id] = approval;
      await saveApprovals(approvals);
      const result = await checkApprovalForDraft(draft, null);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.exitCode).toBe(EXIT.expired);
    });
  });

  it("refuses approve when CI or noninteractive is set", () => {
    process.env.CI = "true";
    expect(() => assertInteractiveApprovalAllowed()).toThrow(/non-interactive/);
    delete process.env.CI;
    process.env.XPOST_NONINTERACTIVE = "1";
    expect(() => assertInteractiveApprovalAllowed()).toThrow(/non-interactive/);
    delete process.env.XPOST_NONINTERACTIVE;
  });

  it("thread approval binds ordered texts as a set", async () => {
    await withTempHome(async () => {
      await initApprover("owner-secret-pass");
      const draft = await createDraft({
        texts: ["First", "Second", "Third"],
      });
      const key = await getPrivateKeyForTests("owner-secret-pass");
      const approval = signApproval(key, draft, {
        scheduledAtIso: null,
        approvalTtlHours: 1,
        scheduledApprovalGraceHours: 6,
        scheduledApprovalMaxHours: 36,
      });
      const publicKey = await loadVerifyPublicKey();
      expect(verifyApprovalWithPublicKey(approval, publicKey)).toBe(true);
      const swapped = await createDraft({ texts: ["Second", "First", "Third"] });
      expect(swapped.bindingHash).not.toBe(draft.bindingHash);
    });
  });

  it("reply and quote targets are part of the binding", async () => {
    await withTempHome(async () => {
      const a = await createDraft({
        texts: ["Reply body"],
        replyToId: "111",
      });
      const b = await createDraft({
        texts: ["Reply body"],
        replyToId: "222",
      });
      const c = await createDraft({
        texts: ["Reply body"],
        quoteId: "111",
      });
      expect(a.bindingHash).not.toBe(b.bindingHash);
      expect(a.bindingHash).not.toBe(c.bindingHash);
    });
  });

  it("scheduled expiry covers slot with grace and max cap", () => {
    const approvedAtMs = Date.parse("2026-10-26T10:00:00.000Z");
    const scheduledAtIso = "2026-10-26T20:00:00.000Z";
    const expires = computeExpiryIso({
      approvedAtMs,
      scheduledAtIso,
      approvalTtlHours: 24,
      scheduledApprovalGraceHours: 6,
      scheduledApprovalMaxHours: 36,
    });
    // scheduled + 6h = 2026-10-27T02:00:00Z
    expect(expires).toBe("2026-10-27T02:00:00.000Z");

    const far = computeExpiryIso({
      approvedAtMs,
      scheduledAtIso: "2026-10-28T20:00:00.000Z",
      approvalTtlHours: 24,
      scheduledApprovalGraceHours: 6,
      scheduledApprovalMaxHours: 36,
    });
    // capped at approvedAt + 36h
    expect(far).toBe("2026-10-27T22:00:00.000Z");
  });

  it("verifies with public key after approver dir is removed", async () => {
    await withTempHome(async (home) => {
      await initApprover("owner-secret-pass");
      const draft = await createDraft({ texts: ["Public verify path"] });
      const key = await getPrivateKeyForTests("owner-secret-pass");
      const approval = signApproval(key, draft, {
        scheduledAtIso: null,
        approvalTtlHours: 24,
        scheduledApprovalGraceHours: 6,
        scheduledApprovalMaxHours: 36,
      });
      const approvals = await loadApprovals();
      approvals[draft.id] = approval;
      await saveApprovals(approvals);
      await fs.rm(path.join(home, "approver"), { recursive: true, force: true });
      const result = await checkApprovalForDraft(draft, null);
      expect(result.ok).toBe(true);
    });
  });
});
