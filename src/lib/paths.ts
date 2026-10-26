import os from "node:os";
import path from "node:path";

export function getXpostHome(): string {
  if (process.env.XPOST_HOME) {
    return path.resolve(process.env.XPOST_HOME);
  }
  return path.join(os.homedir(), ".local", "share", "xpost");
}

export function getConfigDir(): string {
  if (process.env.XPOST_CONFIG_DIR) {
    return path.resolve(process.env.XPOST_CONFIG_DIR);
  }
  return path.join(os.homedir(), ".config", "xpost");
}

export function getApproverDir(): string {
  if (process.env.XPOST_APPROVER_DIR) {
    return path.resolve(process.env.XPOST_APPROVER_DIR);
  }
  return path.join(getXpostHome(), "approver");
}

export function getPaths() {
  const home = getXpostHome();
  const configDir = getConfigDir();
  const approverDir = getApproverDir();
  return {
    home,
    configDir,
    configFile: path.join(configDir, "config"),
    appConfigFile: path.join(home, "app-config.json"),
    draftsDir: path.join(home, "drafts"),
    approvalsFile: path.join(home, "approvals.json"),
    batchesDir: path.join(home, "batches"),
    batchesIndexFile: path.join(home, "batches", "index.json"),
    verifyKeyFile: path.join(home, "verify-key.json"),
    approverDir,
    approverFile: path.join(approverDir, "approver.json"),
    stateFile: path.join(home, "state.json"),
    scheduleFile: path.join(home, "schedule.json"),
    postedFile: path.join(home, "posted.json"),
    auditFile: path.join(home, "audit.jsonl"),
    runDueLockFile: path.join(home, "run-due.lock"),
    storeLockFile: path.join(home, "store.lock"),
  };
}
