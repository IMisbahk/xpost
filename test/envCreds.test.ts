import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withTempHome } from "./helpers.js";
import { loadAuthConfig, hasUsableAuth } from "../src/lib/config.js";
import { setXApiClientOverride } from "../src/xapi/client.js";
import { FakeXApiClient } from "../src/xapi/fake.js";
import { getXApiClient } from "../src/xapi/factory.js";
import { redactText } from "../src/lib/redactor.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("env-only credentials", () => {
  it("loads usable auth from env with no config file", async () => {
    await withTempHome(async (home) => {
      process.env.XPOST_API_KEY = "env-api-key-aaaaaaaa";
      process.env.XPOST_API_SECRET = "env-api-secret-bbbbbbbb";
      process.env.XPOST_ACCESS_TOKEN = "env-access-token-cccccccc";
      process.env.XPOST_ACCESS_SECRET = "env-access-secret-dddddddd";
      delete process.env.XPOST_OAUTH2_TOKEN;

      const configPath = path.join(home, "config", "config");
      await fs.rm(configPath, { force: true });

      const auth = loadAuthConfig();
      expect(hasUsableAuth(auth)).toBe(true);
      expect(auth.apiKey).toBe("env-api-key-aaaaaaaa");

      setXApiClientOverride(null);
      // factory would create real client; override with fake for path check
      const fake = new FakeXApiClient();
      setXApiClientOverride(fake);
      const client = await getXApiClient();
      const me = await client.verifyCredentials();
      expect(me.username).toBe("mmisbbahh");

      delete process.env.XPOST_API_KEY;
      delete process.env.XPOST_API_SECRET;
      delete process.env.XPOST_ACCESS_TOKEN;
      delete process.env.XPOST_ACCESS_SECRET;
    });
  });

  it("never prints env secrets in whoami/status --json errors", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "xpost-env-"));
    const secret = "ENVONLY_SECRET_VALUE_7c9e2f";
    const run = (args: string[]) =>
      new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
        const child = spawn("node", ["--import", "tsx", "src/cli.ts", ...args], {
          cwd: root,
          env: {
            ...process.env,
            XPOST_HOME: home,
            XPOST_CONFIG_DIR: path.join(home, "missing-config-dir"),
            XPOST_APPROVER_DIR: path.join(home, "approver"),
            XPOST_API_KEY: secret,
            XPOST_API_SECRET: secret + "s",
            XPOST_ACCESS_TOKEN: secret + "t",
            XPOST_ACCESS_SECRET: secret + "as",
            XPOST_NONINTERACTIVE: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("close", (code) => resolve({ stdout, stderr, code }));
      });

    try {
      const status = await run(["status", "--json"]);
      const combined = status.stdout + status.stderr;
      expect(combined).not.toContain(secret);

      process.env.XPOST_API_KEY = secret;
      process.env.XPOST_API_SECRET = secret + "s";
      expect(redactText(`leak ${secret}`)).toContain("[REDACTED]");
      delete process.env.XPOST_API_KEY;
      delete process.env.XPOST_API_SECRET;

      // whoami will try real network without override; still must not leak secrets
      const whoami = await run(["whoami", "--json"]);
      const whoamiOut = whoami.stdout + whoami.stderr;
      expect(whoamiOut).not.toContain(secret);
      expect(whoamiOut).not.toContain(secret + "s");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
