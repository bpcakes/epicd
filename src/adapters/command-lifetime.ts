import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Socket } from "node:net";
import type { FileHandle } from "node:fs/promises";
import type { Writable } from "node:stream";
import { z } from "zod";
import {
  CommandLifetimeSchema,
  CommandStopSchema,
  assertCommandStop,
  type CommandLifetime,
  type CommandStop,
} from "../domain/command-lifetime.js";
import { digestJson } from "../domain/repository-policy.js";
import { redactSensitiveText } from "../util/redact.js";
import { NamespaceStopUnprovenError, startNamespaceProcess } from "./pid-namespace.js";
import {
  preparePrivateIO,
  openPrivateIO,
  claimPrivateIO,
  publishPrivateStop,
  readPrivateStop,
} from "./private-io-files.js";

/** Assembled by trusted kernel adapters, never accepted from an orchestrator action. */
const LaunchSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().startsWith("/"),
  env: z.record(z.string(), z.string()),
  extraInput: z.string().nullable(),
});
export type CommandLaunch = z.infer<typeof LaunchSchema>;
const RequestSchema = z
  .strictObject({ intent: CommandLifetimeSchema, launch: LaunchSchema })
  .refine(
    ({ intent, launch }) => intent.launchDigest === digestJson(launch),
    "Command launch differs from its admitted digest",
  );
// Always run the packaged compiled supervisor, including when tests load controller TS modules.
// This fixed package-relative path is not a caller/model-selected executable or runtime fallback.
const entrypoint = fileURLToPath(
  new URL("../../dist/adapters/command-lifetime-cli.js", import.meta.url),
);
const rootFor = (workspace: string) => join(dirname(workspace), ".command-io");

export async function prepareCommandLifetime(
  scope: Pick<
    CommandLifetime,
    "runId" | "operationId" | "controllerLeaseId" | "scopeDigest" | "timeoutMs"
  >,
  launch: CommandLaunch,
) {
  // Sibling control storage is outside every mount of the command's workspace.
  const directory = await preparePrivateIO(rootFor(launch.cwd));
  return CommandLifetimeSchema.parse({
    ...scope,
    directory,
    ioId: randomUUID(),
    launchDigest: digestJson(launch),
  });
}

async function openCommandIO(intent: CommandLifetime) {
  if (!dirname(intent.directory.path).endsWith("/.command-io"))
    throw new Error("Command stop storage is not a registered private command root");
  return openPrivateIO(intent.directory, dirname(intent.directory.path));
}
async function writeStop(
  directory: FileHandle,
  intent: CommandLifetime,
  outcome: Pick<CommandStop, "kind" | "code" | "reason" | "error">,
) {
  const receipt = CommandStopSchema.parse({
    ioId: intent.ioId,
    bindingDigest: digestJson(intent),
    stoppedAt: new Date().toISOString(),
    ...outcome,
  });
  await publishPrivateStop(directory, receipt);
  return receipt;
}
export async function readCommandStop(intent: CommandLifetime): Promise<CommandStop | null> {
  const directory = await openCommandIO(intent);
  try {
    const raw = await readPrivateStop(directory);
    if (raw === null) return null;
    const receipt = CommandStopSchema.parse(raw);
    assertCommandStop(intent, receipt);
    return receipt;
  } finally {
    await directory.close();
  }
}
/** Only an unused exclusive gate or the original supervisor's exact receipt is proof. */
export async function recoverCommandStop(intent: CommandLifetime): Promise<CommandStop | null> {
  const existing = await readCommandStop(intent);
  if (existing) return existing;
  const directory = await openCommandIO(intent);
  try {
    if (!(await claimPrivateIO(directory, { ioId: intent.ioId, prevented: true })))
      return readCommandStop(intent);
    return await writeStop(directory, intent, {
      kind: "not_started",
      code: null,
      reason: "cancelled",
      error: null,
    });
  } finally {
    await directory.close();
  }
}

/** Fixed trusted supervisor outlives the controller; there is no saved-PID signalling. */
export function startDurableCommand(intent: CommandLifetime, launch: CommandLaunch) {
  const request = RequestSchema.parse({ intent, launch });
  const child = spawn(process.execPath, [entrypoint], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    detached: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    shell: false,
  });
  const control = child.stdio[3] as Writable;
  control.on("error", () => {});
  child.stdin!.on("error", () => {});
  child.stdin!.end(JSON.stringify(request));
  let failure: Error | undefined;
  child.once("error", (error) => {
    failure = error;
  });
  const result = new Promise<{
    receipt: CommandStop;
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("close", (code, signal) => {
      control.destroy();
      void (async () => {
        const receipt = await recoverCommandStop(intent);
        if (!receipt)
          throw new NamespaceStopUnprovenError(
            "Command supervisor has no independent namespace-stop receipt",
          );
        // A retained receipt proves stop, not successful delivery of output to this caller.
        if (failure || signal || code !== 0)
          throw new Error(
            "Command supervisor failed; retained stop is not a passing validation result",
          );
        resolve({ receipt, code: receipt.code, signal: null });
      })().catch((error) =>
        reject(
          error instanceof NamespaceStopUnprovenError
            ? error
            : // Receipt I/O failure also leaves stop unproven to this caller. Conservatively retain exclusion.
              new NamespaceStopUnprovenError(String(error)),
        ),
      );
    });
  });
  return { child, result, interrupt: () => control.end() };
}

/** CLI entrypoint only, outside all repository mounts. */
export async function superviseCommand() {
  let reason: "cancelled" | "timed_out" | null = null;
  const abort = new AbortController();
  const stop = () => {
    reason ??= "cancelled";
    abort.abort();
  };
  const control = new Socket({ fd: 3, readable: true, writable: false });
  control.on("end", stop);
  control.on("error", stop);
  control.resume();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.stdout.on("error", stop);
  process.stderr.on("error", stop);
  try {
    let data = "";
    for await (const chunk of process.stdin) {
      data += chunk.toString();
      if (Buffer.byteLength(data) > 1_048_576)
        throw new Error("Command supervisor request exceeded its bound");
    }
    const { intent, launch } = RequestSchema.parse(JSON.parse(data));
    if (dirname(intent.directory.path) !== rootFor(launch.cwd))
      throw new Error("Command control storage differs from its admitted workspace");
    const directory = await openCommandIO(intent);
    try {
      if (!(await claimPrivateIO(directory, { ioId: intent.ioId, prevented: false })))
        throw new Error("Command dispatch gate is already owned");
      if (abort.signal.aborted) {
        await writeStop(directory, intent, {
          kind: "not_started",
          code: null,
          reason,
          error: null,
        });
        return;
      }
      const namespace = startNamespaceProcess(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio: "pipe",
        timeoutMs: intent.timeoutMs,
        ...(launch.extraInput === null ? {} : { extraInput: launch.extraInput }),
      });
      const interrupt = () => {
        namespace.interrupt();
        // Broken parent output must not prevent the supervisor draining/reaping its namespace.
        if (process.stdout.destroyed) {
          namespace.child.stdout!.unpipe();
          namespace.child.stdout!.resume();
        }
        if (process.stderr.destroyed) {
          namespace.child.stderr!.unpipe();
          namespace.child.stderr!.resume();
        }
      };
      abort.signal.addEventListener("abort", interrupt, { once: true });
      process.stdout.on("error", interrupt);
      process.stderr.on("error", interrupt);
      namespace.child.stdout!.pipe(process.stdout, { end: false });
      namespace.child.stderr!.pipe(process.stderr, { end: false });
      if (abort.signal.aborted) interrupt();
      const code = await new Promise<number | null>((resolve) =>
        namespace.child.once("close", resolve),
      );
      abort.signal.removeEventListener("abort", interrupt);
      process.stdout.off("error", interrupt);
      process.stderr.off("error", interrupt);
      const failure = namespace.failure();
      if (failure instanceof NamespaceStopUnprovenError) throw failure;
      // A late controller cancellation or delayed supervisor callback cannot
      // overwrite the guardian's independently observed exit/deadline cause.
      const completion = failure ? null : namespace.completion();
      await writeStop(directory, intent, {
        kind: "stopped",
        code: failure ? null : code,
        reason: completion?.reason ?? null,
        error: failure ? redactSensitiveText(failure.message, 4000) : null,
      });
    } finally {
      await directory.close();
    }
  } finally {
    control.destroy();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
