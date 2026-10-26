import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";

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

describe("CLI secret scanning", () => {
  it("does not leak credential env values in status/json output", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "xpost-cli-"));
    const secret = "SUPER_SECRET_VALUE_9f3a2c1b";
    try {
      const result = await runXpost(["status", "--json"], {
        XPOST_HOME: home,
        XPOST_CONFIG_DIR: path.join(home, "config"),
        XPOST_APPROVER_DIR: path.join(home, "approver"),
        XPOST_API_KEY: secret,
        XPOST_API_SECRET: secret + "-s",
        XPOST_ACCESS_TOKEN: secret + "-t",
        XPOST_ACCESS_SECRET: secret + "-as",
        XPOST_NONINTERACTIVE: "1",
      });
      const combined = result.stdout + result.stderr;
      expect(combined).not.toContain(secret);
      expect(combined).not.toContain(secret + "-s");
      expect(result.code).toBe(0);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("approve refuses without TTY / when noninteractive", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "xpost-cli-"));
    try {
      const result = await runXpost(["approve", "nope"], {
        XPOST_HOME: home,
        XPOST_CONFIG_DIR: path.join(home, "config"),
        XPOST_APPROVER_DIR: path.join(home, "approver"),
        XPOST_NONINTERACTIVE: "1",
        CI: "true",
      });
      expect(result.code).toBe(10);
      expect(result.stderr + result.stdout).toMatch(/TTY|non-interactive|not found/i);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
