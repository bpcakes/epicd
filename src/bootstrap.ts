import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
import { assertRuntimeHandoffReady } from "./adapters/runtime-handoff.js";
import { RuntimeHandoffTargetSchema } from "./domain/runtime-handoff.js";
import { RepositoryAdmission } from "./kernel/repository-admission.js";
import {
  discoverHerdr,
  resolveExecutable,
  selectedCodexExecutable,
} from "./adapters/runtime-discovery.js";

// Retain existing Promise imports while discovery callers migrate to Effect.
export {
  discoverHerdr,
  resolveExecutable,
  sdkNativeExecutable,
  selectedCodexExecutable,
} from "./adapters/runtime-discovery.js";

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
