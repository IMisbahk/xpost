import { initApprover } from "../lib/approval.js";
import { assertInteractiveApprovalAllowed, promptHidden } from "../lib/tty.js";
import { emitSuccess, type OutputMode, CliError } from "../lib/output.js";
import { EXIT } from "../types.js";
import { appendAudit } from "../lib/audit.js";

export async function cmdInitApprover(mode: OutputMode): Promise<void> {
  assertInteractiveApprovalAllowed();
  process.stdout.write(
    "Set an approval passphrase. Only the human owner should know this.\n"
  );
  process.stdout.write(
    "Private key stays in XPOST_APPROVER_DIR (encrypted). Public verify key is written to XPOST_HOME.\n"
  );
  process.stdout.write(
    "Assistants must not run this command. Keep XPOST_APPROVER_DIR off assistant machines.\n"
  );
  const passphrase = await promptHidden("Passphrase (min 8 chars): ");
  const confirm = await promptHidden("Confirm passphrase: ");
  if (passphrase !== confirm) {
    throw new CliError("Passphrases did not match.", EXIT.usage);
  }
  const paths = await initApprover(passphrase);
  await appendAudit({
    action: "init-approver",
    detail: "ed25519 approver store created",
  });
  emitSuccess(
    mode,
    {
      approverFile: paths.approverFile,
      verifyKeyFile: paths.verifyKeyFile,
      ready: true,
      scheme: "ed25519",
    },
    [
      `Approver store created at ${paths.approverFile} (mode 600).`,
      `Public verify key written to ${paths.verifyKeyFile}.`,
      "Keep the passphrase and approver dir off machines that assistants control.",
      "The assistant data dir can verify signatures but cannot forge them.",
    ]
  );
}
