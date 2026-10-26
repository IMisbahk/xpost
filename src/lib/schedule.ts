import { getPaths } from "./paths.js";
import { readJsonFile, writeJsonFile, withFileLock } from "./fsutil.js";
import type { ScheduleItem } from "../types.js";
import { parseScheduleAt, formatInTimezone } from "./timezone.js";
import { loadAppConfig } from "./config.js";
import { CliError } from "./output.js";
import { EXIT } from "../types.js";
import { revokeApproval } from "./approval.js";

export async function loadSchedule(): Promise<ScheduleItem[]> {
  const { scheduleFile } = getPaths();
  return readJsonFile<ScheduleItem[]>(scheduleFile, []);
}

export async function saveSchedule(items: ScheduleItem[]): Promise<void> {
  const { scheduleFile } = getPaths();
  await writeJsonFile(scheduleFile, items, 0o600);
}

export async function scheduleDraft(
  draftId: string,
  atRaw: string,
  options?: { batchId?: string; invalidateApproval?: boolean }
): Promise<ScheduleItem> {
  const config = await loadAppConfig();
  const parsed = parseScheduleAt(atRaw, config.defaultTimezone);
  const items = await loadSchedule();
  const existing = items.findIndex((i) => i.draftId === draftId);
  const previous = existing >= 0 ? items[existing] : undefined;
  const item: ScheduleItem = {
    draftId,
    atIso: parsed.atIso,
    timezone: parsed.timezone,
    createdAt: new Date().toISOString(),
    batchId: options?.batchId ?? previous?.batchId,
  };

  // Changing schedule time after approval invalidates that post's approval
  if (
    options?.invalidateApproval !== false &&
    previous &&
    previous.atIso !== item.atIso
  ) {
    await revokeApproval(draftId);
  }

  if (existing >= 0) items[existing] = item;
  else items.push(item);
  await saveSchedule(items);
  return item;
}

export async function unscheduleDraft(draftId: string): Promise<boolean> {
  const items = await loadSchedule();
  const next = items.filter((i) => i.draftId !== draftId);
  if (next.length === items.length) return false;
  await saveSchedule(next);
  return true;
}

export async function listSchedule(): Promise<
  Array<ScheduleItem & { atLocal: string }>
> {
  const items = await loadSchedule();
  return items
    .map((item) => ({
      ...item,
      atLocal: formatInTimezone(item.atIso, item.timezone),
    }))
    .sort((a, b) => a.atIso.localeCompare(b.atIso));
}

export async function getDueItems(nowMs = Date.now()): Promise<ScheduleItem[]> {
  const items = await loadSchedule();
  return items
    .filter((item) => Date.parse(item.atIso) <= nowMs)
    .sort((a, b) => a.atIso.localeCompare(b.atIso));
}

export async function getScheduleForDraft(
  draftId: string
): Promise<ScheduleItem | null> {
  const items = await loadSchedule();
  return items.find((i) => i.draftId === draftId) ?? null;
}

export async function withRunDueLock<T>(fn: () => Promise<T>): Promise<T> {
  const { runDueLockFile } = getPaths();
  return withFileLock(runDueLockFile, fn, { staleMs: 120_000 });
}

export function assertScheduleAtPresent(at?: string): string {
  if (!at) {
    throw new CliError(
      'Missing --at. Example: --at "2026-10-27 20:00 IST"',
      EXIT.usage
    );
  }
  return at;
}
