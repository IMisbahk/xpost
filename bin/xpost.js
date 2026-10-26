#!/usr/bin/env node
import { runCli } from "../dist/cli.js";

runCli(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(typeof error?.exitCode === "number" ? error.exitCode : 1);
});
