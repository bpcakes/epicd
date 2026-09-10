import { projectAccountAccessToken } from "./accounts.js";
import { readOwnerFile } from "./codex-credentials.js";
export { readCodexAccessToken } from "./codex-credentials.js";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { z } from "zod";
import { codexConfinementConfig } from "./codex-confinement.js";
import { REVIEW_PACKET_PATH, reviewPacketBinding } from "../domain/review-packet.js";
import { digestJson } from "../domain/repository-policy.js";
import {
  CodexLaunchSchema,
  CodexLaunchStopSchema,
  LaunchPathSchema as PathSchema,
  type CodexLaunch,
  type CodexLaunchStop,
} from "../domain/codex-launch.js";
export {
  CodexLaunchSchema,
  CodexLaunchStopSchema,
  type CodexLaunch,
  type CodexLaunchStop,
} from "../domain/codex-launch.js";

export const CodexLaunchObservationSchema = z.strictObject({
  generation: z.string().uuid(),
  state: z.enum(["preparing", "running", "stopping"]),
});

/** Only the trusted supervisor's exact-generation file proves termination. Missing is unknown. */
export async function readCodexLaunchStop(input: CodexLaunch): Promise<CodexLaunchStop | null> {
  const launch = CodexLaunchSchema.parse(input);
  await privateDirectory(launch.controlDirectory);
  const spec = launch.confinement;
  for (const path of [
    spec.executable,
    spec.workspace,
    spec.providerHome,
    spec.scratch,
    spec.artifacts,
  ]) {
    if (overlap(path, launch.controlDirectory))
      throw new Error("Launch control must be outside agent storage");
  }
  let contents: string;
  try {
    contents = await readOwnerFile(join(launch.controlDirectory, "stopped.json"), 2048);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const receipt = CodexLaunchStopSchema.parse(JSON.parse(contents));
  if (receipt.generation !== launch.generation)
    throw new Error("Codex stop receipt generation changed");
  return receipt;
}

/** Atomically defeats a launch that has not claimed its start gate. Existing owners are never replaced. */
export async function preventCodexLaunchStart(input: CodexLaunch): Promise<boolean> {
  const launch = CodexLaunchSchema.parse(input);
  await privateDirectory(launch.controlDirectory);
  try {
    await writeFile(
      join(launch.controlDirectory, "started.json"),
      JSON.stringify({
        generation: launch.generation,
        startedAt: new Date().toISOString(),
        prevented: true,
      }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
  await writeCodexLaunchStop(launch, {
    kind: "not_started",
    code: null,
    signal: null,
    interrupted: true,
  });
  return true;
}

/** Supervisor/reconciler only. Call after observed process closure or an exclusive never-start gate. */
export async function writeCodexLaunchStop(
  launch: CodexLaunch,
  outcome: Pick<CodexLaunchStop, "kind" | "code" | "signal" | "interrupted">,
) {
  const receipt = CodexLaunchStopSchema.parse({
    generation: launch.generation,
    stoppedAt: new Date().toISOString(),
    ...outcome,
    processTreeStopped: true,
  });
  const target = join(launch.controlDirectory, "stopped.json");
  const temporary = `${target}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(receipt));
    await file.sync();
  } finally {
    await file.close();
  }
  // Each generation has exactly one start-gate owner and one terminal write.
  await rename(temporary, target);
  const directory = await open(launch.controlDirectory, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function controlCodexLaunch(launch: CodexLaunch, operation: "inspect" | "interrupt") {
  await privateDirectory(launch.controlDirectory);
  const directory = await open(
    launch.controlDirectory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    return await new Promise<z.infer<typeof CodexLaunchObservationSchema>>(
      (resolveResult, reject) => {
        // Linux resolves the held directory FD before lookup, avoiding AF_UNIX's
        // pathname length limit without moving authority to a global abstract socket.
        const socket = connect(`/proc/self/fd/${directory.fd}/control.sock`);
        let data = "";
        let done = false;
        const finish = (error?: Error) => {
          if (done) return;
          done = true;
          socket.destroy();
          if (error) {
            reject(error);
            return;
          }
          try {
            const observation = CodexLaunchObservationSchema.parse(JSON.parse(data));
            if (observation.generation !== launch.generation)
              throw new Error("Codex launch generation changed");
            resolveResult(observation);
          } catch (error) {
            reject(error);
          }
        };
        socket.setTimeout(2000, () =>
          finish(new Error("Codex launch control timed out; stop state is unknown")),
        );
        socket.once("error", (error) => finish(error));
        socket.once("connect", () =>
          socket.end(JSON.stringify({ generation: launch.generation, operation }) + "\n"),
        );
        socket.on("data", (chunk: Buffer) => {
          data += chunk.toString("utf8");
          if (data.length > 1024)
            finish(new Error("Codex launch control exceeded its response bound"));
        });
        socket.once("end", () => finish());
      },
    );
  } finally {
    await directory.close();
  }
}

/** One launcher per invocation; resuming a conversation uses a fresh launcher. */
export async function createCodexLauncher(
  input: Omit<CodexLaunch, "generation">,
  entrypoint = fileURLToPath(new URL("codex-launch-cli.js", import.meta.url)),
): Promise<{ executable: string; manifestPath: string; launch: CodexLaunch }> {
  const launch = CodexLaunchSchema.parse({ ...input, generation: randomUUID() });
  return materializeCodexLauncher(launch, entrypoint);
}

/** Materialize a kernel-reserved manifest. Repeated calls never overwrite a launch. */
export async function materializeCodexLauncher(
  input: CodexLaunch,
  entrypoint = fileURLToPath(new URL("codex-launch-cli.js", import.meta.url)),
): Promise<{ executable: string; manifestPath: string; launch: CodexLaunch }> {
  const launch = CodexLaunchSchema.parse(input);
  const spec = launch.confinement;
  await privateDirectory(launch.controlDirectory);
  for (const path of [spec.workspace, spec.providerHome, spec.scratch, spec.artifacts]) {
    if (overlap(path, launch.controlDirectory))
      throw new Error("Launch control must be outside agent storage");
  }
  for (const path of [entrypoint, await realpath(process.execPath)]) {
    if (!(await lstat(path)).isFile() || (await realpath(path)) !== path)
      throw new Error(
        "Codex launcher requires a canonical compiled entrypoint and Node executable",
      );
  }
  const manifestPath = join(launch.controlDirectory, "launch.json");
  await writeFile(manifestPath, JSON.stringify(launch), { flag: "wx", mode: 0o600 });
  const executable = join(launch.controlDirectory, "codex");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    executable,
    // Herdr's documented wrapper hint selects Codex screen detection without
    // pretending to be a lifecycle hook or exposing its control socket inside.
    `#!/bin/sh\nHERDR_AGENT=codex exec ${quote(await realpath(process.execPath))} ${quote(entrypoint)} ${quote(manifestPath)} "$@"\n`,
    { flag: "wx", mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return { executable, manifestPath, launch };
}

/** Private token-only cache, never a second owner of the managed refresh credential. */
export async function prepareCodexAccessToken(launch: CodexLaunch, signal?: AbortSignal) {
  if (!launch.authCachePath) return;
  await projectAccountAccessToken(
    launch.authCachePath,
    launch.confinement.providerHome,
    launch.generation,
    launch.accountBinding?.source,
    signal,
  );
}

/** Exact private file, not an arbitrary caller-selected mount. Check again before recording stop. */
export async function verifyCodexReviewPacket(launch: CodexLaunch) {
  if (launch.reviewPacket === null) return;
  const path = join(launch.controlDirectory, "review-evidence.json");
  await privateDirectory(launch.controlDirectory);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o400 ||
      info.size !== launch.reviewPacket.byteLength ||
      (await realpath(path)) !== path
    )
      throw new Error("Review packet must be an exact private read-only file");
    const content = await file.readFile("utf8");
    if (digestJson(reviewPacketBinding(content)) !== digestJson(launch.reviewPacket))
      throw new Error("Review packet content differs from the reserved launch");
    return content;
  } finally {
    await file.close();
  }
}

/**
 * Build the real outer Codex process boundary. Only Codex's model connection shares
 * the network; its local tools must use the nested no-network permission profile.
 * This is not a complete adaptive admission proof or a generic host-command runner.
 */
export async function codexLaunchCommand(launchInput: CodexLaunch, argv: readonly string[]) {
  if (process.platform !== "linux") throw new Error("Confined Codex launch requires Linux");
  const launch = CodexLaunchSchema.parse(launchInput);
  const spec = launch.confinement;
  const config = codexConfinementConfig(spec);
  const packet = await verifyCodexReviewPacket(launch);
  for (const path of [spec.workspace, spec.providerHome, spec.scratch, spec.artifacts]) {
    if (overlap(path, launch.controlDirectory))
      throw new Error("Launch control must be outside agent storage");
    if (launch.authCachePath && overlap(path, launch.authCachePath))
      throw new Error("The managed auth cache must remain outside agent storage");
  }
  await canonicalFile(join(spec.providerHome, "config.toml"));
  if ((await readFile(join(spec.providerHome, "config.toml"), "utf8")) !== config)
    throw new Error("Private Codex configuration changed before launch");
  for (const path of [
    spec.workspace,
    spec.providerHome,
    spec.scratch,
    spec.artifacts,
    launch.controlDirectory,
  ])
    await privateDirectory(path);
  await rejectSharedFiles(spec.workspace);
  const args = [...argv];
  const inputs: string[] = [];
  validateCodexArguments(launch, args, inputs);
  const mounts = [
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
  ];
  for (const path of [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc/ld.so.cache",
    "/etc/localtime",
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
    "/etc/ssl/certs",
  ]) {
    if (await exists(path)) mounts.push("--ro-bind", path, path);
  }
  // Preserve mandatory system requirements. Do not silently omit or inherit an
  // uninspected system config that can introduce external tools and credentials.
  for (const path of ["/etc/codex/config.toml", "/etc/codex/managed_config.toml"]) {
    if (await exists(path))
      throw new Error(`System Codex configuration requires explicit launch admission: ${path}`);
  }
  if (await exists("/etc/codex/requirements.toml"))
    mounts.push("--ro-bind", "/etc/codex/requirements.toml", "/etc/codex/requirements.toml");
  const nativeDirectory = dirname(spec.executable);
  await canonicalFile(spec.executable);
  mounts.push("--ro-bind", spec.executable, spec.executable);
  const toolHost = join(nativeDirectory, "codex-code-mode-host");
  await canonicalFile(toolHost);
  mounts.push("--ro-bind", toolHost, toolHost);
  const resources = join(dirname(nativeDirectory), "codex-resources");
  if (await exists(resources)) mounts.push("--ro-bind", resources, resources);
  mounts.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    spec.sourceMode === "read-only" ? "--ro-bind" : "--bind",
    spec.workspace,
    spec.workspace,
  );
  for (const path of [spec.providerHome, spec.scratch, spec.artifacts])
    mounts.push("--bind", path, path);
  // The provider can persist its conversation, but cannot replace its launch policy.
  mounts.push(
    "--ro-bind",
    join(spec.providerHome, "config.toml"),
    join(spec.providerHome, "config.toml"),
  );
  for (const name of [".git", ".beads", ".epicd", ".codex", "AGENTS.md"]) {
    const path = join(spec.workspace, name);
    if (await exists(path)) {
      if ((await realpath(path)) !== path)
        throw new Error(`Protected source path is aliased: ${name}`);
      mounts.push("--ro-bind", path, path);
    }
  }
  for (const path of inputs) {
    await canonicalFile(path);
    mounts.push("--ro-bind", path, path);
  }
  for (let index = 0; index < mounts.length; index += 1) {
    if (mounts[index] !== "--bind" && mounts[index] !== "--ro-bind") continue;
    const path = mounts[index + 1]!;
    if (
      overlap(path, launch.controlDirectory) ||
      (launch.authCachePath && overlap(path, launch.authCachePath)) ||
      (launch.accountBinding && overlap(path, launch.accountBinding.source.codexHome))
    )
      throw new Error("A runtime mount would expose launch control or the managed auth cache");
    index += 2;
  }
  if (launch.reviewPacket !== null) {
    const path = join(launch.controlDirectory, "review-evidence.json");
    if (launch.authCachePath && overlap(path, launch.authCachePath))
      throw new Error("A review packet must not expose the managed auth cache");
    if (
      [launch.controlDirectory, launch.authCachePath].some(
        (entry) => entry && overlap(entry, REVIEW_PACKET_PATH),
      )
    )
      throw new Error("Review packet target overlaps private launch storage");
    // Copy the verified bytes over the guardian's private input descriptor. The
    // mount never follows a mutable host pathname after the integrity check.
    mounts.push("--ro-bind-data", "3", REVIEW_PACKET_PATH);
  }
  mounts.push("--chdir", spec.workspace, "--", spec.executable, ...args);
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: spec.providerHome,
    CODEX_HOME: spec.providerHome,
    TMPDIR: spec.scratch,
    LANG: "C.UTF-8",
    TERM: process.env.TERM ?? "xterm-256color",
  };
  // Authentication is a private token-only cache, not argv or environment output.
  return { command: "/usr/bin/bwrap", args: mounts, env, cwd: spec.workspace, extraInput: packet };
}

/** Reject transport flags that would override the frozen policy or switch provider. */
export function validateCodexArguments(
  launch: CodexLaunch,
  args: string[],
  inputs: string[] = [],
): void {
  let index = args[0] === "exec" ? 1 : 0;
  const native = index === 0;
  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    if (
      [
        "--experimental-json",
        "--json",
        "--no-alt-screen",
        "--skip-git-repo-check",
        "--version",
      ].includes(arg)
    )
      continue;
    if (arg === "resume") {
      if (!z.uuid().safeParse(args[++index]).success)
        throw new Error("An exact Codex session ID is required");
      continue;
    }
    const value = args[++index];
    if (value === undefined) throw new Error("Incomplete confined Codex argument");
    if (arg === "--model" && value === launch.model) continue;
    if (arg === "--cd" && value === launch.confinement.workspace) continue;
    if (arg === "--thread-source" && /^epicd-[a-z_-]+$/.test(value)) continue;
    if (
      arg === "--config" &&
      [
        `model_reasoning_effort=${JSON.stringify(launch.reasoningEffort)}`,
        'approval_policy="never"',
        'web_search="disabled"',
      ].includes(value)
    )
      continue;
    if (arg === "--output-schema" && !native && PathSchema.safeParse(value).success) {
      inputs.push(value);
      continue;
    }
    throw new Error(`Unsupported confined Codex argument: ${arg}`);
  }
  const pinned: string[] = [];
  if (!args.includes("--model")) pinned.push("--model", launch.model);
  if (!args.includes("--cd")) pinned.push("--cd", launch.confinement.workspace);
  if (!args.includes(`model_reasoning_effort=${JSON.stringify(launch.reasoningEffort)}`))
    pinned.push("--config", `model_reasoning_effort=${JSON.stringify(launch.reasoningEffort)}`);
  args.splice(native ? 0 : 1, 0, ...pinned);
}

async function privateDirectory(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    (await realpath(path)) !== path ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Codex launch directories must be canonical and owner-only");
}
async function canonicalFile(path: string) {
  if (!(await lstat(path)).isFile() || (await realpath(path)) !== path)
    throw new Error("Codex launch inputs must be canonical regular files");
}
async function rejectSharedFiles(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isDirectory()) await rejectSharedFiles(path);
    else if (stat.isFile() && stat.nlink > 1)
      throw new Error("Codex workspace contains a hard-linked file");
  }
}
function overlap(a: string, b: string) {
  const within = (root: string, path: string) => {
    const rel = relative(root, path);
    return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
  };
  return within(a, b) || within(b, a);
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
