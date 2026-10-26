import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export async function ensureDir(dirPath: string, mode = 0o700): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true, mode });
  try {
    await fsp.chmod(dirPath, mode);
  } catch {
    // ignore chmod failures on exotic filesystems
  }
}

export async function atomicWriteFile(
  filePath: string,
  contents: string | Buffer,
  mode = 0o600
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fsp.writeFile(tempPath, contents, { mode });
  try {
    await fsp.chmod(tempPath, mode);
  } catch {
    // ignore
  }
  await fsp.rename(tempPath, filePath);
  try {
    await fsp.chmod(filePath, mode);
  } catch {
    // ignore
  }
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
  mode = 0o600
): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function assertModeNotTooOpen(filePath: string, maxMode = 0o600): void {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return;
    throw error;
  }
  const mode = stats.mode & 0o777;
  if ((mode & ~maxMode) !== 0) {
    const error = new Error(
      `Refusing to read ${filePath}: permissions are too open (${mode.toString(8)}). Run chmod 600 on the file.`
    ) as Error & { exitCode?: number };
    error.exitCode = 14;
    throw error;
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: { staleMs?: number }
): Promise<T> {
  await ensureDir(path.dirname(lockPath));
  const staleMs = options?.staleMs ?? 60_000;
  const start = Date.now();
  while (true) {
    try {
      const fd = await fsp.open(lockPath, "wx");
      await fd.writeFile(
        JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() })
      );
      await fd.close();
      try {
        return await fn();
      } finally {
        await fsp.unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw error;
      try {
        const raw = await fsp.readFile(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { at?: string };
        const at = parsed.at ? Date.parse(parsed.at) : 0;
        if (at && Date.now() - at > staleMs) {
          await fsp.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        // ignore parse errors
      }
      if (Date.now() - start > staleMs) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
