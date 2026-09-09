#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { render } from "ink";
import { StateStore, defaultStatePath } from "./adapters/store.js";
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
import { OperatorView } from "./tui/operator-view.js";
import { runDoctor } from "./doctor.js";
import { redactSensitiveText } from "./util/redact.js";

type BaseOptions = { state: string };
type LaunchOptions = BaseOptions & { headless?: boolean };
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
      ? render(<RunView controller={controller} stop={stop} />, { exitOnCtrlC: false })
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
  } finally {
    if (timer) clearInterval(timer);
    ui?.unmount();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  const status = controller.status();
  process.stdout.write(humanRunStatus(status) + "\n");
  if (["blocked", "awaiting_user"].includes(status.control.status)) process.exitCode = 2;
}

export function createProgram() {
  const program = new Command()
    .name("epicd")
    .description("Persistent Astra engineering lead under a Git and Beads safety kernel")
    .version("0.1.0");
  stateOption(
    program
      .command("control <run-id>")
      .description("Open an operator console for an existing run; never starts a controller"),
  ).action(async (runId: string, options: BaseOptions) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        "The operator console requires an interactive terminal; use explicit CLI commands otherwise",
      );
    await withStore(options, async (store) => {
      const operator = new RunOperator(store, runId);
      operator.status(); // Validate the selected run before mounting a terminal UI.
      const cancellation = new AbortController();
      let ui: ReturnType<typeof render> | undefined;
      const close = () => {
        cancellation.abort(new Error("Operator console closed"));
        ui?.unmount();
      };
      const controls = {
        status: () => operator.status(),
        submit: (request: OperatorRequest) => operator.submit(request, cancellation.signal),
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
      try {
        ui = render(<OperatorView controls={controls} close={close} />, {
          exitOnCtrlC: false,
          // This command requires real terminal input/output above. CI detection
          // must not silently hide an explicitly requested interactive console.
          interactive: true,
        });
        await ui.waitUntilExit();
      } finally {
        close();
        process.off("SIGINT", close);
        process.off("SIGTERM", close);
        await operator.settle(); // Never close SQLite under asynchronous binding or handoff.
      }
      process.stdout.write(
        "Operator console closed. No controller was started. Inspect status for committed requests.\n",
      );
    });
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
  runtimeOption(
    stateOption(
      program
        .command("run <epic-id>")
        .description("Create a fresh run and engage the orchestrator"),
    ),
  )
    .option("--repo <path>", "repository containing .epicd/policy.json", process.cwd())
    .option("--codex-path <path>", "selected native Codex executable")
    .option("--tracker-path <path>", "selected br executable")
    .option(
      "--worker-model <model>",
      "concrete worker default; otherwise resolve the selected Codex default once",
    )
    .option("--auth-cache <path>", "existing token cache to project into private runtime storage")
    .option("--headless", "print events without the status UI")
    .action(
      async (
        epicId: string,
        options: LaunchOptions & {
          repo: string;
          runtime: RuntimeKind;
          codexPath?: string;
          trackerPath?: string;
          workerModel?: string;
          authCache?: string;
        },
      ) => {
        await withStore(options, async (store) => {
          const run = await createRun(store, {
            repoPath: options.repo,
            epicId,
            runtime: options.runtime,
            ...(options.codexPath ? { codexPath: options.codexPath } : {}),
            ...(options.trackerPath ? { trackerPath: options.trackerPath } : {}),
            ...(options.workerModel ? { model: ModelIdSchema.parse(options.workerModel) } : {}),
            ...(options.authCache ? { authCachePath: options.authCache } : {}),
          });
          process.stdout.write(`Created run ${run.runId}\n`);
          await launch(store, run.runId, options);
        });
      },
    );
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
      withStore(options, async (store) => {
        // Do not resume or change control state owned by another live controller.
        const lease = store.controllerLease(runId);
        if (lease?.alive) throw new Error(`Run is already controlled by process ${lease.pid}`);
        const control = store.orchestration.control(runId);
        if (control.status === "paused")
          store.orchestration.operatorControl(runId, control.controlVersion, { kind: "resume" });
        await launch(store, runId, options);
      }),
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createProgram()
    .parseAsync()
    .catch((error) => {
      process.stderr.write(
        `epicd: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}\n`,
      );
      process.exitCode = 1;
    });
}
