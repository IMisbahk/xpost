import { getPaths } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./fsutil.js";
import { loadAppConfig } from "./config.js";
import type { PostedRecord, RuntimeState } from "../types.js";
import { CliError } from "./output.js";
import { EXIT } from "../types.js";
import { listDrafts } from "./drafts.js";

function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export async function loadState(): Promise<RuntimeState> {
  const { stateFile } = getPaths();
  return readJsonFile<RuntimeState>(stateFile, {
    paused: false,
    dailyCounts: {},
  });
}

export async function saveState(state: RuntimeState): Promise<void> {
  const { stateFile } = getPaths();
  await writeJsonFile(stateFile, state, 0o600);
}

export async function setPaused(paused: boolean): Promise<RuntimeState> {
  const state = await loadState();
  state.paused = paused;
  state.pausedAt = paused ? new Date().toISOString() : undefined;
  await saveState(state);
  return state;
}

export async function assertNotPaused(): Promise<void> {
  const state = await loadState();
  if (state.paused) {
    throw new CliError(
      "xpost is paused. Run `xpost resume` before posting, deleting, or run-due.",
      EXIT.paused
    );
  }
}

export async function loadPosted(): Promise<PostedRecord[]> {
  const { postedFile } = getPaths();
  return readJsonFile<PostedRecord[]>(postedFile, []);
}

export async function savePosted(records: PostedRecord[]): Promise<void> {
  const { postedFile } = getPaths();
  await writeJsonFile(postedFile, records, 0o600);
}

export async function assertUnderDailyCap(countToAdd = 1): Promise<void> {
  const config = await loadAppConfig();
  const state = await loadState();
  const key = dayKey();
  const current = state.dailyCounts[key] ?? 0;
  if (current + countToAdd > config.dailyPostCap) {
    throw new CliError(
      `Daily post cap reached (${current}/${config.dailyPostCap}).`,
      EXIT.dailyLimit
    );
  }
}

export async function incrementDailyCount(count = 1): Promise<void> {
  const state = await loadState();
  const key = dayKey();
  state.dailyCounts[key] = (state.dailyCounts[key] ?? 0) + count;
  await saveState(state);
}

export async function assertNotDuplicateText(textHash: string): Promise<void> {
  const posted = await loadPosted();
  if (posted.some((p) => p.textHash === textHash)) {
    throw new CliError(
      "Duplicate text: this text hash was already posted.",
      EXIT.duplicate
    );
  }
  const drafts = await listDrafts();
  const recentCutoff = Date.now() - 7 * 24 * 3600_000;
  const recentDup = drafts.filter(
    (d) =>
      d.textHash === textHash &&
      Date.parse(d.createdAt) >= recentCutoff
  );
  // Allow the current draft itself; callers check before create or pass id
  if (recentDup.length > 1) {
    throw new CliError(
      "Duplicate text: a recent draft already uses this text hash.",
      EXIT.duplicate
    );
  }
}

export async function assertNotDuplicateTextExcluding(
  textHash: string,
  excludeDraftId?: string
): Promise<void> {
  const posted = await loadPosted();
  if (posted.some((p) => p.textHash === textHash)) {
    throw new CliError(
      "Duplicate text: this text hash was already posted.",
      EXIT.duplicate
    );
  }
  const drafts = await listDrafts();
  const recentCutoff = Date.now() - 7 * 24 * 3600_000;
  const conflict = drafts.find(
    (d) =>
      d.id !== excludeDraftId &&
      d.kind === "post" &&
      d.textHash === textHash &&
      Date.parse(d.createdAt) >= recentCutoff
  );
  if (conflict) {
    throw new CliError(
      `Duplicate text: recent draft ${conflict.id} already uses this text hash.`,
      EXIT.duplicate
    );
  }
}

export async function recordPosted(record: PostedRecord): Promise<void> {
  const posted = await loadPosted();
  posted.push(record);
  await savePosted(posted);
}

export async function getDailyCount(): Promise<number> {
  const state = await loadState();
  return state.dailyCounts[dayKey()] ?? 0;
}
