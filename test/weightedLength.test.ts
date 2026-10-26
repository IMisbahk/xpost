import { describe, expect, it } from "vitest";
import {
  weightedLength,
  validateWeightedLength,
  collectTextWarnings,
} from "../src/lib/weightedLength.js";

describe("weighted length", () => {
  it("counts ascii as 1 and URLs as 23", () => {
    expect(weightedLength("hello")).toBe(5);
    const withUrl = weightedLength("see https://example.com/very/long/path now");
    expect(withUrl).toBe(weightedLength("see ") + 23 + weightedLength(" now"));
  });

  it("rejects over-limit text", () => {
    const long = "a".repeat(281);
    const result = validateWeightedLength([long], 280);
    expect(result.ok).toBe(false);
  });

  it("warns on em dashes, hashtags, and urls", () => {
    const warnings = collectTextWarnings([
      "Hello \u2014 world #launch https://x.com/test",
    ]);
    expect(warnings.some((w) => w.includes("dash"))).toBe(true);
    expect(warnings.some((w) => w.includes("hashtag"))).toBe(true);
    expect(warnings.some((w) => w.includes("URL"))).toBe(true);
  });
});
