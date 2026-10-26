export function isInteractiveTty(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout
): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export function assertInteractiveApprovalAllowed(): void {
  if (process.env.CI || process.env.XPOST_NONINTERACTIVE === "1") {
    const error = new Error(
      "Approval refused: non-interactive environment (CI or XPOST_NONINTERACTIVE is set). An assistant cannot approve posts."
    ) as Error & { exitCode?: number };
    error.exitCode = 10;
    throw error;
  }
  if (!isInteractiveTty()) {
    const error = new Error(
      "Approval refused: stdin/stdout is not a TTY. Run `xpost approve` yourself in an interactive terminal."
    ) as Error & { exitCode?: number };
    error.exitCode = 10;
    throw error;
  }
}

export async function promptHidden(
  question: string,
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY || !stdout.isTTY) {
      reject(
        Object.assign(new Error("Hidden prompt requires a TTY."), {
          exitCode: 10,
        })
      );
      return;
    }

    stdout.write(question);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r" || char === "\u0004") {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          reject(Object.assign(new Error("Cancelled."), { exitCode: 1 }));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        value += char;
        stdout.write("*");
      }
    };

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
    };

    stdin.on("data", onData);
  });
}

export async function promptLine(
  question: string,
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY || !stdout.isTTY) {
      reject(
        Object.assign(new Error("Prompt requires a TTY."), { exitCode: 10 })
      );
      return;
    }
    stdout.write(question);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      stdin.off("data", onData);
      stdin.pause();
      resolve(chunk.replace(/\r?\n$/, ""));
    };
    stdin.on("data", onData);
  });
}
