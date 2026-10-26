import { redactJson, redactText, safeStringify } from "./redactor.js";
import type { ExitCode } from "../types.js";

export type OutputMode = {
  json: boolean;
};

export class CliError extends Error {
  exitCode: ExitCode;
  details?: unknown;

  constructor(message: string, exitCode: ExitCode = 1, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function emitSuccess(
  mode: OutputMode,
  data: Record<string, unknown>,
  humanLines?: string[]
): void {
  if (mode.json) {
    process.stdout.write(`${safeStringify({ ok: true, ...data })}\n`);
    return;
  }
  const lines = humanLines ?? Object.entries(data).map(([k, v]) => `${k}: ${formatHuman(v)}`);
  for (const line of lines) {
    process.stdout.write(`${redactText(line)}\n`);
  }
}

export function emitError(mode: OutputMode, error: unknown): ExitCode {
  const cliError =
    error instanceof CliError
      ? error
      : new CliError(
          error instanceof Error ? error.message : String(error),
          ((error as { exitCode?: number })?.exitCode as ExitCode) || 1
        );

  if (mode.json) {
    process.stderr.write(
      `${safeStringify({
        ok: false,
        error: redactText(cliError.message),
        exitCode: cliError.exitCode,
        details: cliError.details ? redactJson(cliError.details) : undefined,
      })}\n`
    );
  } else {
    process.stderr.write(`${redactText(cliError.message)}\n`);
  }
  return cliError.exitCode;
}

function formatHuman(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
