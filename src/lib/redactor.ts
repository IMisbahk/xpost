const SECRET_ENV_KEYS = [
  "XPOST_API_KEY",
  "XPOST_API_SECRET",
  "XPOST_ACCESS_TOKEN",
  "XPOST_ACCESS_SECRET",
  "XPOST_OAUTH2_TOKEN",
] as const;

const SENSITIVE_JSON_KEYS = new Set([
  "apikey",
  "apisecret",
  "accesstoken",
  "accesssecret",
  "oauth2token",
  "token",
  "secret",
  "password",
  "passphrase",
  "authorization",
  "bearer",
  "consumer_key",
  "consumer_secret",
  "access_token",
  "access_token_secret",
  "oauth_token",
  "oauth_token_secret",
]);

function collectKnownSecrets(extraSecrets: string[] = []): string[] {
  const secrets = new Set<string>();
  for (const key of SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length >= 4) {
      secrets.add(value);
    }
  }
  for (const value of registeredSecrets) {
    if (value && value.length >= 4) {
      secrets.add(value);
    }
  }
  for (const value of extraSecrets) {
    if (value && value.length >= 4) {
      secrets.add(value);
    }
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

function redactKnownSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function redactBearerAndOauth(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~\-+/=]+/gi, "Bearer [REDACTED]")
    .replace(/oauth_consumer_key="[^"]+"/gi, 'oauth_consumer_key="[REDACTED]"')
    .replace(/oauth_token="[^"]+"/gi, 'oauth_token="[REDACTED]"')
    .replace(/oauth_signature="[^"]+"/gi, 'oauth_signature="[REDACTED]"')
    .replace(
      /(api[_-]?key|api[_-]?secret|access[_-]?token|access[_-]?secret|oauth2[_-]?token|consumer[_-]?key|consumer[_-]?secret)\s*[:=]\s*["']?[^"',\s}]+["']?/gi,
      "$1=[REDACTED]"
    );
}

function redactObject(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, secrets));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_JSON_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactObject(nested, secrets);
      }
    }
    return out;
  }
  return value;
}

export function redactText(text: string, extraSecrets: string[] = []): string {
  const secrets = collectKnownSecrets(extraSecrets);
  return redactBearerAndOauth(redactKnownSecrets(text, secrets));
}

export function redactJson(value: unknown, extraSecrets: string[] = []): unknown {
  const secrets = collectKnownSecrets(extraSecrets);
  return redactObject(value, secrets);
}

export function safeStringify(value: unknown, extraSecrets: string[] = []): string {
  return JSON.stringify(redactJson(value, extraSecrets), null, 2);
}

export function registerSecrets(secrets: string[]): void {
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      registeredSecrets.add(secret);
    }
  }
}

const registeredSecrets = new Set<string>();

export function getRegisteredSecrets(): string[] {
  return [...registeredSecrets];
}

export function redactWithRegistered(text: string): string {
  return redactText(text, getRegisteredSecrets());
}
