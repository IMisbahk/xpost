import { describe, expect, it } from "vitest";
import { withTempHome } from "./helpers.js";
import {
  initApprover,
  signApproval,
  loadApprovals,
  saveApprovals,
  getPrivateKeyForTests,
} from "../src/lib/approval.js";
import { createDraft } from "../src/lib/drafts.js";
import { executePost, buildPostPlan } from "../src/lib/posting.js";
import { setPaused, recordPosted } from "../src/lib/safety.js";
import { EXIT } from "../src/types.js";
import { CliError } from "../src/lib/output.js";

async function approve(draftId: string, scheduledAtIso: string | null = null) {
  const { loadDraft } = await import("../src/lib/drafts.js");
  const draft = await loadDraft(draftId);
  const key = await getPrivateKeyForTests("owner-secret-pass");
  const approval = signApproval(key, draft, {
    scheduledAtIso,
    approvalTtlHours: 24,
    scheduledApprovalGraceHours: 6,
    scheduledApprovalMaxHours: 36,
  });
  const approvals = await loadApprovals();
  approvals[draft.id] = approval;
  await saveApprovals(approvals);
}

describe("posting safety", () => {
  it("refuses unapproved drafts", async () => {
    await withTempHome(async () => {
      await initApprover("owner-secret-pass");
      const draft = await createDraft({ texts: ["Need approval"] });
      await expect(buildPostPlan(draft.id)).rejects.toMatchObject({
        exitCode: EXIT.notApproved,
      });
    });
  });

  it("posts approved draft via fake client", async () => {
    await withTempHome(async (_home, fake) => {
      await initApprover("owner-secret-pass");
      const draft = await createDraft({ texts: ["Approved content"] });
      await approve(draft.id, null);
      const result = await executePost(draft.id);
      expect(result.postIds.length).toBe(1);
      expect(fake.created[0].text).toBe("Approved content");
    });
  });

  it("dry-run does not call the API", async () => {
    await withTempHome(async (_home, fake) => {
      await initApprover("owner-secret-pass");
      const draft = await createDraft({ texts: ["Dry run text"] });
      await approve(draft.id, null);
      const result = await executePost(draft.id, { dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(fake.created.length).toBe(0);
    });
  });

  it("blocks when paused", async () => {
    await withTempHome(async () => {
      await initApprover("owner-secret-pass");
      const draft = await createDraft({ texts: ["Paused"] });
      await approve(draft.id, null);
      await setPaused(true);
      await expect(executePost(draft.id)).rejects.toMatchObject({
        exitCode: EXIT.paused,
      });
    });
  });

  it("blocks duplicate text against posted history", async () => {
    await withTempHome(async () => {
      await initApprover("owner-secret-pass");
      const draft = await createDraft({ texts: ["Unique once"] });
      await recordPosted({
        draftId: "other",
        textHash: draft.textHash,
        postIds: ["1"],
        postedAt: new Date().toISOString(),
        urls: ["https://x.com/i/status/1"],
      });
      await approve(draft.id, null);
      try {
        await executePost(draft.id);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(EXIT.duplicate);
      }
    });
  });

  it("enforces daily limit", async () => {
    await withTempHome(async () => {
      await initApprover("owner-secret-pass");
      const { saveAppConfig, loadAppConfig } = await import("../src/lib/config.js");
      const config = await loadAppConfig();
      config.dailyPostCap = 1;
      await saveAppConfig(config);
      const first = await createDraft({ texts: ["First of day"] });
      await approve(first.id, null);
      await executePost(first.id);
      const second = await createDraft({ texts: ["Second of day"] });
      await approve(second.id, null);
      await expect(executePost(second.id)).rejects.toMatchObject({
        exitCode: EXIT.dailyLimit,
      });
    });
  });
});
