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
const args = process.argv.slice(3);
if (process.pid !== 1) process.exit(125);
const stop = () => process.exit(130);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const control = new Socket({ fd: 3, readable: true, writable: false });
control.on("end", stop);
control.on("error", stop);
control.resume();
const target = spawn(command, args, { stdio: [0, 1, 2, extraInput ? 5 : "ignore"] });
if (extraInput) closeSync(5);
target.once("error", error => {
  writeSync(4, JSON.stringify({ error: error.message.slice(0, 2048) }));
  process.exit(125);
});
// Do not wait for command output EOF: a background descendant may retain it.
// Exiting PID 1 makes the kernel kill and reap the entire nested namespace tree.
target.once("exit", (code, signal) => process.exit(code ?? 128));
`;

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
  },
) {
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
  let errorMessage = "";
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
