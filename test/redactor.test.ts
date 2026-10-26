import { describe, expect, it } from "vitest";
import { redactText, redactJson, safeStringify, registerSecrets } from "../src/lib/redactor.js";

describe("secret redaction", () => {
  it("redacts env-style secrets and bearer tokens", () => {
    process.env.XPOST_API_KEY = "test-api-key-value-12345";
    process.env.XPOST_ACCESS_TOKEN = "test-access-token-value-67890";
    const text = redactText(
      "key=test-api-key-value-12345 Bearer abcdefghijklmnop Authorization: something"
    );
    expect(text).not.toContain("test-api-key-value-12345");
    expect(text).toContain("[REDACTED]");
    expect(text).toMatch(/Bearer \[REDACTED\]/);
    delete process.env.XPOST_API_KEY;
    delete process.env.XPOST_ACCESS_TOKEN;
  });

  it("redacts sensitive JSON keys", () => {
    registerSecrets(["super-secret-token-xyz"]);
    const out = redactJson({
      accessToken: "should-hide",
      nested: { apiSecret: "also-hide", note: "ok" },
      message: "leak super-secret-token-xyz here",
    }) as Record<string, unknown>;
    expect(out.accessToken).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).apiSecret).toBe("[REDACTED]");
    expect(String(out.message)).toContain("[REDACTED]");
    expect(safeStringify({ token: "abc" })).toContain("[REDACTED]");
  });
});
