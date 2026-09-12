#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { render } from "ink";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { StateStore, UnsupportedStateFormatError, defaultStatePath } from "./adapters/store.js";
import { AccountSelectionFailed, selectAccountsEffect } from "./tui/account-editor-session.js";
import { loadAccountDraft } from "./adapters/accounts.js";
import { frozenAccountSummary, type AccountOverrides } from "./domain/accounts.js";
import { createRun } from "./bootstrap.js";
import { FixtureOperationSchema } from "./domain/fixtures.js";
import { RunOperator, type OperatorRequest } from "./operator-controls.js";
import { OrchestratorController } from "./controller.js";
import {
  AgentRoleSchema,
  ModelIdSchema,
  ReasoningEffortSchema,
  RuntimeKindSchema,
  type RuntimeKind,
} from "./domain/types.js";
import { humanRunStatus, runStatusView } from "./status.js";
import { RunView } from "./tui/run-view.js";
import { OperatorConsoleFailed, operatorConsoleEffect } from "./tui/operator-console-session.js";
import { runDoctor } from "./doctor.js";
import { redactSensitiveText } from "./util/redact.js";
import { errorDetail } from "./util/error-detail.js";
import {
  assertEpicBrowserSelection,
  browserTimingTracer,
  loadEpicBrowserEffect,
  type EpicBrowserSnapshot,
} from "./epic-browser.js";
import type { EpicBrowserQuery } from "./tui/epic-picker.js";
import { EpicPickerFailed, pickEpicEffect } from "./tui/epic-picker-session.js";
import { EPIC_PAGE_SIZE } from "./domain/epic-discovery.js";

type BaseOptions = { state: string };
type LaunchOptions = BaseOptions & { headless?: boolean; interactive?: true };
type StartOptions = LaunchOptions & {
  repo: string;
  runtime: RuntimeKind;
  codexPath?: string;
  trackerPath?: string;
  workerModel?: string;
  codexHome?: string;
  agentCodexHome?: string[];
  accountsConfig?: string;
  traceDiscovery?: boolean;
};
const stateOption = (command: Command) =>
  command.option("--state <path>", "current-format SQLite state path", defaultStatePath());
const runtimeOption = (command: Command) =>
  command.addOption(
    new Option("--runtime <runtime>", "native Herdr TUI or supervised SDK")
      .choices(RuntimeKindSchema.options)
      .default("sdk"),
  );
const versionNumber = (value: string) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error("Expected a nonnegative integer");
  return number;
};

function unsupportedStateAdvice(error: UnsupportedStateFormatError): string {
  const files = (path: string) => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
  const quote = (path: string) => "'" + path.replaceAll("'", "'\\''") + "'";
  let fresh = `${error.path}.fresh`;
  for (let index = 2; files(fresh).some(existsSync); index++)
    fresh = `${error.path}.fresh-${index}`;
  const intro = `${error.message}\n\nState file: ${JSON.stringify(error.path)}`;
  // Do not print executable snippets containing terminal control characters.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(error.path))
    return `${intro}\nThe path above is JSON-escaped because it contains control characters. Choose a different file with --state <path>.`;
  return [
    intro,
    "",
    "Keep the old data and use a fresh state file:",
    `  epicd --state ${quote(fresh)}`,
    "",
    "Or permanently delete all saved runs in the old file:",
    "  1. Stop any Epicd controllers using this state file.",
    "  2. Delete the database and its SQLite sidecar files:",
    `     rm -f -- ${files(error.path).map(quote).join(" ")}`,
    "  3. Start again:",
    `     epicd --state ${quote(error.path)}`,
    "",
    "Resetting state does not release existing repository run reservations.",
  ].join("\n");
}

async function withStore<T>(
  options: BaseOptions,
  body: (store: StateStore) => T | Promise<T>,
): Promise<T> {
  const store = new StateStore(resolve(options.state));
  try {
    return await body(store);
  } finally {
    store.close();
  }
}
async function operatorCommand(options: BaseOptions, runId: string, request: OperatorRequest) {
  return withStore(options, async (store) => {
    process.stdout.write((await new RunOperator(store, runId).submit(request)) + "\n");
  });
}
async function launch(store: StateStore, runId: string, options: LaunchOptions) {
  const controller = new OrchestratorController(store, runId);
  const request = new AbortController();
  const stop = () => request.abort(new Error("Operator requested stop"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const ui =
    !options.headless && process.stdout.isTTY && process.stdin.isTTY
      ? render(<RunView controller={controller} stop={stop} />, {
          exitOnCtrlC: false,
          ...(options.interactive ? { interactive: true } : {}),
        })
      : null;
  let cursor = store.events(runId, 1).at(-1)?.id ?? 0;
  const timer = ui
    ? null
    : setInterval(() => {
        try {
          for (const event of store.events(runId, 100)) {
            if ((event.id ?? 0) <= cursor) continue;
            cursor = event.id!;
            process.stdout.write(`${event.at} ${event.kind}: ${event.message}\n`);
          }
        } catch {
          stop();
        }
      }, 500);
  try {
    await controller.run(request.signal);
  } catch (failure) {
    process.exitCode = 1;
    throw failure;
  } finally {
    if (timer) clearInterval(timer);
    ui?.unmount();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  const status = controller.status();
  process.stdout.write(humanRunStatus(status) + "\n");
  process.exitCode = ["blocked", "awaiting_user"].includes(status.control.status) ? 2 : 0;
}

const startOptions = (command: Command) =>
  runtimeOption(stateOption(command))
    .option("-C, --repo <path>", "repository to work in", process.cwd())
    .option("--codex-path <path>", "selected native Codex executable")
    .option("--tracker-path <path>", "selected br executable")
    .option(
      "--worker-model <model>",
      "concrete worker default; otherwise resolve the selected Codex default once",
    )
    .option("--codex-home <path>", "default source Codex home for new runs")
    .option(
      "--agent-codex-home <class=path>",
      "per-class source home; use class=inherit to clear",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--accounts-config <path>", "machine-local account preferences file");

async function startRun(
  store: StateStore,
  epicId: string,
  options: StartOptions,
  signal?: AbortSignal,
  epicTitle?: string | null,
) {
  const accountOverrides: AccountOverrides = {
    ...(options.codexHome !== undefined ? { codexHome: options.codexHome } : {}),
    ...(options.agentCodexHome !== undefined ? { agentCodexHome: options.agentCodexHome } : {}),
  };
  const configPath =
    options.accountsConfig !== undefined ? resolve(options.accountsConfig) : undefined;
  const create = (
    accountDraft: Awaited<ReturnType<typeof loadAccountDraft>>,
    signal?: AbortSignal,
  ) =>
    createRun(
      store,
      {
        repoPath: options.repo,
        epicId,
        runtime: options.runtime,
        ...(options.codexPath ? { codexPath: options.codexPath } : {}),
        ...(options.trackerPath ? { trackerPath: options.trackerPath } : {}),
        ...(options.workerModel ? { model: ModelIdSchema.parse(options.workerModel) } : {}),
        accountDraft,
      },
      signal,
    );
  let run: Awaited<ReturnType<typeof createRun>> | undefined;
  if (!options.headless && process.stdin.isTTY && process.stdout.isTTY) {
    const selected = await Effect.runPromise(
      Effect.result(
        selectAccountsEffect(epicId, accountOverrides, configPath, signal, {
          ...(epicTitle !== undefined ? { epicTitle } : {}),
          repoPath: resolve(options.repo),
          runtime: options.runtime,
          start: async (draft, setupSignal) => {
            run = await create(draft, setupSignal);
          },
        }),
      ),
    );
    // Retain the failure classification until the browser has decided whether
    // the terminal is reusable. The external Promise API still unwraps causes.
    if (Result.isFailure(selected)) {
      if (run) throw new RunSetupFailed(run.runId, options.state, selected.failure);
      throw selected.failure;
    }
    const selection = selected.success;
    if (run && signal?.aborted) throw new RunSetupFailed(run.runId, options.state, signal.reason);
    if (selection === "quit" || selection === null || signal?.aborted) {
      if (run) process.stderr.write(createdRunRecovery(run.runId, options.state) + "\n");
      return selection === "quit" ? ("quit" as const) : false;
    }
  } else {
    run = await create(await loadAccountDraft(accountOverrides, configPath), signal);
  }
  if (!run) throw new Error("Account setup completed without creating a run");
  process.stdout.write(`Created run ${run.runId}\n`);
  if (signal?.aborted) throw new RunSetupFailed(run.runId, options.state, signal.reason);
  await launch(store, run.runId, options);
  return true;
}

async function resumeRun(store: StateStore, runId: string, options: LaunchOptions) {
  const state = store.get(runId);
  if (state)
    process.stdout.write(
      "Saved account selections (new defaults do not apply):\n" +
        frozenAccountSummary(state.runtimeConfiguration)
          .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "))
          .join("\n") +
        "\n",
    );
  const lease = store.controllerLease(runId);
  if (lease?.alive) throw new Error(`Run is already controlled by process ${lease.pid}`);
  const control = store.orchestration.control(runId);
  if (control.status === "paused")
    store.orchestration.operatorControl(runId, control.controlVersion, { kind: "resume" });
  await launch(store, runId, options);
}

async function openOperator(store: StateStore, runId: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "The operator console requires an interactive terminal; use explicit CLI commands otherwise",
    );
  const operator = new RunOperator(store, runId);
  const result = await Effect.runPromise(Effect.result(operatorConsoleEffect(operator)));
  if (Result.isFailure(result))
    throw result.failure.terminalState === "untouched" ? result.failure.cause : result.failure;
  process.stdout.write(
    "Operator console closed. No controller was started. Inspect status for committed requests.\n",
  );
}

async function browseEpics(store: StateStore, options: StartOptions) {
  const program = Effect.acquireUseRelease(
    Effect.sync(() => {
      const cancellation = new AbortController();
      const stop = () => cancellation.abort(new Error("Epic browser closed"));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return { cancellation, stop };
    }),
    ({ cancellation }) =>
      Effect.gen(function* () {
        let error: string | undefined;
        let query: EpicBrowserQuery = { page: 1, search: "", showNested: false };
        let loadedQuery = query;
        let snapshot: EpicBrowserSnapshot | undefined;
        const tracer = options.traceDiscovery
          ? browserTimingTracer((line) => {
              process.stderr.write(line + "\n");
            })
          : undefined;
        while (!cancellation.signal.aborted) {
          yield* Effect.try({
            try: () => process.stdout.write("Loading Beads epics…\n"),
            catch: (cause) => cause,
          });
          const loading = loadEpicBrowserEffect(
            store,
            {
              ...options,
              offset: (query.page - 1) * EPIC_PAGE_SIZE,
              search: query.search,
            },
            cancellation.signal,
          );
          const loaded = yield* Effect.result(
            tracer ? Effect.withTracer(loading, tracer) : loading,
          );
          if (cancellation.signal.aborted) return;
          let pickerError = error;
          if (Result.isFailure(loaded)) {
            if (!snapshot) return yield* Effect.fail(loaded.failure);
            query = loadedQuery;
            const reloadError = `${loaded.failure.message} Showing the previous page; press r to reload or try navigation again.`;
            pickerError = error ? `${error}\n${reloadError}` : reloadError;
          } else {
            snapshot = loaded.success;
            loadedQuery = query;
          }
          const selection = yield* pickEpicEffect(
            {
              items: snapshot.items,
              runtime: options.runtime,
              query,
              hasNextPage: snapshot.nextOffset !== null,
              ...(pickerError ? { error: pickerError } : {}),
            },
            cancellation.signal,
          );
          if (cancellation.signal.aborted || selection.kind === "quit") return;
          if (selection.kind === "browse") {
            query = selection.query;
            error = undefined;
            continue;
          }
          // A retained page is display-only until discovery succeeds and the user confirms anew.
          if (Result.isFailure(loaded)) {
            error = "Review the refreshed epic list before confirming again.";
            continue;
          }
          // Legacy controllers retain stop/drain ownership. Never detach their Promise on interruption.
          const confirmedSnapshot = snapshot;
          const launched = yield* Effect.result(
            Effect.uninterruptible(
              Effect.tryPromise({
                try: async () => {
                  assertEpicBrowserSelection(store, confirmedSnapshot, selection.item);
                  const action = selection.item.action;
                  if (action.kind === "start") {
                    const started = await startRun(
                      store,
                      selection.item.epic.id,
                      { ...options, repo: confirmedSnapshot.repoPath, interactive: true },
                      cancellation.signal,
                      selection.item.epic.title,
                    );
                    if (started === "quit") return "quit" as const;
                    if (!started) return "back" as const;
                  } else if (action.kind === "resume")
                    await resumeRun(store, action.runId, { ...options, interactive: true });
                  else if (action.kind === "control") await openOperator(store, action.runId);
                },
                catch: (cause) => cause,
              }),
            ),
          );
          // Cancellation does not make an incompletely released terminal safe.
          if (Result.isFailure(launched) && hasUnknownTerminalState(launched.failure))
            return yield* Effect.fail(launched.failure);
          if (cancellation.signal.aborted) {
            // Cancellation stops future work; it cannot erase a committed run's
            // recovery information. Let the executable report that outcome.
            if (Result.isFailure(launched) && launched.failure instanceof RunSetupFailed)
              return yield* Effect.fail(launched.failure);
            return;
          }
          if (Result.isSuccess(launched)) {
            if (launched.success === "back") {
              error = undefined;
              continue;
            }
            return;
          }
          const failure = launched.failure;
          // Retain committed-run instructions outside the disposable picker view.
          if (failure instanceof RunSetupFailed)
            process.stderr.write(createdRunRecovery(failure.runId, failure.statePath) + "\n");
          error = cliFailureMessage(failure);
        }
      }),
    ({ cancellation, stop }) =>
      Effect.sync(() => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        if (!cancellation.signal.aborted) stop();
      }),
  );
  const result = await Effect.runPromise(Effect.result(program));
  if (Result.isFailure(result)) throw result.failure;
}

export function createProgram() {
  const program = new Command()
    .name("epicd")
    .description("Persistent Astra engineering lead under a Git and Beads safety kernel")
    .version("0.1.0");
  startOptions(
    program
      .command("browse", { isDefault: true })
      .description("Browse epics and start or resume the orchestrator (default in a terminal)"),
  )
    .option("--trace-discovery", "write browser discovery stage timings to stderr")
    .action(async (options: StartOptions) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        program.outputHelp({ error: true });
        process.exitCode = 1;
        return;
      }
      await withStore(options, (store) => browseEpics(store, options));
    });
  stateOption(
    program
      .command("control <run-id>")
      .description("Open an operator console for an existing run; never starts a controller"),
  ).action(async (runId: string, options: BaseOptions) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        "The operator console requires an interactive terminal; use explicit CLI commands otherwise",
      );
    await withStore(options, (store) => openOperator(store, runId));
  });
  stateOption(
    program
      .command("grant-fixture-validation <run-id> <fixture-id>")
      .description(
        "Grant checked SQL use of a declared disposable database and its dedicated role; separate from creation authority",
      ),
  )
    .requiredOption("--control-version <number>", "version observed in status", versionNumber)
    .requiredOption("--expires-at <ISO-time>", "expiry within the next 24 hours")
    .requiredOption("--psql-path <path>", "canonical native psql executable")
    .action(
      async (
        runId: string,
        fixtureId: string,
        options: BaseOptions & { controlVersion: number; expiresAt: string; psqlPath: string },
      ) =>
        operatorCommand(options, runId, {
          kind: "grant_sql",
          fixtureId,
          controlVersion: options.controlVersion,
          expiresAt: options.expiresAt,
          psqlPath: options.psqlPath,
        }),
    );
  stateOption(
    program
      .command("revoke-fixture-validation <run-id> <grant-id>")
      .description("Revoke SQL access without discarding unsettled database work"),
  )
    .requiredOption("--control-version <number>", "version observed in status", versionNumber)
    .action(
      async (runId: string, grantId: string, options: BaseOptions & { controlVersion: number }) =>
        operatorCommand(options, runId, {
          kind: "revoke_sql",
          grantId,
          controlVersion: options.controlVersion,
        }),
    );
  stateOption(
    program
      .command("grant-fixture <run-id> <fixture-id>")
      .description(
        "Explicitly grant bounded fixture operations; no resource is created or adopted",
      ),
  )
    .requiredOption("--control-version <number>", "version observed in status", versionNumber)
    .requiredOption(
      "--operations <list>",
      "comma-separated inspect,create,reset,cleanup; reset and cleanup are not implemented yet",
    )
    .requiredOption("--expires-at <ISO-time>", "expiry within the next 24 hours")
    .requiredOption(
      "--psql-path <path>",
      "canonical native PostgreSQL psql ELF executable, not pg_wrapper",
    )
    .action(
      async (
        runId: string,
        fixtureId: string,
        options: BaseOptions & {
          controlVersion: number;
          operations: string;
          expiresAt: string;
          psqlPath: string;
        },
      ) =>
        operatorCommand(options, runId, {
          kind: "grant_fixture",
          fixtureId,
          controlVersion: options.controlVersion,
          operations: options.operations
            .split(",")
            .map((value) => FixtureOperationSchema.parse(value.trim())),
          expiresAt: options.expiresAt,
          psqlPath: options.psqlPath,
        }),
    );
  stateOption(
    program
      .command("revoke-fixture-grant <run-id> <grant-id>")
      .description("Revoke exact fixture authority without deleting any resource"),
  )
    .requiredOption("--control-version <number>", "version observed in status", versionNumber)
    .action(
      async (runId: string, grantId: string, options: BaseOptions & { controlVersion: number }) =>
        operatorCommand(options, runId, {
          kind: "revoke_fixture",
          grantId,
          controlVersion: options.controlVersion,
        }),
    );
  startOptions(
    program.command("run <epic-id>").description("Create a fresh run and engage the orchestrator"),
  )
    .option("--headless", "print events without the status UI")
    .action(async (epicId: string, options: StartOptions) => {
      await withStore(options, (store) => startRun(store, epicId, options));
    });
  stateOption(
    program
      .command("handoff <run-id>")
      .description(
        "Explicitly switch a stopped run's runtime without migrating conversations or starting work",
      ),
  )
    .addOption(
      new Option("--runtime <runtime>", "target native runtime")
        .choices(RuntimeKindSchema.options)
        .makeOptionMandatory(),
    )
    .requiredOption("--control-version <number>", "version observed in status", versionNumber)
    .option("--codex-path <path>", "selected native Codex executable")
    .option("--herdr-path <path>", "Herdr executable for read-only caller discovery")
    .action(
      async (
        runId: string,
        options: BaseOptions & {
          runtime: RuntimeKind;
          controlVersion: number;
          codexPath?: string;
          herdrPath?: string;
        },
      ) =>
        operatorCommand(options, runId, {
          kind: "handoff",
          runtime: options.runtime,
          controlVersion: options.controlVersion,
          ...(options.codexPath ? { codexPath: options.codexPath } : {}),
          ...(options.herdrPath ? { herdrPath: options.herdrPath } : {}),
        }),
    );
  stateOption(
    program
      .command("resume <run-id>")
      .description("Resume this format's recorded runtime and owned work"),
  )
    .option("--headless", "print events without the status UI")
    .action(async (runId: string, options: LaunchOptions) =>
      withStore(options, (store) => resumeRun(store, runId, options)),
    );
  stateOption(
    program
      .command("status [run-id]")
      .description("Inspect durable control, actions, evidence and pending questions"),
  )
    .option("--json", "machine-readable journal projection")
    .action(async (runId: string | undefined, options: BaseOptions & { json?: boolean }) =>
      withStore(options, (store) => {
        const runs = runId ? [runId] : store.list().map((run) => run.runId);
        const statuses = runs.map((id) => runStatusView(store, id));
        process.stdout.write(
          options.json
            ? JSON.stringify(runId ? statuses[0] : statuses, null, 2) + "\n"
            : statuses.map(humanRunStatus).join("\n\n") + "\n",
        );
      }),
    );
  stateOption(
    program
      .command("pause <run-id>")
      .description("Durably stop admission and interrupt owned work"),
  )
    .requiredOption("--control-version <number>", "version observed in status", versionNumber)
    .action(async (runId: string, options: BaseOptions & { controlVersion: number }) =>
      operatorCommand(options, runId, { kind: "pause", controlVersion: options.controlVersion }),
    );
  stateOption(
    program
      .command("respond <run-id> <escalation-id> <message>")
      .description("Answer one pending question; this does not grant environment authority"),
  )
    .requiredOption(
      "--control-version <number>",
      "version observed with the pending question",
      versionNumber,
    )
    .action(
      async (
        runId: string,
        escalationId: string,
        message: string,
        options: BaseOptions & { controlVersion: number },
      ) =>
        operatorCommand(options, runId, {
          kind: "respond",
          escalationId,
          message,
          controlVersion: options.controlVersion,
        }),
    );
  stateOption(
    program
      .command("settings <run-id>")
      .description(
        "Change one role's future-thread preferences while no live controller owns the run",
      ),
  )
    .addOption(new Option("--role <role>").choices(AgentRoleSchema.options).makeOptionMandatory())
    .option("--model <model>", "concrete model; orchestrator must be gpt-6-astra")
    .addOption(new Option("--reasoning <effort>").choices(ReasoningEffortSchema.options))
    .action(
      async (
        runId: string,
        options: BaseOptions & { role: string; model?: string; reasoning?: string },
      ) =>
        withStore(options, (store) => {
          const state = store.get(runId);
          if (!state) throw new Error("Unknown run");
          if (!options.model && !options.reasoning)
            throw new Error("Supply --model or --reasoning");
          const role = AgentRoleSchema.parse(options.role);
          const settings = structuredClone(state.agentSettings);
          if (options.model) settings[role].model = ModelIdSchema.parse(options.model);
          if (options.reasoning)
            settings[role].reasoningEffort = ReasoningEffortSchema.parse(options.reasoning);
          store.updateAgentSettings(runId, settings);
          process.stdout.write(
            "Future-thread settings recorded. Existing assignments remain immutable.\n",
          );
        }),
    );
  stateOption(
    program
      .command("unlock <run-id>")
      .description(
        "Fence one explicitly identified controller lease; does not prove its agents stopped",
      ),
  )
    .requiredOption("--owner-pid <number>", "observed PID", versionNumber)
    .requiredOption("--lease-id <id>", "observed lease ID")
    .requiredOption("--force", "explicitly revoke this exact lease")
    .action(async (runId: string, options: BaseOptions & { ownerPid: number; leaseId: string }) =>
      withStore(options, (store) => {
        process.stdout.write(
          store.forceReleaseLease(runId, options.ownerPid, options.leaseId)
            ? "Lease fenced; resume reconciles recorded external work.\n"
            : "No lease to release.\n",
        );
      }),
    );
  stateOption(
    program
      .command("quarantine <run-id>")
      .description("Preserve an invalid run's raw records without deriving cleanup actions"),
  )
    .requiredOption("--force", "explicitly quarantine this invalid record")
    .action(async (runId: string, options: BaseOptions) =>
      withStore(options, (store) => {
        const result = store.quarantineInvalidRun(runId);
        process.stdout.write(
          `Quarantined ${result.runId}; raw records retained. External resources were not removed.\n`,
        );
      }),
    );
  runtimeOption(program.command("doctor").description("Read-only executable and endpoint checks"))
    .option("--repo <path>", "repository path", process.cwd())
    .option("--codex-path <path>", "selected native executable")
    .action(async (options: { repo: string; runtime: RuntimeKind; codexPath?: string }) => {
      process.stdout.write(
        JSON.stringify(
          await runDoctor({
            repoPath: options.repo,
            runtime: options.runtime,
            ...(options.codexPath ? { codexPath: options.codexPath } : {}),
          }),
          null,
          2,
        ) + "\n",
      );
    });
  return program;
}

function createdRunRecovery(runId: string, statePath: string): string {
  const path = resolve(statePath);
  const prefix = `Created run ${runId}. No controller started.`;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) {
    const displayed = JSON.stringify(path).replace(
      /[\u007f-\u009f]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    return `${prefix}\nState file: ${displayed}\nResume with epicd resume ${runId}, supplying that path with --state.`;
  }
  const quoted = "'" + path.replaceAll("'", "'\\''") + "'";
  return `${prefix}\nResume with: epicd resume ${runId} --state ${quoted}`;
}

class RunSetupFailed extends Error {
  constructor(
    readonly runId: string,
    readonly statePath: string,
    cause: unknown,
  ) {
    // Put the durable outcome first so diagnostic clipping cannot hide the run.
    super(`${createdRunRecovery(runId, statePath)}\n${errorDetail(cause)}`, { cause });
    this.name = "RunSetupFailed";
  }
}

function cliFailureMessage(error: unknown): string {
  let message: string;
  if (error instanceof RunSetupFailed) {
    // The operator-supplied filename is command data, not free-form error text.
    // Redacting a shell-quoted path can corrupt its value and closing quote.
    message = `${createdRunRecovery(error.runId, error.statePath)}\n${redactSensitiveText(errorDetail(error.cause))}`;
  } else
    message =
      error instanceof UnsupportedStateFormatError
        ? unsupportedStateAdvice(error)
        : redactSensitiveText(errorDetail(error));
  // Keep diagnostic line breaks, but never let cause text move the cursor or
  // erase recovery instructions. This applies to every CLI failure formatter.
  return message.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function hasUnknownTerminalState(error: unknown): boolean {
  const failure = error instanceof RunSetupFailed ? error.cause : error;
  return (
    (failure instanceof EpicPickerFailed ||
      failure instanceof AccountSelectionFailed ||
      failure instanceof OperatorConsoleFailed) &&
    failure.terminalState === "unknown"
  );
}

/** Executable boundary only; embedded createProgram callers receive the typed error. */
export function reportCliFailure(error: unknown): void {
  const diagnostic = `epicd: ${cliFailureMessage(error)}\n`;
  process.exitCode = 1;
  if (hasUnknownTerminalState(error)) {
    // All command scopes and owned work have drained before parseAsync rejects.
    // A broken Ink instance can still hold stdin open. Exit after flushing the
    // diagnostic rather than relying on its incomplete teardown to release it.
    // A stalled asynchronous pipe must not keep the broken executable alive.
    // Give output one second; the fallback may truncate an undeliverable message.
    const deadline = setTimeout(() => process.exit(1), 1_000);
    deadline.unref();
    try {
      process.stderr.write(diagnostic, () => {
        clearTimeout(deadline);
        process.exit(1);
      });
    } catch {
      clearTimeout(deadline);
      process.exit(1);
    }
  } else process.stderr.write(diagnostic);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  createProgram().parseAsync().catch(reportCliFailure);
}
