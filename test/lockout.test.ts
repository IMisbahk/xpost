import { describe, expect, it } from "vitest";
import { withTempHome } from "./helpers.js";
import { initApprover, unlockApproverWithPassphrase } from "../src/lib/approval.js";
import { EXIT } from "../src/types.js";

describe("approver rate limit", () => {
  it("locks out after repeated failed passphrase attempts", async () => {
    await withTempHome(async () => {
      await initApprover("correct-passphrase");
      for (let i = 0; i < 4; i++) {
        await expect(unlockApproverWithPassphrase("wrong")).rejects.toMatchObject({
          exitCode: EXIT.auth,
        });
      }
      await expect(unlockApproverWithPassphrase("wrong")).rejects.toMatchObject({
        exitCode: EXIT.lockout,
      });
      await expect(unlockApproverWithPassphrase("correct-passphrase")).rejects.toMatchObject({
        exitCode: EXIT.lockout,
      });
    });
  });
});
