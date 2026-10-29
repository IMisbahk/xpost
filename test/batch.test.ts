import { describe, expect, it } from "vitest";
import { dayMs, futureScheduleAt, hourMs, pastScheduleAt, withTempHome } from "./helpers.js";
import { initApprover, getPrivateKeyForTests, signApproval, loadApprovals, saveApprovals, checkApprovalForDraft } from "../src/lib/approval.js";
import { createDraft, saveDraft } from "../src/lib/drafts.js";
import { createBatch, addDraftToBatch, loadBatch, markBatchApproved } from "../src/lib/batches.js";
import { getDueItems, getScheduleForDraft } from "../src/lib/schedule.js";
import { executePost } from "../src/lib/posting.js";
import { EXIT } from "../src/types.js";

describe("batch approval", () => {
  it("creates batch, adds drafts with times, signs per post", async () => {
    await withTempHome(async () => {
      await initApprover("owner-secret-pass");
      const batch = await createBatch("release-week");
      const d1 = await createDraft({ texts: ["Post one"] });
      const d2 = await createDraft({ texts: ["Post two"] });
      await addDraftToBatch(batch.id, d1.id, futureScheduleAt(dayMs));
      await addDraftToBatch(batch.id, d2.id, futureScheduleAt(dayMs + 13 * hourMs));
      const loaded = await loadBatch(batch.id);
      expect(loaded.members).toHaveLength(2);
      expect(loaded.approved).toBe(false);

      const key = await getPrivateKeyForTests("owner-secret-pass");
      const approvals = await loadApprovals();
      for (const member of loaded.members) {
        const draft = await (await import("../src/lib/drafts.js")).loadDraft(member.draftId);
        approvals[draft.id] = signApproval(key, draft, {
          scheduledAtIso: member.atIso,
          batchId: loaded.id,
          approvalTtlHours: 24,
          scheduledApprovalGraceHours: 6,
          scheduledApprovalMaxHours: 36,
        });
      }
      await saveApprovals(approvals);
      await markBatchApproved(loaded);

      for (const member of loaded.members) {
        const draft = await (await import("../src/lib/drafts.js")).loadDraft(member.draftId);
        const check = await checkApprovalForDraft(draft, member.atIso);
        expect(check.ok).toBe(true);
      }
    });
  });

  it("invalidates approval when draft content is edited", async () => {
    await withTempHome(async () => {
      await initApprover("owner-secret-pass");
      const batch = await createBatch("edit-test");
      const draft = await createDraft({ texts: ["Original"] });
      await addDraftToBatch(batch.id, draft.id, pastScheduleAt());
      const member = (await loadBatch(batch.id)).members[0];
      const key = await getPrivateKeyForTests("owner-secret-pass");
      const approval = signApproval(key, draft, {
        scheduledAtIso: member.atIso,
        batchId: batch.id,
        approvalTtlHours: 24,
        scheduledApprovalGraceHours: 6,
        scheduledApprovalMaxHours: 36,
      });
      const approvals = await loadApprovals();
      approvals[draft.id] = approval;
      await saveApprovals(approvals);

      draft.texts = ["Edited after approval"];
      const { computeDraftBindingHash } = await import("../src/lib/drafts.js");
      draft.bindingHash = computeDraftBindingHash(draft);
      draft.textHash = (await import("../src/lib/drafts.js")).computeTextHash(draft.texts);
      await saveDraft(draft);

      const check = await checkApprovalForDraft(draft, member.atIso);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.exitCode).toBe(EXIT.hashMismatch);
    });
  });

  it("invalidates when scheduled time changes after approval", async () => {
    await withTempHome(async () => {
      await initApprover("owner-secret-pass");
      const draft = await createDraft({ texts: ["Timed"] });
      const { scheduleDraft } = await import("../src/lib/schedule.js");
      const firstAt = futureScheduleAt(dayMs);
      const laterAt = futureScheduleAt(dayMs + hourMs);
      const item = await scheduleDraft(draft.id, firstAt);
      const key = await getPrivateKeyForTests("owner-secret-pass");
      const approval = signApproval(key, draft, {
        scheduledAtIso: item.atIso,
        approvalTtlHours: 24,
        scheduledApprovalGraceHours: 6,
        scheduledApprovalMaxHours: 36,
      });
      const approvals = await loadApprovals();
      approvals[draft.id] = approval;
      await saveApprovals(approvals);

      await scheduleDraft(draft.id, laterAt);
      const schedule = await getScheduleForDraft(draft.id);
      // scheduleDraft revokes approval on time change
      const afterRevoke = await checkApprovalForDraft(draft, schedule!.atIso);
      expect(afterRevoke.ok).toBe(false);
      if (!afterRevoke.ok) expect(afterRevoke.exitCode).toBe(EXIT.notApproved);
    });
  });

  it("run-due posts batch members using per-post signatures", async () => {
    await withTempHome(async (_home, fake) => {
      await initApprover("owner-secret-pass");
      const batch = await createBatch("due-batch");
      const draft = await createDraft({ texts: ["Due soon"] });
      await addDraftToBatch(batch.id, draft.id, pastScheduleAt());
      const member = (await loadBatch(batch.id)).members[0];
      const key = await getPrivateKeyForTests("owner-secret-pass");
      const approvals = await loadApprovals();
      approvals[draft.id] = signApproval(key, draft, {
        scheduledAtIso: member.atIso,
        batchId: batch.id,
        approvalTtlHours: 24,
        scheduledApprovalGraceHours: 6,
        scheduledApprovalMaxHours: 36,
      });
      // Extend expiry into the future for this past due schedule
      const signed = approvals[draft.id];
      signed.expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const { approvalSignPayload, ed25519Sign } = await import("../src/lib/crypto.js");
      signed.signature = ed25519Sign(
        key,
        approvalSignPayload({
          draftId: signed.draftId,
          bindingHash: signed.bindingHash,
          scheduledAtIso: signed.scheduledAtIso,
          approvedAt: signed.approvedAt,
          expiresAt: signed.expiresAt,
          kind: signed.kind,
          batchId: signed.batchId ?? null,
        })
      );
      await saveApprovals(approvals);

      const due = await getDueItems();
      expect(due.some((d) => d.draftId === draft.id)).toBe(true);
      await executePost(draft.id);
      expect(fake.created[0].text).toBe("Due soon");
    });
  });

  it("adding a member after approval clears batch approved flag", async () => {
    await withTempHome(async () => {
      await initApprover("owner-secret-pass");
      const batch = await createBatch("mutate");
      const d1 = await createDraft({ texts: ["A"] });
      await addDraftToBatch(batch.id, d1.id, futureScheduleAt(dayMs));
      let loaded = await loadBatch(batch.id);
      await markBatchApproved(loaded);
      loaded = await loadBatch(batch.id);
      expect(loaded.approved).toBe(true);

      const d2 = await createDraft({ texts: ["B"] });
      await addDraftToBatch(batch.id, d2.id, futureScheduleAt(2 * dayMs));
      loaded = await loadBatch(batch.id);
      expect(loaded.approved).toBe(false);
      expect(loaded.members).toHaveLength(2);
    });
  });
});
