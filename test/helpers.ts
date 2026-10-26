import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setXApiClientOverride } from "../src/xapi/client.js";
import { FakeXApiClient } from "../src/xapi/fake.js";

export async function withTempHome<T>(
  fn: (home: string, fake: FakeXApiClient) => Promise<T>
): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "xpost-test-"));
  const previous = {
    XPOST_HOME: process.env.XPOST_HOME,
    XPOST_CONFIG_DIR: process.env.XPOST_CONFIG_DIR,
    XPOST_APPROVER_DIR: process.env.XPOST_APPROVER_DIR,
    CI: process.env.CI,
    XPOST_NONINTERACTIVE: process.env.XPOST_NONINTERACTIVE,
  };
  process.env.XPOST_HOME = home;
  process.env.XPOST_CONFIG_DIR = path.join(home, "config");
  process.env.XPOST_APPROVER_DIR = path.join(home, "approver");
  delete process.env.CI;
  delete process.env.XPOST_NONINTERACTIVE;

  const fake = new FakeXApiClient();
  setXApiClientOverride(fake);

  try {
    return await fn(home, fake);
  } finally {
    setXApiClientOverride(null);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}
