/**
 * Pre-commit style check: fail if tracked files look like they contain
 * live credential material or common secret filenames.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const bannedNamePatterns = [
  /(^|\/)config$/,
  /approver\.json$/,
  /credentials/i,
  /\.pem$/,
  /\.p12$/,
];

const bannedContentPatterns = [
  // Real-looking assignments (not template literals like ${auth.apiSecret})
  /XPOST_API_SECRET=[A-Za-z0-9_\-./+=]{12,}/,
  /XPOST_ACCESS_SECRET=[A-Za-z0-9_\-./+=]{12,}/,
  /XPOST_OAUTH2_TOKEN=[A-Za-z0-9_\-./+=]{12,}/,
  /oauth_token_secret=[A-Za-z0-9_\-./+=]{12,}/,
  /-----BEGIN (RSA |OPENSSH )?PRIVATE KEY-----/,
];

function listTrackedFiles(): string[] {
  try {
    const out = execSync("git ls-files", { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch {
    return walk(root);
  }
}

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(path.relative(root, full));
  }
  return files;
}

let failed = false;
for (const file of listTrackedFiles()) {
  if (file === "scripts/checkSecrets.ts") continue;
  if (bannedNamePatterns.some((re) => re.test(file))) {
    console.error(`Secret-looking filename tracked: ${file}`);
    failed = true;
    continue;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
  if (/\.(png|jpg|jpeg|gif|webp|mp4|mov|woff2?|zip|gz)$/i.test(file)) continue;
  const content = fs.readFileSync(file, "utf8");
  for (const re of bannedContentPatterns) {
    if (re.test(content)) {
      console.error(`Possible secret content in ${file} matching ${re}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log("Secret scan passed.");
