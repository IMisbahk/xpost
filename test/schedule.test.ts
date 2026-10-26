import { describe, expect, it } from "vitest";
import { parseScheduleAt } from "../src/lib/timezone.js";
import { withTempHome } from "./helpers.js";
import { scheduleDraft, getDueItems, withRunDueLock, unscheduleDraft } from "../src/lib/schedule.js";
import {
  initApprover,
  signApproval,
  loadApprovals,
  saveApprovals,
  getPrivateKeyForTests,
} from "../src/lib/approval.js";
import { createDraft } from "../src/lib/drafts.js";
import { cmdRunDue } from "../src/commands/scheduleCmd.js";

describe("schedule timezone parsing", () => {
  it("parses IST wall time into UTC", () => {
    const parsed = parseScheduleAt("2026-10-27 20:00 IST", "Asia/Calcutta");
    expect(parsed.atIso).toBe("2026-10-27T14:30:00.000Z");
    expect(parsed.timezone).toBe("IST");
  });

  it("defaults to Asia/Calcutta when zone omitted", () => {
    const parsed = parseScheduleAt("2026-10-27 20:00", "Asia/Calcutta");
    expect(parsed.atIso).toBe("2026-10-27T14:30:00.000Z");
  });

  it("accepts explicit ISO offsets", () => {
    const parsed = parseScheduleAt("2026-10-27T20:00:00+05:30", "Asia/Calcutta");
    expect(parsed.atIso).toBe("2026-10-27T14:30:00.000Z");
  });
});

describe("run-due idempotency", () => {
  it("posts due approved items once under lock", async () => {
    await withTempHome(async (_home, fake) => {
      await initApprover("owner-secret-pass");
      const draft = await createDraft({ texts: ["Scheduled post"] });
      const item = await scheduleDraft(draft.id, "2000-01-01 00:00 UTC");
      const key = await getPrivateKeyForTests("owner-secret-pass");
      const approval = signApproval(key, draft, {
        scheduledAtIso: item.atIso,
        approvalTtlHours: 24,
        scheduledApprovalGraceHours: 6,
        scheduledApprovalMaxHours: 36,
      });
      // Historical schedule would expire under default cap; re-sign with future expiry
      approval.expiresAt = new Date(Date.now() + 3600_000).toISOString();
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

      await withRunDueLock(async () => {
        const due = await getDueItems();
        expect(due.map((d) => d.draftId)).toContain(draft.id);
      });

      const silent = { write: () => true } as unknown as typeof process.stdout;
      const prevOut = process.stdout.write;
      process.stdout.write = silent.write.bind(silent) as typeof process.stdout.write;
      try {
        await cmdRunDue({ json: true });
        expect(fake.created.length).toBe(1);

        const dueAfter = await getDueItems();
        expect(dueAfter.find((d) => d.draftId === draft.id)).toBeUndefined();

        await cmdRunDue({ json: true });
        expect(fake.created.length).toBe(1);
      } finally {
        process.stdout.write = prevOut;
      }
    });
  });

  it("unschedule removes items", async () => {
    await withTempHome(async () => {
      const draft = await createDraft({ texts: ["Later"] });
      await scheduleDraft(draft.id, "2099-01-01 00:00 UTC");
      expect(await unscheduleDraft(draft.id)).toBe(true);
      expect(await unscheduleDraft(draft.id)).toBe(false);
    });
  });
});
