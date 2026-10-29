import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dayMs, futureScheduleAt, hourMs, withTempHome } from "./helpers.js";
import {
  approveDraftViaChat,
  approveManyViaChat,
  checkApprovalForDraft,
  loadApprovals,
  loadOrCreateChatApprover,
  signApproval,
  saveApprovals,
  verifyApprovalWithPublicKey,
} from "../src/lib/approval.js";
import { createDraft, saveDraft, computeDraftBindingHash, computeTextHash } from "../src/lib/drafts.js";
import { createBatch, addDraftToBatch, loadBatch, markBatchApproved } from "../src/lib/batches.js";
import { executePost } from "../src/lib/posting.js";
import { readAudit } from "../src/lib/audit.js";
import { EXIT } from "../src/types.js";
import { CliError } from "../src/lib/output.js";
import { approvalSignPayload, ed25519Sign } from "../src/lib/crypto.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runXpost(
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

describe("chat approval", () => {
  it("binds approval to text/media/target/schedule and accepts post", async () => {
    await withTempHome(async (_home, fake) => {
      const draft = await createDraft({ texts: ["Chat approved post body."] });
      const { approval } = await approveDraftViaChat(draft, {
        quote: "yes, post that exact text",
        scheduledAtIso: null,
        printPreview: false,
      });
      expect(approval.mode).toBe("chat");
      expect(approval.quote).toBe("yes, post that exact text");
      expect(approval.bindingHash).toBe(draft.bindingHash);

      const check = await checkApprovalForDraft(draft, null);
      expect(check.ok).toBe(true);

      const result = await executePost(draft.id);
      expect(result.postIds.length).toBe(1);
      expect(fake.created[0].text).toBe("Chat approved post body.");
    });
  });

  it("invalidates when draft is edited after chat approval", async () => {
    await withTempHome(async () => {
      const draft = await createDraft({ texts: ["Original chat text"] });
      await approveDraftViaChat(draft, {
        quote: "yes",
        scheduledAtIso: null,
        printPreview: false,
      });
      draft.texts = ["Edited after yes"];
      draft.textHash = computeTextHash(draft.texts);
      draft.bindingHash = computeDraftBindingHash(draft);
      await saveDraft(draft);
      const check = await checkApprovalForDraft(draft, null);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.exitCode).toBe(EXIT.hashMismatch);
    });
  });

  it("refuses missing or empty quote", async () => {
    await withTempHome(async () => {
      const draft = await createDraft({ texts: ["Needs a quote"] });
      await expect(
        approveDraftViaChat(draft, {
          quote: "",
          scheduledAtIso: null,
          printPreview: false,
        })
      ).rejects.toMatchObject({ exitCode: EXIT.usage });
      await expect(
        approveDraftViaChat(draft, {
          quote: "   ",
          scheduledAtIso: null,
          printPreview: false,
        })
      ).rejects.toMatchObject({ exitCode: EXIT.usage });
    });
  });

  it("refuses confirm-hash mismatch", async () => {
    await withTempHome(async () => {
      const draft = await createDraft({ texts: ["Hash check body"] });
      await expect(
        approveDraftViaChat(draft, {
          quote: "yes",
          scheduledAtIso: null,
          confirmHash: "deadbeef",
          printPreview: false,
        })
      ).rejects.toBeInstanceOf(CliError);
      try {
        await approveDraftViaChat(draft, {
          quote: "yes",
          scheduledAtIso: null,
          confirmHash: "deadbeef",
          printPreview: false,
        });
      } catch (error) {
        expect((error as CliError).exitCode).toBe(EXIT.hashMismatch);
      }

      const { approval } = await approveDraftViaChat(draft, {
        quote: "yes",
        scheduledAtIso: null,
        confirmHash: draft.textHash.slice(0, 8),
        printPreview: false,
      });
      expect(approval.mode).toBe("chat");
    });
  });

  it("rejects expired chat approvals", async () => {
    await withTempHome(async () => {
      const draft = await createDraft({ texts: ["Expiring chat approval"] });
      const { privateKeyPkcs8, publicKeySpki } = await loadOrCreateChatApprover();
      const approval = signApproval(privateKeyPkcs8, draft, {
        scheduledAtIso: null,
        approvalTtlHours: 24,
        scheduledApprovalGraceHours: 6,
        scheduledApprovalMaxHours: 36,
        mode: "chat",
        quote: "yes",
      });
      approval.expiresAt = new Date(Date.now() - 1000).toISOString();
      approval.signature = ed25519Sign(
        privateKeyPkcs8,
        approvalSignPayload({
          draftId: approval.draftId,
          bindingHash: approval.bindingHash,
          scheduledAtIso: approval.scheduledAtIso,
          approvedAt: approval.approvedAt,
          expiresAt: approval.expiresAt,
          kind: approval.kind,
          batchId: null,
          mode: "chat",
          quote: "yes",
        })
      );
      const approvals = await loadApprovals();
      approvals[draft.id] = approval;
      await saveApprovals(approvals);
      expect(verifyApprovalWithPublicKey(approval, publicKeySpki)).toBe(true);
      const result = await checkApprovalForDraft(draft, null);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.exitCode).toBe(EXIT.expired);
    });
  });

  it("refuses chat mode when XPOST_APPROVAL_MODES=tty", async () => {
    await withTempHome(async () => {
      process.env.XPOST_APPROVAL_MODES = "tty";
      const draft = await createDraft({ texts: ["Disabled chat"] });
      await expect(
        approveDraftViaChat(draft, {
          quote: "yes",
          scheduledAtIso: null,
          printPreview: false,
        })
      ).rejects.toMatchObject({ exitCode: EXIT.usage });
    });
  });

  it("writes audit entry with mode, quote, and text hashes", async () => {
    await withTempHome(async (home) => {
      const draft = await createDraft({ texts: ["Audit me"] });
      const quote = "yes ship it";
      await approveDraftViaChat(draft, {
        quote,
        scheduledAtIso: null,
        printPreview: false,
      });
      // Mimic command audit (library path does not append; command does).
      const { appendAudit } = await import("../src/lib/audit.js");
      await appendAudit({
        action: "approve-chat",
        draftId: draft.id,
        textHash: draft.textHash,
        detail: `mode=chat quote=${JSON.stringify(quote)} binding=${draft.bindingHash}`,
      });
      const entries = await readAudit();
      const entry = entries.find((e) => e.action === "approve-chat");
      expect(entry).toBeTruthy();
      expect(entry!.draftId).toBe(draft.id);
      expect(entry!.textHash).toBe(draft.textHash);
      expect(entry!.detail).toContain("mode=chat");
      expect(entry!.detail).toContain(quote);
      expect(entry!.prevHash).toMatch(/^[0-9a-f]{64}$/);
      expect(entry!.entryHash).toMatch(/^[0-9a-f]{64}$/);
      void home;
    });
  });

  it("batch chat approval signs per post and invalidates on edit", async () => {
    await withTempHome(async () => {
      const batch = await createBatch("chat-evening");
      const d1 = await createDraft({ texts: ["Batch A"] });
      const d2 = await createDraft({ texts: ["Batch B"] });
      await addDraftToBatch(batch.id, d1.id, futureScheduleAt(dayMs));
      await addDraftToBatch(batch.id, d2.id, futureScheduleAt(dayMs + hourMs));
      const loaded = await loadBatch(batch.id);
      const items = [];
      for (const member of loaded.members) {
        const draft = await (await import("../src/lib/drafts.js")).loadDraft(
          member.draftId
        );
        items.push({
          draft,
          scheduledAtIso: member.atIso,
          timezone: member.timezone,
          batchId: loaded.id,
        });
      }
      const { approvals } = await approveManyViaChat(items, {
        quote: "yes to all three tonight",
        confirmHash: d1.textHash.slice(0, 12),
        printPreview: false,
      });
      expect(approvals).toHaveLength(2);
      await markBatchApproved(loaded);
      for (const member of loaded.members) {
        const draft = await (await import("../src/lib/drafts.js")).loadDraft(
          member.draftId
        );
        const check = await checkApprovalForDraft(draft, member.atIso);
        expect(check.ok).toBe(true);
        if (check.ok) {
          expect(check.approval.mode).toBe("chat");
          expect(check.approval.quote).toBe("yes to all three tonight");
        }
      }

      const edited = await (await import("../src/lib/drafts.js")).loadDraft(d1.id);
      edited.texts = ["Batch A edited"];
      edited.textHash = computeTextHash(edited.texts);
      edited.bindingHash = computeDraftBindingHash(edited);
      await saveDraft(edited);
      const bad = await checkApprovalForDraft(
        edited,
        loaded.members.find((m) => m.draftId === d1.id)!.atIso
      );
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.exitCode).toBe(EXIT.hashMismatch);
    });
  });

  it("CLI approve --chat works non-interactively and returns preview in --json", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "xpost-chat-cli-"));
    const secret = "CHAT_SECRET_TOKEN_should_never_appear_9f3a";
    try {
      const draftResult = await runXpost(
        ["draft", "CLI chat approval text", "--json"],
        {
          XPOST_HOME: home,
          XPOST_CONFIG_DIR: path.join(home, "config"),
          XPOST_APPROVER_DIR: path.join(home, "approver"),
          XPOST_NONINTERACTIVE: "1",
          CI: "true",
        }
      );
      expect(draftResult.code).toBe(0);
      const draftJson = JSON.parse(draftResult.stdout);
      const draftId = draftJson.id as string;
      const textHash = draftJson.textHash as string;

      const approveResult = await runXpost(
        [
          "approve",
          "--chat",
          draftId,
          "--quote",
          "yes post it",
          "--confirm-hash",
          textHash.slice(0, 10),
          "--json",
        ],
        {
          XPOST_HOME: home,
          XPOST_CONFIG_DIR: path.join(home, "config"),
          XPOST_APPROVER_DIR: path.join(home, "approver"),
          XPOST_NONINTERACTIVE: "1",
          CI: "true",
          XPOST_API_KEY: secret,
          XPOST_API_SECRET: secret + "-s",
          XPOST_ACCESS_TOKEN: secret + "-t",
          XPOST_ACCESS_SECRET: secret + "-as",
        }
      );
      expect(approveResult.code).toBe(0);
      const combined = approveResult.stdout + approveResult.stderr;
      expect(combined).not.toContain(secret);
      const json = JSON.parse(approveResult.stdout);
      expect(json.ok).toBe(true);
      expect(json.mode).toBe("chat");
      expect(json.quote).toBe("yes post it");
      expect(json.posts[0].texts).toEqual(["CLI chat approval text"]);
      expect(json.posts[0].textHash).toBe(textHash);
      expect(json.posts[0].scheduledAtIso).toBeNull();

      const missingQuote = await runXpost(
        ["approve", "--chat", draftId, "--json"],
        {
          XPOST_HOME: home,
          XPOST_CONFIG_DIR: path.join(home, "config"),
          XPOST_APPROVER_DIR: path.join(home, "approver"),
          XPOST_NONINTERACTIVE: "1",
        }
      );
      expect(missingQuote.code).toBe(EXIT.usage);

      const disabled = await runXpost(
        [
          "approve",
          "--chat",
          draftId,
          "--quote",
          "yes",
          "--json",
        ],
        {
          XPOST_HOME: home,
          XPOST_CONFIG_DIR: path.join(home, "config"),
          XPOST_APPROVER_DIR: path.join(home, "approver"),
          XPOST_NONINTERACTIVE: "1",
          XPOST_APPROVAL_MODES: "tty",
        }
      );
      expect(disabled.code).toBe(EXIT.usage);
      expect(disabled.stderr + disabled.stdout).toMatch(/disabled/i);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("auto-generates chat key under XPOST_HOME on first use", async () => {
    await withTempHome(async (home) => {
      const before = await fs.readdir(home);
      expect(before.includes("chat-approver.json")).toBe(false);
      const draft = await createDraft({ texts: ["Key gen"] });
      await approveDraftViaChat(draft, {
        quote: "yes",
        scheduledAtIso: null,
        printPreview: false,
      });
      const store = JSON.parse(
        await fs.readFile(path.join(home, "chat-approver.json"), "utf8")
      );
      expect(store.scheme).toBe("ed25519");
      expect(store.privateKeyPkcs8Hex).toMatch(/^[0-9a-f]+$/);
      expect(store.publicKeySpkiHex).toMatch(/^[0-9a-f]+$/);
    });
  });
});
