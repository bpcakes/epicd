import { randomUUID } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { KernelGit } from "./adapters/kernel-git.js";
import { PublicationGit } from "./adapters/publication-git.js";
import { KernelBeads } from "./adapters/kernel-beads.js";
import { StateStore } from "./adapters/store.js";
import { resolveCodexModel, verifyCodexExecutable } from "./adapters/codex-settings.js";
import { RepositoryPolicySchema } from "./domain/repository-policy.js";
import {
  DEFAULT_AGENT_PREFERENCES,
  RUN_STATE_SCHEMA_VERSION,
  RunStateSchema,
  RuntimeConfigurationSchema,
  type RunState,
  type RuntimeKind,
} from "./domain/types.js";
import { runCommand } from "./util/command.js";
import { assertRuntimeHandoffReady } from "./adapters/runtime-handoff.js";
import { RuntimeHandoffTargetSchema } from "./domain/runtime-handoff.js";
import { RepositoryAdmission } from "./kernel/repository-admission.js";

export async function resolveExecutable(value: string): Promise<string> {
  if (!value.trim()) throw new Error("Executable cannot be empty");
  const candidates =
    isAbsolute(value) || value.includes("/")
      ? [resolve(value)]
      : (process.env.PATH ?? "")
          .split(":")
          .filter(Boolean)
          .map((path) => join(path, value));
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      await access(path, constants.X_OK);
      return path;
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
  throw new Error(`Executable unavailable: ${value}`);
}

export async function sdkNativeExecutable(): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Controlled runtime admission currently requires Linux x64");
  const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const manifest = sdkRequire.resolve("@openai/codex-linux-x64/package.json");
  return resolveExecutable(join(dirname(manifest), "vendor/x86_64-unknown-linux-musl/bin/codex"));
}

/** Resolve the selected installation's current npm launcher to its native payload.
 * Never execute the JavaScript shim inside confinement or substitute the SDK's
 * installation when the selected installation is incomplete.
 */
export async function selectedCodexExecutable(
  runtime: RuntimeKind,
  override?: string,
): Promise<string> {
  if (!override && runtime === "sdk") return sdkNativeExecutable();
  const entry = await resolveExecutable(override ?? "codex");
  if (basename(entry) !== "codex.js") return entry;
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Controlled runtime admission currently requires Linux x64");
  const manifestPath = join(dirname(entry), "..", "package.json");
  const manifest = z
    .object({
      name: z.literal("@openai/codex"),
      bin: z.object({ codex: z.literal("bin/codex.js") }),
    })
    .safeParse(JSON.parse(await readFile(manifestPath, "utf8")));
  if (!manifest.success || dirname(entry).split("/").at(-1) !== "bin")
    throw new Error("Select a native Codex binary or its supported npm entrypoint");
  let nativeManifest: string;
  try {
    nativeManifest = createRequire(entry).resolve("@openai/codex-linux-x64/package.json");
  } catch (error) {
    throw new Error(
      "The selected Codex installation has no native Linux x64 dependency; no installation fallback was attempted",
      { cause: error },
    );
  }
  return resolveExecutable(
    join(dirname(nativeManifest), "vendor/x86_64-unknown-linux-musl/bin/codex"),
  );
}

/** Read-only caller discovery. Never infer a workspace from focus or create a session here. */
export async function discoverHerdr(executable: string, cwd: string) {
  if (process.env.HERDR_ENV !== "1")
    throw new Error("Native Herdr requires a Herdr-managed caller (HERDR_ENV=1)");
  const read = async (args: string[]) =>
    (await runCommand(executable, args, { cwd, timeoutMs: 10_000 })).stdout;
  const status = await read(["status", "server"]);
  const socket = /^socket:\s*(.+)$/m.exec(status)?.[1]?.trim();
  if (!socket || !/^compatible:\s*yes\s*$/m.test(status))
    throw new Error("Herdr server endpoint or protocol compatibility could not be verified");
  const sessions = z
    .object({
      sessions: z.array(
        z.object({
          name: z.string(),
          running: z.boolean(),
          socket_path: z.string(),
        }),
      ),
    })
    .parse(JSON.parse(await read(["session", "list", "--json"]))).sessions;
  const matching = sessions.filter((session) => session.running && session.socket_path === socket);
  if (matching.length !== 1)
    throw new Error("Cannot identify the caller's exact named Herdr session");
  const pane = z
    .object({ result: z.object({ pane: z.object({ workspace_id: z.string().min(1) }) }) })
    .parse(JSON.parse(await read(["pane", "current", "--current"])));
  return { executable, sessionName: matching[0]!.name, workspaceId: pane.result.pane.workspace_id };
}

export type CreateRunOptions = {
  repoPath: string;
  epicId: string;
  runtime: RuntimeKind;
  codexPath?: string;
  trackerPath?: string;
  herdrPath?: string;
  model?: string;
  reasoningEffort?: RunState["reasoningEffort"];
  agentSettings?: RunState["agentSettings"];
  authCachePath?: string | null;
  turnTimeoutMs?: number;
};

/** Explicit operator choice. Preflight is read-only; no model, pane, prompt or service is started. */
export async function handoffRuntime(
  store: StateStore,
  runId: string,
  options: { runtime: RuntimeKind; controlVersion: number; codexPath?: string; herdrPath?: string },
  signal?: AbortSignal,
) {
  const lease = store.acquireLease(runId);
  const authority = { runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
  try {
    const journal = store.orchestration;
    assertRuntimeHandoffReady(journal, authority, options.controlVersion);
    const state = store.get(runId)!;
    if (!state.runtimeConfiguration) throw new Error("Run has no runtime configuration");
    signal?.throwIfAborted();
    const executable = await selectedCodexExecutable(options.runtime, options.codexPath);
    await verifyCodexExecutable(state.repoPath, { executablePath: executable, args: [] });
    const herdr =
      options.runtime === "herdr"
        ? await discoverHerdr(await resolveExecutable(options.herdrPath ?? "herdr"), state.repoPath)
        : null;
    const target = RuntimeHandoffTargetSchema.parse({
      runtime: options.runtime,
      executable,
      herdr,
    });
    const repository = await new PublicationGit().bind(state.repoPath, signal);
    if (
      JSON.stringify(repository.commonDirectory) !==
      JSON.stringify(state.runtimeConfiguration.commonDirectory)
    )
      throw new Error("Repository metadata identity changed before runtime handoff");
    assertRuntimeHandoffReady(journal, authority, options.controlVersion);
    const admission = new RepositoryAdmission(store, authority, repository);
    await admission.enter(signal);
    await admission.assertOwned(signal);
    signal?.throwIfAborted();
    return journal.handoffRuntime(authority, options.controlVersion, target);
  } finally {
    store.releaseLease(runId, lease.ownerToken);
  }
}

export async function createRun(
  store: StateStore,
  options: CreateRunOptions,
  signal?: AbortSignal,
) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Controlled runtime admission currently requires Linux x64");
  signal?.throwIfAborted();
  const inputRoot = await realpath(resolve(options.repoPath));
  const repoPath = await realpath(
    (await new KernelGit(inputRoot).text(["rev-parse", "--show-toplevel"])).trim(),
  );
  const stateLocation = relative(repoPath, await realpath(resolve(store.path)));
  if (stateLocation === "" || (!stateLocation.startsWith("../") && !isAbsolute(stateLocation)))
    throw new Error(
      "Run state and private runtime storage must be outside the delivery repository",
    );
  const repository = await new PublicationGit().bind(repoPath, signal);
  const existing = store.inspectWorkflowOwner(repoPath, repository.commonDirectory);
  if (existing)
    throw new Error("This repository already has a run; inspect status and resume its run ID");
  const git = new KernelGit(repoPath);
  const revision = (await git.text(["rev-parse", "HEAD"])).trim();
  // Explicitly selected repository declaration, frozen once. Missing policy never means unrestricted execution.
  const policyPath = join(repoPath, ".epicd", "policy.json");
  const policy = RepositoryPolicySchema.parse(JSON.parse(await readFile(policyPath, "utf8")));
  const executable = await selectedCodexExecutable(options.runtime, options.codexPath);
  await verifyCodexExecutable(repoPath, { executablePath: executable, args: [] });
  const trackerExecutable = await resolveExecutable(options.trackerPath ?? "br");
  const tracker = new KernelBeads(trackerExecutable);
  const binding = await tracker.bind(repoPath);
  const graph = await tracker.graph(
    binding,
    options.epicId,
    () => signal?.throwIfAborted(),
    signal ?? new AbortController().signal,
  );
  const epic = graph.issues.find((issue) => issue.id === options.epicId);
  if (!epic || epic.type !== "epic" || epic.status === "closed" || epic.status === "tombstone")
    throw new Error("Select an open Beads epic");
  const herdr =
    options.runtime === "herdr"
      ? await discoverHerdr(await resolveExecutable(options.herdrPath ?? "herdr"), repoPath)
      : null;
  const model =
    options.model ??
    (await resolveCodexModel(repoPath, {
      executable: { executablePath: executable, args: [] },
      ...(signal ? { signal } : {}),
    }));
  const stateDirectory = await realpath(dirname(store.path));
  const privateRoot = join(stateDirectory, `${basename(store.path)}.resources`);
  const authCachePath =
    options.authCachePath === undefined
      ? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")
      : options.authCachePath;
  const configuration = RuntimeConfigurationSchema.parse({
    commonDirectory: repository.commonDirectory,
    executable,
    trackerExecutable,
    runtimeRoot: join(privateRoot, "runtimes"),
    workspaceRoot: join(privateRoot, "workspaces"),
    authCachePath: authCachePath === null ? null : await realpath(resolve(authCachePath)),
    turnTimeoutMs: options.turnTimeoutMs ?? 30 * 60_000,
    herdr,
  });
  const at = new Date().toISOString();
  const state = RunStateSchema.parse({
    stateSchemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId: randomUUID(),
    repoPath,
    epicId: epic.id,
    epicTitle: epic.title,
    epicBaseRevision: revision,
    model,
    reasoningEffort: options.reasoningEffort ?? null,
    runtime: options.runtime,
    agentSettings: options.agentSettings ?? structuredClone(DEFAULT_AGENT_PREFERENCES),
    runtimeConfiguration: configuration,
    totalTasks: graph.issues.filter(
      (issue) => issue.id !== epic.id && issue.type !== "epic" && issue.status !== "closed",
    ).length,
    createdAt: at,
    updatedAt: at,
  });
  signal?.throwIfAborted();
  return store.create(state, policy);
}
