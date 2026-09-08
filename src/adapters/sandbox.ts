import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { redactSensitiveText } from "../util/redact.js";
import { NamespaceStopUnprovenError, startNamespaceProcess } from "./pid-namespace.js";
import {
  prepareCommandLifetime,
  startDurableCommand,
  type CommandLaunch,
} from "./command-lifetime.js";
import type { CommandLifetime } from "../domain/command-lifetime.js";
import {
  fixtureBridgeArguments,
  fixtureBridgeEnvironment,
  fixtureBridgeTransport,
  verifyFixtureBridgeTransport,
  type FixtureBridgeTransport,
} from "./fixture-bridge.js";

const OUTPUT_LIMIT = 64 * 1024;
const PROTECTED_PATHS = [".git", ".beads", ".epicd", ".codex", "AGENTS.md"];

export type ConfinedCommand = {
  workspace: string;
  sourceMode: "read-only" | "workspace-write";
  writablePaths?: readonly string[];
  /** Complete candidate source manifest, supplied by the kernel when scratch is writable. */
  immutablePaths?: readonly string[];
  cwd?: string;
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** Minimal private passwd entry for check-local services; never mounts host account files. */
  syntheticUser?: true;
};

export type ConfinedCommandResult = {
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  startedAt: string;
  endedAt: string;
  /** This admitted PID namespace only; never proves stop of an external database backend. */
  processTreeStopped: true;
};

export type ConfinedCommandHandle = {
  result: Promise<ConfinedCommandResult>;
  interrupt(): void;
};

/**
 * Linux outer sandbox for repository commands, independent of model cooperation.
 * No home, state, host network, host /proc, or writable system mount is exposed.
 * An optional controller-supplied fixture bridge exposes only its private TCP endpoint,
 * never the raw service socket or broker's mounts/processes.
 * Callers supply a registered private workspace and frozen policy, never an agent path.
 */
export async function startConfinedCommand(
  request: ConfinedCommand,
  options: {
    signal?: AbortSignal;
    bwrapPath?: string;
    beforeSpawn?: () => void | Promise<void>;
    /** Controller-only transport. Does not confer fixture authority or remote stop proof. */
    fixtureBridge?: FixtureBridgeTransport;
    /** Kernel-only durable local-stop protocol; admission persists the exact launch before dispatch. */
    durableStop?: {
      runId: string;
      operationId: string;
      controllerLeaseId: string;
      scopeDigest: string;
      admit(intent: CommandLifetime): void | Promise<void>;
    };
  } = {},
): Promise<ConfinedCommandHandle> {
  if (process.platform !== "linux") throw new Error("Adaptive command confinement requires Linux");
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new Error("A positive bounded command timeout is required");
  }
  if (!request.command || request.command.includes("\0")) throw new Error("Invalid command");
  // Own inputs before filesystem admission yields to caller code.
  const spec = structuredClone(request);
  const bridge = options.fixtureBridge && fixtureBridgeTransport(options.fixtureBridge);
  if (bridge) {
    if (spec.sourceMode !== "read-only")
      throw new Error("Fixture bridges require read-only validation source");
    if (spec.env && bridge.connectionVariable in spec.env)
      throw new Error("Fixture bridge connection variable collides with command environment");
    spec.syntheticUser = true;
    await verifyFixtureBridgeTransport(bridge);
  }
  if (spec.syntheticUser && (!process.getuid || !process.getgid || process.getuid() === 0))
    throw new Error("Check-local PostgreSQL requires a non-root validation user");
  const workspace = resolve(spec.workspace);
  await canonicalDirectory(workspace);
  await rejectSharedFiles(workspace);
  if (
    spec.sourceMode === "read-only" &&
    spec.writablePaths?.length &&
    !spec.immutablePaths?.length
  ) {
    throw new Error("Writable review scratch requires the candidate source manifest");
  }
  const cwd = spec.cwd === undefined || spec.cwd === "." ? "" : relativePath(spec.cwd);
  if (cwd) await canonicalDirectory(join(workspace, cwd));

  const systemArgs = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/usr",
    "/usr",
  ];
  // Preserve the host's loader layout, including non-usrmerged distributions.
  for (const path of ["/bin", "/sbin", "/lib", "/lib64"]) {
    if (await exists(path)) systemArgs.push("--ro-bind", path, path);
  }
  for (const path of ["/etc/ld.so.cache", "/etc/localtime"]) {
    if (await exists(path)) systemArgs.push("--ro-bind", path, path);
  }
  const mounts = [
    {
      flag: spec.sourceMode === "read-only" ? "--ro-bind" : "--bind",
      source: workspace,
      target: "/workspace",
    },
  ];
  for (const path of PROTECTED_PATHS) {
    const source = join(workspace, path);
    if (await exists(source)) {
      if ((await realpath(source)) !== source)
        throw new Error(`Protected path is a symlink: ${path}`);
      mounts.push({ flag: "--ro-bind", source, target: `/workspace/${path}` });
    }
  }
  for (const path of spec.writablePaths ?? []) {
    const relative = relativePath(path);
    if (PROTECTED_PATHS.some((protectedPath) => relative.split("/").includes(protectedPath))) {
      throw new Error(`Scratch path overlaps protected source: ${path}`);
    }
    if (
      spec.immutablePaths?.some((entry) => {
        const sourcePath = relativePath(entry);
        return sourcePath === relative || sourcePath.startsWith(`${relative}/`);
      })
    ) {
      throw new Error(`Scratch path overlaps candidate source: ${path}`);
    }
    const source = join(workspace, relative);
    await canonicalDirectory(source);
    mounts.push({ flag: "--bind", source, target: `/workspace/${relative}` });
  }
  let args = [
    ...systemArgs,
    ...(bridge ? ["--share-net"] : []),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/tmp/epicd-home",
    ...mounts.flatMap(({ flag, source, target }) => [flag, bridge ? target : source, target]),
  ];
  if (spec.syntheticUser) args.push("--ro-bind-data", "3", "/etc/passwd");
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/epicd-home",
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    ...spec.env,
    ...(bridge ? fixtureBridgeEnvironment(bridge) : {}),
  };
  args.push("--clearenv");
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) {
      throw new Error("Invalid declared environment binding");
    }
    args.push("--setenv", key, value);
  }
  args.push("--chdir", cwd ? `/workspace/${cwd}` : "/workspace", "--", spec.command, ...spec.args);
  if (bridge) {
    args = fixtureBridgeArguments(
      bridge,
      systemArgs,
      mounts.flatMap(({ flag, source, target }) => [flag, source, target]),
      args,
    );
    await verifyFixtureBridgeTransport(bridge);
  }
  options.signal?.throwIfAborted();

  const startedAt = new Date().toISOString();
  const launch: CommandLaunch = {
    command: options.bwrapPath ?? "bwrap",
    args,
    cwd: workspace,
    env: { PATH: "/usr/bin:/bin" },
    extraInput: spec.syntheticUser
      ? `epicd:x:${process.getuid!()}:${process.getgid!()}::/tmp/epicd-home:/bin/sh\n`
      : null,
  };
  const lifetime = options.durableStop
    ? await prepareCommandLifetime(
        {
          runId: options.durableStop.runId,
          operationId: options.durableStop.operationId,
          controllerLeaseId: options.durableStop.controllerLeaseId,
          scopeDigest: options.durableStop.scopeDigest,
          timeoutMs: spec.timeoutMs,
        },
        launch,
      )
    : null;
  // The trusted caller rechecks its lease/action after asynchronous filesystem admission.
  if (options.beforeSpawn) await options.beforeSpawn();
  if (lifetime) await options.durableStop!.admit(lifetime);
  options.signal?.throwIfAborted();
  const durable = lifetime ? startDurableCommand(lifetime, launch) : null;
  const namespace =
    durable ??
    startNamespaceProcess(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: "pipe",
      ...(launch.extraInput === null ? {} : { extraInput: launch.extraInput }),
    });
  const { child } = namespace;
  let terminal = false;
  let stoppedFor: "cancelled" | "timed_out" | undefined;
  const stdout = new BoundedOutput();
  const stderr = new BoundedOutput();
  child.stdout!.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr!.on("data", (chunk: Buffer) => stderr.append(chunk));
  child.once("exit", () => {
    terminal = true;
  });

  const stop = (reason: "cancelled" | "timed_out") => {
    if (terminal || stoppedFor) return;
    stoppedFor = reason;
    namespace.interrupt();
  };
  const abort = () => stop("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const deadline = setTimeout(() => stop("timed_out"), spec.timeoutMs);
  const result = new Promise<ConfinedCommandResult>((resolveResult, reject) => {
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
      void (async () => {
        if (durable) {
          const stopped = await durable.result;
          code = stopped.code;
          signal = stopped.signal;
          stoppedFor ??= stopped.receipt.reason ?? undefined;
          if (stopped.receipt.error)
            throw new Error(`Confined command could not start: ${stopped.receipt.error}`);
          if (stopped.receipt.kind === "not_started") stoppedFor ??= "cancelled";
        } else if ("failure" in namespace) {
          const spawnError = namespace.failure();
          if (spawnError)
            throw spawnError instanceof NamespaceStopUnprovenError
              ? spawnError
              : new Error(`Confined command could not start: ${spawnError.message}`);
        }
        resolveResult({
          status: stoppedFor ?? (code === 0 ? "succeeded" : "failed"),
          exitCode: code,
          signal,
          stdout: stdout.text(),
          stderr: stderr.text(),
          outputTruncated: stdout.truncated || stderr.truncated,
          startedAt,
          endedAt: new Date().toISOString(),
          processTreeStopped: true,
        });
      })().catch(reject);
    });
  });
  // The durable promise may reject before the close listener above resumes.
  void durable?.result.catch(() => {});
  return { result, interrupt: abort };
}

class BoundedOutput {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private size = 0;

  append(chunk: Buffer): void {
    this.size += chunk.length;
    const headRoom = OUTPUT_LIMIT / 2 - this.head.length;
    if (headRoom > 0) this.head = Buffer.concat([this.head, chunk.subarray(0, headRoom)]);
    const remaining = chunk.subarray(Math.max(0, headRoom));
    this.tail = Buffer.concat([this.tail, remaining]).subarray(-OUTPUT_LIMIT / 2);
  }

  get truncated(): boolean {
    return this.size > OUTPUT_LIMIT;
  }

  text(): string {
    const separator = this.truncated ? "\n[output omitted]\n" : "";
    return redactSensitiveText(
      this.head.toString("utf8") + separator + this.tail.toString("utf8"),
      OUTPUT_LIMIT + 100,
    );
  }
}

function relativePath(path: string): string {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Expected a bounded relative workspace path: ${path}`);
  }
  return path;
}

async function canonicalDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path) {
    throw new Error("Workspace and scratch directories must be canonical, not symlinks");
  }
}

async function rejectSharedFiles(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isDirectory()) await rejectSharedFiles(path);
    else if (stat.isFile() && stat.nlink > 1) {
      throw new Error("A confined workspace cannot contain hard-linked files");
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
