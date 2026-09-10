import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { CommandError, type CommandOptions, type CommandResult } from "../util/command.js";

const SHUTDOWN_GRACE_MS = 500;
export const CODEX_PROCESS_SHUTDOWN_MS = 1_000;

// The supervisor stays in the group until it signals itself and every descendant.
// No process outside that group ever signals a saved numeric group ID. File descriptors
// 4/5 carry only app-server output; closing our copies preserves the target's EOF semantics.
const POSIX_SUPERVISOR = String.raw`
const { spawn } = require("node:child_process");
const { closeSync } = require("node:fs");
const { executablePath, args, graceMs } = JSON.parse(process.argv[1]);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.kill(0, "SIGKILL"), graceMs);
  process.kill(0, "SIGTERM");
}
function report(message) {
  if (process.connected) process.send(message, error => { if (error) stop(); });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("disconnect", stop);
process.on("message", message => { if (message === "stop") stop(); });
const target = spawn(executablePath, args, { stdio: [0, 4, 5] });
closeSync(0);
closeSync(4);
closeSync(5);
target.on("error", error => report({ kind: "error", message: error.message }));
target.on("close", code => report({ kind: "close", code }));
`;

export type CodexProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  onError(listener: (error: Error) => void): void;
  onClose(listener: (code: number | null) => void): void;
  stop(done: (error?: Error) => void): void;
};

/** Run a finite Codex command with the same descendant ownership as model discovery. */
export function runCodexCommand(
  command: string,
  args: string[],
  options: Pick<CommandOptions, "cwd" | "env" | "timeoutMs">,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = startCodexProcess(command, args, options.cwd, options.env ?? process.env);
    const result: CommandResult = { command, args, exitCode: 1, stdout: "", stderr: "" };
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stop(() => {
        if (error) reject(error);
        else if (result.exitCode === 0) resolve(result);
        else reject(new CommandError(result));
      });
    };
    const timeoutMs = options.timeoutMs ?? 10_000;
    const timer = setTimeout(() => {
      result.exitCode = 128;
      result.stderr += `\nTimed out after ${timeoutMs}ms\n`;
      finish();
    }, timeoutMs);
    for (const name of ["stdout", "stderr"] as const) {
      child[name].setEncoding("utf8");
      child[name].on("data", (chunk: string) => {
        if (settled) return;
        result[name] += chunk;
        if (result[name].length > 32 * 1024 * 1024) {
          result.stderr += "\nCodex command output exceeded 33554432 bytes\n";
          finish();
        }
      });
      child[name].on("error", finish);
    }
    child.stdin.on("error", finish);
    child.onError(finish);
    child.onClose((code) => {
      if (settled) return;
      result.exitCode = code ?? 128;
      finish();
    });
    child.stdin.end();
  });
}

export function startCodexProcess(
  executablePath: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): CodexProcess {
  const supervised = process.platform !== "win32";
  const child = spawn(
    supervised ? process.execPath : executablePath,
    supervised
      ? [
          "--input-type=commonjs",
          "-e",
          POSIX_SUPERVISOR,
          JSON.stringify({ executablePath, args, graceMs: SHUTDOWN_GRACE_MS }),
        ]
      : args,
    {
      cwd,
      env,
      detached: supervised,
      stdio: supervised
        ? ["pipe", "ignore", "ignore", "ipc", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
    },
  );
  // These descriptors are always pipes, as specified immediately above.
  const stdin = child.stdin as Writable;
  const stdout = child.stdio[supervised ? 4 : 1] as Readable;
  const stderr = child.stdio.at(supervised ? 5 : 2) as Readable;
  const errors: ((error: Error) => void)[] = [];
  const closes: ((code: number | null) => void)[] = [];
  let closed = false;
  let targetClosed = false;
  let targetCode: number | null = null;
  let reportedClose = false;
  const reportClose = (): void => {
    // IPC may arrive before output; preserve all target output before reporting its exit.
    if (!targetClosed || !stdout.closed || !stderr.closed || reportedClose) return;
    reportedClose = true;
    for (const listener of closes) listener(targetCode);
  };
  stdout.once("close", reportClose);
  stderr.once("close", reportClose);
  child.on("error", (error) => {
    for (const listener of errors) listener(error);
  });
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    if (
      "kind" in message &&
      message.kind === "error" &&
      "message" in message &&
      typeof message.message === "string"
    ) {
      for (const listener of errors) listener(new Error(message.message));
    } else if (
      "kind" in message &&
      message.kind === "close" &&
      "code" in message &&
      (message.code === null || typeof message.code === "number")
    ) {
      targetClosed = true;
      targetCode = message.code;
      reportClose();
    }
  });
  child.once("close", (code) => {
    closed = true;
    if (!targetClosed) {
      targetClosed = true;
      targetCode = code;
    }
    reportClose();
  });

  return {
    stdin,
    stdout,
    stderr,
    onError: (listener) => {
      errors.push(listener);
    },
    onClose: (listener) => {
      closes.push(listener);
    },
    stop: (done) => {
      if (closed) {
        done();
        return;
      }
      let finished = false;
      let terminationFinished = supervised;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        child.removeListener("close", finishIfReady);
        done();
      };
      const finishIfReady = (): void => {
        if (closed && terminationFinished) finish();
      };
      const deadline = setTimeout(() => {
        if (supervised) {
          // The deadline bounds the caller's wait, not the cleanup owner's lifetime.
          // Resume a suspended supervisor and leave it responsible for its own group.
          child.kill("SIGCONT");
          if (child.connected) child.disconnect();
          child.channel?.unref();
        } else {
          child.kill("SIGKILL");
        }
        stdin.destroy();
        stdout.destroy();
        stderr.destroy();
        child.unref();
        finish();
      }, CODEX_PROCESS_SHUTDOWN_MS);
      child.once("close", finishIfReady);
      if (supervised) {
        // The supervisor also stops on IPC disconnect (including an unexpected parent exit).
        if (child.connected)
          child.send("stop", (error) => {
            if (error && child.connected) child.disconnect();
          });
        return;
      }
      let fallbackStarted = false;
      const fallbackKill = (): void => {
        if (fallbackStarted) return;
        fallbackStarted = true;
        child.kill("SIGKILL");
        terminationFinished = true;
        finishIfReady();
      };
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", fallbackKill);
      killer.once("close", (code) => {
        if (code !== 0) fallbackKill();
        else {
          terminationFinished = true;
          finishIfReady();
        }
      });
    },
  };
}
