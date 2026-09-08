import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export class NamespaceStopUnprovenError extends Error {}

// This trusted PID 1 is outside Bubblewrap's mounts and inner PID namespace.
// An EOF on the private control descriptor survives cancellation during setup:
// it is still observable when this process eventually starts. The repository
// command never inherits that descriptor or the host-side error channel.
const GUARDIAN = String.raw`
const { spawn } = require("node:child_process");
const { closeSync, writeSync } = require("node:fs");
const { Socket } = require("node:net");
const command = process.argv[1];
const extraInput = process.argv[2] === "extra-input";
const deadline = BigInt(process.argv[3]);
const args = process.argv.slice(4);
if (process.pid !== 1) process.exit(125);
const finish = (code, reason) => {
  writeSync(6, JSON.stringify({ code, reason }));
  process.exit(code);
};
const stop = () => finish(130, "cancelled");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const control = new Socket({ fd: 3, readable: true, writable: false });
control.on("end", stop);
control.on("error", stop);
control.resume();
if (deadline !== 0n) {
  const remaining = deadline - process.hrtime.bigint();
  if (remaining <= 0n) finish(130, "timed_out");
  setTimeout(() => finish(130, "timed_out"), Number((remaining + 999999n) / 1000000n));
}
const target = spawn(command, args, { stdio: [0, 1, 2, extraInput ? 5 : "ignore"] });
if (extraInput) closeSync(5);
target.once("error", error => {
  writeSync(4, JSON.stringify({ error: error.message.slice(0, 2048) }));
  process.exit(125);
});
// Do not wait for command output EOF: a background descendant may retain it.
// Exiting PID 1 makes the kernel kill and reap the entire nested namespace tree.
target.once("exit", (code, signal) => finish(code ?? 128, null));
`;

export type NamespaceCompletion = {
  code: number;
  reason: "cancelled" | "timed_out" | null;
};

/**
 * Own a sandbox lifetime independently of Bubblewrap's startup PDEATHSIG race.
 * unshare waits for our PID 1, including the kernel's namespace teardown. Only
 * its normal exit is reap proof; an externally killed monitor is uncertainty.
 * No saved PID/group is signalled, and no controller-side timeout forges proof.
 */
export function startNamespaceProcess(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "pipe" | "inherit";
    stdin?: "pipe";
    extraInput?: string;
    /** Enforced by the guardian even when the caller cannot process JS callbacks. */
    timeoutMs?: number;
  },
) {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 2_147_483_647)
  )
    throw new Error("Namespace deadline must be a positive bounded integer");
  // hrtime uses the system monotonic clock across processes. Include guardian startup
  // in the bound; a delayed guardian must not launch an already-expired command.
  const deadline =
    options.timeoutMs === undefined
      ? 0n
      : process.hrtime.bigint() + BigInt(options.timeoutMs) * 1_000_000n;
  const child = spawn(
    "/usr/bin/unshare",
    [
      "--user",
      "--map-current-user",
      "--pid",
      "--mount-proc",
      "--fork",
      "--kill-child=SIGKILL",
      "--",
      process.execPath,
      "--input-type=commonjs",
      "-e",
      GUARDIAN,
      "--",
      command,
      options.extraInput === undefined ? "no-extra-input" : "extra-input",
      deadline.toString(),
      ...args,
    ],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: [
        options.stdin ?? (options.stdio === "inherit" ? "inherit" : "ignore"),
        options.stdio,
        options.stdio,
        "pipe",
        "pipe",
        options.extraInput === undefined ? "ignore" : "pipe",
        "pipe",
      ],
      shell: false,
    },
  );
  const control = child.stdio[3] as Writable;
  let failure: Error | undefined;
  const interrupt = () => control.end();
  control.on("error", () => {
    /* The namespace may have already exited. */
  });
  child.once("error", (error) => {
    failure = error;
  });
  const status = child.stdio[4] as Readable;
  const completion = child.stdio.at(6) as Readable;
  let errorMessage = "";
  let completionMessage = "";
  completion.on("data", (chunk: Buffer) => {
    completionMessage += chunk.toString("utf8");
    if (completionMessage.length > 8192) {
      failure = new Error("Namespace completion channel exceeded its bound");
      interrupt();
      completion.destroy();
    }
  });
  status.on("data", (chunk: Buffer) => {
    errorMessage += chunk.toString("utf8");
    if (errorMessage.length > 8192) {
      failure = new Error("Namespace error channel exceeded its bound");
      interrupt();
      status.destroy();
    }
  });
  if (options.extraInput !== undefined) {
    const input = child.stdio.at(5) as Writable;
    input.on("error", (error) => {
      failure ??= error;
      interrupt();
    });
    input.end(options.extraInput);
  }
  return {
    child,
    interrupt,
    /** Private guardian classification plus normal monitor exit; never command stdout. */
    completion(): NamespaceCompletion {
      if (failure || errorMessage || child.signalCode !== null || child.exitCode === null)
        throw new NamespaceStopUnprovenError("Namespace completion requires a normal monitor exit");
      try {
        const record: unknown = JSON.parse(completionMessage);
        if (
          record !== null &&
          typeof record === "object" &&
          Object.keys(record).length === 2 &&
          "code" in record &&
          record.code === child.exitCode &&
          "reason" in record &&
          (record.reason === null || record.reason === "cancelled" || record.reason === "timed_out")
        )
          return { code: child.exitCode, reason: record.reason };
      } catch {
        // Missing or malformed private output cannot become success from exit code alone.
      }
      throw new NamespaceStopUnprovenError(
        "Namespace completion is missing or differs from its monitor exit",
      );
    },
    failure(): Error | undefined {
      if (child.signalCode !== null)
        return new NamespaceStopUnprovenError(
          "Namespace monitor was killed; process-tree stop is unproven",
        );
      if (failure) return failure;
      if (!errorMessage) return undefined;
      try {
        const message: unknown = JSON.parse(errorMessage);
        if (
          message &&
          typeof message === "object" &&
          "error" in message &&
          typeof message.error === "string"
        )
          return new Error(message.error);
      } catch {
        /* Malformed trusted-channel output cannot establish success. */
      }
      return new Error("Invalid namespace startup result");
    },
  };
}
