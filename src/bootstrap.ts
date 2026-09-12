import { loadAccountDraft, freezeAccountDraft, assertAccountStorage } from "./adapters/accounts.js";
import { accountBinding, type AccountDraft } from "./domain/accounts.js";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { KernelGit } from "./adapters/kernel-git.js";
import { PublicationGit } from "./adapters/publication-git.js";
import { KernelBeads } from "./adapters/kernel-beads.js";
import { StateStore } from "./adapters/store.js";
import { resolveCodexModelEffect, verifyCodexExecutableEffect } from "./adapters/codex-settings.js";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { loadRepositoryPolicyEffect } from "./adapters/repository-policy.js";
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
  discoverHerdrEffect,
  resolveExecutableEffect,
  selectedCodexExecutableEffect,
} from "./adapters/runtime-discovery.js";

// Retain the Promise discovery API for existing callers.
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
  codexHome?: string;
  agentCodexHome?: string[];
  accountDraft?: AccountDraft;
  accountsConfig?: string;
  turnTimeoutMs?: number;
};

type RuntimeHandoffStage =
  | "acquire_lease"
  | "check_ready"
  | "select_runtime"
  | "verify_runtime"
  | "discover_herdr"
  | "inspect_repository"
  | "admit_repository"
  | "commit_handoff"
  | "release_lease";

export class RuntimeHandoffFailed extends Data.TaggedError("RuntimeHandoffFailed")<{
  readonly stage: RuntimeHandoffStage;
  readonly cause: unknown;
}> {}

/** Explicit operator choice. Preflight is read-only; no model, pane, prompt or service is started. */
export function handoffRuntimeEffect(
  store: StateStore,
  runId: string,
  options: { runtime: RuntimeKind; controlVersion: number; codexPath?: string; herdrPath?: string },
  signal?: AbortSignal,
): Effect.Effect<RunState, RuntimeHandoffFailed> {
  const attempt = <A>(stage: RuntimeHandoffStage, run: () => A) =>
    Effect.try({ try: run, catch: (cause) => new RuntimeHandoffFailed({ stage, cause }) });
  const wait = <A>(stage: RuntimeHandoffStage, run: () => Promise<A>) =>
    Effect.uninterruptible(
      Effect.tryPromise({
        try: run,
        catch: (cause) => new RuntimeHandoffFailed({ stage, cause }),
      }),
    );
  return Effect.gen(function* () {
    // Preserve try/finally precedence: a release failure must replace a typed
    // handoff failure because it means the controller lease may still be held.
    const result = yield* Effect.acquireUseRelease(
      attempt("acquire_lease", () => store.acquireLease(runId)),
      (lease) => {
        const authority = { runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
        const journal = store.orchestration;
        return Effect.result(
          Effect.gen(function* () {
            yield* attempt("check_ready", () =>
              assertRuntimeHandoffReady(journal, authority, options.controlVersion),
            );
            const state = yield* attempt("check_ready", () => {
              const state = store.get(runId)!;
              if (!state.runtimeConfiguration) throw new Error("Run has no runtime configuration");
              signal?.throwIfAborted();
              return state;
            });
            const executable = yield* Effect.mapError(
              selectedCodexExecutableEffect(options.runtime, options.codexPath),
              ({ cause }) => new RuntimeHandoffFailed({ stage: "select_runtime", cause }),
            );
            yield* attempt("select_runtime", () => {
              if (state.runtimeConfiguration!.accounts)
                assertAccountStorage(state.runtimeConfiguration!.accounts, [executable]);
            });
            yield* Effect.mapError(
              verifyCodexExecutableEffect(state.repoPath, { executablePath: executable, args: [] }),
              ({ cause }) => new RuntimeHandoffFailed({ stage: "verify_runtime", cause }),
            );
            let herdr = null;
            if (options.runtime === "herdr") {
              const herdrExecutable = yield* Effect.mapError(
                resolveExecutableEffect(options.herdrPath ?? "herdr"),
                ({ cause }) => new RuntimeHandoffFailed({ stage: "discover_herdr", cause }),
              );
              herdr = yield* Effect.mapError(
                discoverHerdrEffect(herdrExecutable, state.repoPath),
                ({ cause }) => new RuntimeHandoffFailed({ stage: "discover_herdr", cause }),
              );
            }
            const target = yield* attempt("select_runtime", () =>
              RuntimeHandoffTargetSchema.parse({ runtime: options.runtime, executable, herdr }),
            );
            const repository = yield* wait("inspect_repository", () =>
              new PublicationGit().bind(state.repoPath, signal),
            );
            yield* attempt("inspect_repository", () => {
              if (
                JSON.stringify(repository.commonDirectory) !==
                JSON.stringify(state.runtimeConfiguration!.commonDirectory)
              )
                throw new Error("Repository metadata identity changed before runtime handoff");
            });
            yield* attempt("check_ready", () =>
              assertRuntimeHandoffReady(journal, authority, options.controlVersion),
            );
            const admission = new RepositoryAdmission(store, authority, repository);
            yield* wait("admit_repository", () => admission.enter(signal));
            yield* wait("admit_repository", () => admission.assertOwned(signal));
            return yield* attempt("commit_handoff", () => {
              signal?.throwIfAborted();
              return journal.handoffRuntime(authority, options.controlVersion, target);
            });
          }),
        );
      },
      (lease) =>
        attempt("release_lease", () => {
          store.releaseLease(runId, lease.ownerToken);
        }),
    );
    if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
    return result.success;
  });
}

export async function handoffRuntime(
  store: StateStore,
  runId: string,
  options: { runtime: RuntimeKind; controlVersion: number; codexPath?: string; herdrPath?: string },
  signal?: AbortSignal,
): Promise<RunState> {
  const result = await Effect.runPromise(
    Effect.result(handoffRuntimeEffect(store, runId, options, signal)),
  );
  if (Result.isFailure(result)) throw result.failure.cause;
  return result.success;
}

const creationStages = {
  check_platform: "checking the platform",
  resolve_repository: "resolving the repository",
  inspect_repository: "checking repository ownership",
  load_policy: "loading the repository policy",
  select_runtime: "selecting the runtime executable",
  verify_runtime: "checking the runtime executable",
  resolve_tracker: "locating Beads",
  read_tracker: "reading the epic graph",
  select_epic: "checking the selected epic",
  discover_herdr: "locating the Herdr session",
  resolve_model: "resolving worker settings",
  configure_runtime: "preparing runtime settings",
  persist_run: "saving the new run",
} as const;
type CreationStage = keyof typeof creationStages;

export class RunCreationFailed extends Data.TaggedError("RunCreationFailed")<{
  readonly stage: CreationStage;
  readonly cause: unknown;
  readonly message: string;
}> {
  constructor(options: { stage: CreationStage; cause: unknown }) {
    const detail = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super({
      ...options,
      message: `Could not start epic while ${creationStages[options.stage]}: ${detail}`,
    });
  }
}

/** Sequential admission. A stage settles before interruption can advance or release its caller. */
export function createRunEffect(
  store: StateStore,
  options: CreateRunOptions,
  signal?: AbortSignal,
): Effect.Effect<RunState, RunCreationFailed> {
  const step = <A, E>(stage: CreationStage, program: Effect.Effect<A, E>) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => signal?.throwIfAborted(),
          catch: (cause) => new RunCreationFailed({ stage, cause }),
        });
        return yield* Effect.mapError(program, (cause) => new RunCreationFailed({ stage, cause }));
      }),
    );
  const attempt = <A>(stage: CreationStage, run: () => A) =>
    step(stage, Effect.try({ try: run, catch: (cause) => cause }));
  const read = <A>(stage: CreationStage, run: () => Promise<A>) =>
    step(stage, Effect.tryPromise({ try: run, catch: (cause) => cause }));
  return Effect.gen(function* () {
    yield* attempt("configure_runtime", () => {
      if (
        options.accountDraft &&
        (options.codexHome !== undefined ||
          options.agentCodexHome !== undefined ||
          options.accountsConfig !== undefined)
      )
        throw new Error(
          "A resolved account draft cannot be combined with unresolved account selectors",
        );
    });
    yield* attempt("check_platform", () => {
      if (process.platform !== "linux" || process.arch !== "x64")
        throw new Error("Controlled runtime admission currently requires Linux x64");
    });
    const inputRoot = yield* read("resolve_repository", () => realpath(resolve(options.repoPath)));
    const top = yield* read("resolve_repository", () =>
      new KernelGit(inputRoot).text(["rev-parse", "--show-toplevel"], signal ? { signal } : {}),
    );
    const repoPath = yield* read("resolve_repository", () => realpath(top.trim()));
    const statePath = yield* read("inspect_repository", () => realpath(resolve(store.path)));
    yield* attempt("inspect_repository", () => {
      const stateLocation = relative(repoPath, statePath);
      if (stateLocation === "" || (!stateLocation.startsWith("../") && !isAbsolute(stateLocation)))
        throw new Error(
          "Run state and private runtime storage must be outside the delivery repository",
        );
    });
    const repository = yield* read("inspect_repository", () =>
      new PublicationGit().bind(repoPath, signal),
    );
    yield* attempt("inspect_repository", () => {
      if (store.inspectWorkflowOwner(repoPath, repository.commonDirectory))
        throw new Error("This repository already has a run; inspect status and resume its run ID");
    });
    const revision = (yield* read("inspect_repository", () =>
      new KernelGit(repoPath).text(["rev-parse", "HEAD"], signal ? { signal } : {}),
    )).trim();
    yield* step("load_policy", loadRepositoryPolicyEffect(repoPath, signal, false));
    const executable = yield* step(
      "select_runtime",
      selectedCodexExecutableEffect(options.runtime, options.codexPath).pipe(
        Effect.mapError((error) => error.cause),
      ),
    );
    yield* step(
      "verify_runtime",
      verifyCodexExecutableEffect(repoPath, { executablePath: executable, args: [] }).pipe(
        Effect.mapError((error) => error.cause),
      ),
    );
    const trackerExecutable = yield* step(
      "resolve_tracker",
      resolveExecutableEffect(options.trackerPath ?? "br").pipe(
        Effect.mapError((error) => error.cause),
      ),
    );
    const tracker = new KernelBeads(trackerExecutable);
    const binding = yield* read("read_tracker", () => tracker.bind(repoPath));
    const graph = yield* read("read_tracker", () =>
      tracker.graph(
        binding,
        options.epicId,
        () => signal?.throwIfAborted(),
        signal ?? new AbortController().signal,
      ),
    );
    const epic = yield* attempt("select_epic", () => {
      const epic = graph.issues.find((issue) => issue.id === options.epicId);
      if (!epic || epic.type !== "epic" || epic.status === "closed" || epic.status === "tombstone")
        throw new Error("Select an open Beads epic");
      return epic;
    });
    let herdr = null;
    if (options.runtime === "herdr") {
      const herdrExecutable = yield* step(
        "discover_herdr",
        resolveExecutableEffect(options.herdrPath ?? "herdr").pipe(
          Effect.mapError((error) => error.cause),
        ),
      );
      herdr = yield* step(
        "discover_herdr",
        discoverHerdrEffect(herdrExecutable, repoPath).pipe(
          Effect.mapError((error) => error.cause),
        ),
      );
    }
    const accountDraft = yield* read("configure_runtime", () =>
      options.accountDraft
        ? Promise.resolve(options.accountDraft)
        : loadAccountDraft(
            {
              ...(options.codexHome !== undefined ? { codexHome: options.codexHome } : {}),
              ...(options.agentCodexHome !== undefined
                ? { agentCodexHome: options.agentCodexHome }
                : {}),
            },
            options.accountsConfig,
          ),
    );
    const accounts = yield* read("configure_runtime", () => freezeAccountDraft(accountDraft));
    const stateDirectory = yield* read("configure_runtime", () => realpath(dirname(store.path)));
    const privateRoot = join(stateDirectory, `${basename(store.path)}.resources`);
    yield* attempt("configure_runtime", () =>
      assertAccountStorage(accounts, [
        repoPath,
        repository.commonDirectory.path,
        statePath,
        privateRoot,
        executable,
      ]),
    );
    const model =
      options.model ??
      (yield* step(
        "resolve_model",
        resolveCodexModelEffect(repoPath, {
          executable: { executablePath: executable, args: [] },
          accountDiscovery: {
            source: accountBinding(accounts, "implementation", "implementation")?.source ?? null,
            root: join(privateRoot, "account-discovery"),
          },
          ...(signal ? { signal } : {}),
        }).pipe(Effect.mapError((error) => error.cause)),
      ));
    const state = yield* attempt("configure_runtime", () => {
      const configuration = RuntimeConfigurationSchema.parse({
        commonDirectory: repository.commonDirectory,
        executable,
        trackerExecutable,
        runtimeRoot: join(privateRoot, "runtimes"),
        workspaceRoot: join(privateRoot, "workspaces"),
        accounts,
        turnTimeoutMs: options.turnTimeoutMs ?? 30 * 60_000,
        herdr,
      });
      const at = new Date().toISOString();
      return RunStateSchema.parse({
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
    });
    const policy = yield* step("load_policy", loadRepositoryPolicyEffect(repoPath, signal));
    return yield* attempt("persist_run", () => store.create(state, policy));
  });
}

/** One Promise entry point; typed failures retain their original cause and failing stage. */
export async function createRun(
  store: StateStore,
  options: CreateRunOptions,
  signal?: AbortSignal,
): Promise<RunState> {
  const result = await Effect.runPromise(Effect.result(createRunEffect(store, options, signal)));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}
