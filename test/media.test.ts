import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./helpers.js";
import { createDraft } from "../src/lib/drafts.js";

describe("media binding", () => {
  it("includes media sha256 in binding hash", async () => {
    await withTempHome(async (home) => {
      const fileA = path.join(home, "a.png");
      const fileB = path.join(home, "b.png");
      await fs.writeFile(fileA, "image-bytes-a");
      await fs.writeFile(fileB, "image-bytes-b");
      const draftA = await createDraft({
        texts: ["With media"],
        mediaPaths: [fileA],
      });
      const draftB = await createDraft({
        texts: ["With media"],
        mediaPaths: [fileB],
      });
      const draftNone = await createDraft({ texts: ["With media"] });
      expect(draftA.bindingHash).not.toBe(draftB.bindingHash);
      expect(draftA.bindingHash).not.toBe(draftNone.bindingHash);
      expect(draftA.media[0].sha256).toHaveLength(64);
    });
  });
});
