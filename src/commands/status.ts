import { loadState, getDailyCount } from "../lib/safety.js";
import { loadAppConfig } from "../lib/config.js";
import { listSchedule } from "../lib/schedule.js";
import { loadApprovals } from "../lib/approval.js";
import { listDrafts } from "../lib/drafts.js";
import { emitSuccess, type OutputMode } from "../lib/output.js";

export async function cmdStatus(mode: OutputMode): Promise<void> {
  const state = await loadState();
  const config = await loadAppConfig();
  const dailyCount = await getDailyCount();
  const schedule = await listSchedule();
  const approvals = await loadApprovals();
  const now = Date.now();
  const pendingApprovals = Object.values(approvals).filter(
    (a) => Date.parse(a.expiresAt) >= now
  );
  const drafts = await listDrafts();
  const unapproved = drafts.filter((d) => !approvals[d.id]);

  emitSuccess(
    mode,
    {
      paused: state.paused,
      pausedAt: state.pausedAt,
      dailyCount,
      dailyPostCap: config.dailyPostCap,
      pendingApprovals: pendingApprovals.map((a) => ({
        id: a.draftId,
        expiresAt: a.expiresAt,
      })),
      unapprovedDrafts: unapproved.map((d) => d.id),
      scheduled: schedule,
      ownerHandle: config.ownerHandle,
      approvalTtlHours: config.approvalTtlHours,
    },
    [
      `paused: ${state.paused}`,
      `daily: ${dailyCount}/${config.dailyPostCap}`,
      `pending approvals: ${pendingApprovals.length}`,
      `unapproved drafts: ${unapproved.length}`,
      `scheduled: ${schedule.length}`,
    ]
  );
}

export async function cmdPause(mode: OutputMode): Promise<void> {
  const { setPaused } = await import("../lib/safety.js");
  const { appendAudit } = await import("../lib/audit.js");
  const state = await setPaused(true);
  await appendAudit({ action: "pause" });
  emitSuccess(mode, { paused: true, pausedAt: state.pausedAt }, [
    "xpost is paused. post, delete, and run-due are blocked.",
  ]);
}

export async function cmdResume(mode: OutputMode): Promise<void> {
  const { setPaused } = await import("../lib/safety.js");
  const { appendAudit } = await import("../lib/audit.js");
  await setPaused(false);
  await appendAudit({ action: "resume" });
  emitSuccess(mode, { paused: false }, ["xpost resumed."]);
}
