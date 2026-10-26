import { hasUsableAuth, loadAuthConfig } from "../lib/config.js";
import { CliError } from "../lib/output.js";
import { EXIT } from "../types.js";
import { getXApiClientOverride, type XApiClient } from "./client.js";
import { createRealClient } from "./real.js";

export async function getXApiClient(): Promise<XApiClient> {
  const override = getXApiClientOverride();
  if (override) return override;

  const auth = loadAuthConfig();
  if (!hasUsableAuth(auth)) {
    throw new CliError(
      "No X credentials found. Set env vars or run `xpost auth`.",
      EXIT.auth
    );
  }
  return createRealClient(auth);
}
