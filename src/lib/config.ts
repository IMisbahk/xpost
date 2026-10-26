import { getPaths } from "./paths.js";
import { assertModeNotTooOpen, ensureDir, readJsonFile, writeJsonFile } from "./fsutil.js";
import type { AppConfig, AuthConfig } from "../types.js";
import { registerSecrets } from "./redactor.js";
import { CliError } from "./output.js";
import { EXIT } from "../types.js";
import fs from "node:fs";

export const DEFAULT_APP_CONFIG: AppConfig = {
  characterLimit: 280,
  approvalTtlHours: 24,
  scheduledApprovalGraceHours: 6,
  scheduledApprovalMaxHours: 36,
  dailyPostCap: 8,
  defaultTimezone: "Asia/Calcutta",
  ownerHandle: "mmisbbahh",
};

export async function loadAppConfig(): Promise<AppConfig> {
  const { appConfigFile, home } = getPaths();
  await ensureDir(home);
  const stored = await readJsonFile<Partial<AppConfig>>(appConfigFile, {});
  return { ...DEFAULT_APP_CONFIG, ...stored };
}

export async function saveAppConfig(config: AppConfig): Promise<void> {
  const { appConfigFile } = getPaths();
  await writeJsonFile(appConfigFile, config, 0o600);
}

function parseConfigFile(contents: string): AuthConfig {
  const auth: AuthConfig = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    switch (key) {
      case "XPOST_API_KEY":
        auth.apiKey = value;
        break;
      case "XPOST_API_SECRET":
        auth.apiSecret = value;
        break;
      case "XPOST_ACCESS_TOKEN":
        auth.accessToken = value;
        break;
      case "XPOST_ACCESS_SECRET":
        auth.accessSecret = value;
        break;
      case "XPOST_OAUTH2_TOKEN":
        auth.oauth2Token = value;
        break;
      default:
        break;
    }
  }
  return auth;
}

function authFromEnv(): AuthConfig {
  const auth: AuthConfig = {};
  if (process.env.XPOST_API_KEY) auth.apiKey = process.env.XPOST_API_KEY;
  if (process.env.XPOST_API_SECRET) auth.apiSecret = process.env.XPOST_API_SECRET;
  if (process.env.XPOST_ACCESS_TOKEN) auth.accessToken = process.env.XPOST_ACCESS_TOKEN;
  if (process.env.XPOST_ACCESS_SECRET) auth.accessSecret = process.env.XPOST_ACCESS_SECRET;
  if (process.env.XPOST_OAUTH2_TOKEN) auth.oauth2Token = process.env.XPOST_OAUTH2_TOKEN;
  return auth;
}

/**
 * Credential priority: env vars, then optional config file.
 * Env-only setups need no config file and no `xpost auth`.
 */
export function loadAuthConfig(): AuthConfig {
  const auth = authFromEnv();

  // Register env secrets immediately so errors never echo them
  registerSecrets(
    [
      auth.apiKey,
      auth.apiSecret,
      auth.accessToken,
      auth.accessSecret,
      auth.oauth2Token,
    ].filter((v): v is string => Boolean(v))
  );

  if (hasUsableAuth(auth)) {
    return auth;
  }

  const { configFile, configDir } = getPaths();
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  } catch {
    // Config dir is optional when env creds are used; ignore failures.
  }

  if (fs.existsSync(configFile)) {
    try {
      assertModeNotTooOpen(configFile, 0o600);
    } catch (error) {
      throw new CliError(
        error instanceof Error ? error.message : String(error),
        EXIT.configPerms
      );
    }
    const fileAuth = parseConfigFile(fs.readFileSync(configFile, "utf8"));
    auth.apiKey ??= fileAuth.apiKey;
    auth.apiSecret ??= fileAuth.apiSecret;
    auth.accessToken ??= fileAuth.accessToken;
    auth.accessSecret ??= fileAuth.accessSecret;
    auth.oauth2Token ??= fileAuth.oauth2Token;
    registerSecrets(
      [
        auth.apiKey,
        auth.apiSecret,
        auth.accessToken,
        auth.accessSecret,
        auth.oauth2Token,
      ].filter((v): v is string => Boolean(v))
    );
  }

  return auth;
}

export async function saveAuthConfig(auth: AuthConfig): Promise<void> {
  const { configFile, configDir } = getPaths();
  await ensureDir(configDir, 0o700);
  const lines = [
    "# xpost credentials (chmod 600). Prefer env vars when possible.",
    auth.apiKey ? `XPOST_API_KEY=${auth.apiKey}` : "",
    auth.apiSecret ? `XPOST_API_SECRET=${auth.apiSecret}` : "",
    auth.accessToken ? `XPOST_ACCESS_TOKEN=${auth.accessToken}` : "",
    auth.accessSecret ? `XPOST_ACCESS_SECRET=${auth.accessSecret}` : "",
    auth.oauth2Token ? `XPOST_OAUTH2_TOKEN=${auth.oauth2Token}` : "",
  ].filter(Boolean);
  const { atomicWriteFile } = await import("./fsutil.js");
  await atomicWriteFile(configFile, `${lines.join("\n")}\n`, 0o600);
  registerSecrets(
    [auth.apiKey, auth.apiSecret, auth.accessToken, auth.accessSecret, auth.oauth2Token].filter(
      (v): v is string => Boolean(v)
    )
  );
}

export function hasUsableAuth(auth: AuthConfig): boolean {
  const oauth1 =
    Boolean(auth.apiKey) &&
    Boolean(auth.apiSecret) &&
    Boolean(auth.accessToken) &&
    Boolean(auth.accessSecret);
  return oauth1 || Boolean(auth.oauth2Token);
}
