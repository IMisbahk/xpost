import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const em = "\u2014";
const en = "\u2013";

function listFiles(): string[] {
  try {
    return execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

let failed = false;
for (const file of listFiles()) {
  if (!/\.(md|ts|js|json|txt)$/.test(file)) continue;
  if (!fs.existsSync(file)) continue;
  const content = fs.readFileSync(file, "utf8");
  if (content.includes(em) || content.includes(en)) {
    console.error(`Em/en dash found in ${file}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("No em/en dashes found.");
void path;
