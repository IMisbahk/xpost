import { saveAuthConfig, loadAuthConfig, hasUsableAuth } from "../lib/config.js";
import { assertInteractiveApprovalAllowed, promptHidden, promptLine } from "../lib/tty.js";
import { emitSuccess, type OutputMode, CliError } from "../lib/output.js";
import { EXIT } from "../types.js";
import { appendAudit } from "../lib/audit.js";

export async function cmdAuth(mode: OutputMode): Promise<void> {
  assertInteractiveApprovalAllowed();

  process.stdout.write(
    "Configure X credentials. Leave blank to keep an existing value.\n"
  );
  process.stdout.write(
    "Prefer OAuth 1.0a user context (API key/secret + access token/secret).\n"
  );

  const existing = loadAuthConfig();
  const apiKey =
    (await promptHidden("API key (consumer key): ")) || existing.apiKey;
  const apiSecret =
    (await promptHidden("API secret (consumer secret): ")) || existing.apiSecret;
  const accessToken =
    (await promptHidden("Access token: ")) || existing.accessToken;
  const accessSecret =
    (await promptHidden("Access token secret: ")) || existing.accessSecret;
  const useOauth2 = (await promptLine("Also set OAuth2 bearer token? [y/N]: "))
    .trim()
    .toLowerCase();
  let oauth2Token = existing.oauth2Token;
  if (useOauth2 === "y" || useOauth2 === "yes") {
    oauth2Token =
      (await promptHidden("OAuth2 user bearer token: ")) || existing.oauth2Token;
  }

  const auth = { apiKey, apiSecret, accessToken, accessSecret, oauth2Token };
  if (!hasUsableAuth(auth)) {
    throw new CliError(
      "Incomplete credentials. Provide OAuth1 quartet or an OAuth2 token.",
      EXIT.auth
    );
  }
  await saveAuthConfig(auth);
  await appendAudit({ action: "auth", detail: "credentials updated" });
  emitSuccess(
    mode,
    { configured: true, oauth1: Boolean(apiKey && apiSecret && accessToken && accessSecret), oauth2: Boolean(oauth2Token) },
    ["Credentials saved to config file (mode 600)."]
  );
}
