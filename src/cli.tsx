#!/usr/bin/env node
import process from "node:process";
import { resolve } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { render } from "ink";
import React from "react";
import { BeadsClient } from "./adapters/beads.js";
import { agentOptions, type AgentOptionValues } from "./agent-options.js";
import { GitClient } from "./adapters/git.js";
import {
  runStateDecodeDetail,
  StateStore,
  type StoredRunInspection,
  unsupportedRunStateVersion,
} from "./adapters/store.js";
import { runDoctor } from "./doctor.js";
import { assertResumeOptionsAllowed, EpicEngine } from "./engine/engine.js";
import type { EpicEngineOptions } from "./engine/engine.js";
import { EpicdApp } from "./tui/app.js";
import { RunView } from "./tui/run-view.js";
import {
  ReasoningEffortSchema,
  type DoctorCheck,
  type ReasoningEffort,
  type RunState,
  type RuntimeKind,
} from "./domain/types.js";
import type { PickerItem } from "./tui/picker.js";
import { humanRunStatus, runStatusView } from "./status.js";
import { epicRunConflictMessage, launchHeadlessController } from "./controller.js";
import { modelOption } from "./cli-options.js";
import { resolveRunPreflight } from "./preflight.js";

function requireValidInspection(
  inspected: StoredRunInspection | null,
  epicId?: string,
): RunState | null {
  if (!inspected) return null;
  if (inspected.kind === "invalid") {
    throw new Error(
      `Run ${inspected.runId}${epicId ? ` for ${epicId}` : ""} has invalid persisted state: ${runStateDecodeDetail(inspected.error)}; inspect it with epicd status ${inspected.epicId}`,
      { cause: inspected.error },
    );
  }
  return inspected.state;
}

function recoverableRun(store: StateStore, repoPath: string, epicId: string): RunState | null {
  return requireValidInspection(store.inspectRecoverable(repoPath, epicId), epicId);
}

function pickerRun(store: StateStore, repoPath: string, epicId: string) {
  const inspected = store.inspectRecoverable(repoPath, epicId);
  if (!inspected) return { run: null, unavailableReason: null };
  if (inspected.kind === "invalid") {
    return {
      run: null,
      unavailableReason: `Run ${inspected.runId} has invalid persisted state: ${runStateDecodeDetail(inspected.error)}; inspect it with epicd status ${epicId}`,
    };
  }
  return { run: inspected.state, unavailableReason: null };
}

async function withStateStore<Result>(
  operation: (store: StateStore) => Promise<Result> | Result,
): Promise<Result> {
  const store = new StateStore();
  try {
    return await operation(store);
  } finally {
    store.close();
  }
}

function invalidRunRecovery(
  runId: string,
  error: StoredRunInspection & { kind: "invalid" },
): string {
  const version = unsupportedRunStateVersion(error.error);
  return version === null
    ? `after inspection, recover with: epicd quarantine ${runId} --force`
    : `upgrade Epicd to a version that supports state schema ${version}; do not quarantine this run`;
}

type CommonOptions = AgentOptionValues & {
  repo: string;
  runtime?: RuntimeKind;
  codexPath?: string;
  maxReviewPasses?: number;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
};

function commonOptions(command: Command): CommonOptions {
  const options = command.optsWithGlobals<CommonOptions>();
  return options;
}

function reviewLoopOptions(options: CommonOptions): Pick<EpicEngineOptions, "maxReviewPasses"> {
  return options.maxReviewPasses === undefined ? {} : { maxReviewPasses: options.maxReviewPasses };
}

function permissionOptions(options: CommonOptions): Pick<EpicEngineOptions, "accessMode"> {
  return options.dangerouslyBypassApprovalsAndSandbox === undefined
    ? {}
    : {
        accessMode: options.dangerouslyBypassApprovalsAndSandbox
          ? "danger-full-access"
          : "sandboxed",
      };
}

function resumeEngine(
  state: NonNullable<ReturnType<StateStore["get"]>>,
  options: CommonOptions,
  store: StateStore,
): EpicEngine {
  const requestedOptions = engineOptionOverrides(options);
  assertResumeOptionsAllowed(state, requestedOptions);
  return EpicEngine.resume(state.runId, requestedOptions, store);
}

function engineOptionOverrides(
  options: CommonOptions,
): Pick<
  EpicEngineOptions,
  | "model"
  | "reasoningEffort"
  | "agentSettings"
  | "maxReviewPasses"
  | "accessMode"
  | "runtime"
  | "codexPath"
> {
  return {
    ...agentOptions(options),
    ...reviewLoopOptions(options),
    ...permissionOptions(options),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.codexPath ? { codexPath: options.codexPath } : {}),
  };
}

function assertResumeOptions(state: RunState, options: CommonOptions): void {
  assertResumeOptionsAllowed(state, engineOptionOverrides(options));
}

function assertLaunchChecks(checks: readonly DoctorCheck[]): void {
  const failed = checks.filter((check) => check.status === "fail");
  if (failed.length > 0)
    throw new Error(failed.map((check) => `${check.name}: ${check.message}`).join("\n"));
}

async function launchEngine(engine: EpicEngine, interactive = process.stdout.isTTY): Promise<void> {
  if (interactive) {
    await render(<RunView engine={engine} />, { exitOnCtrlC: false }).waitUntilExit();
    return;
  }
  await launchHeadlessController(engine);
}

async function createOrReject(
  epicId: string,
  options: CommonOptions,
  store: StateStore,
): Promise<EpicEngine> {
  const repoPath = resolve(options.repo);
  const root = await new GitClient(repoPath).root();
  const workflowOwner = requireValidInspection(store.inspectWorkflowOwner(root));
  if (workflowOwner) {
    throw new Error(
      `An existing ${workflowOwner.phase} run still owns this repository. Use: epicd resume ${workflowOwner.epicId} --repo ${root}`,
    );
  }
  const existing = recoverableRun(store, root, epicId);
  if (existing) {
    throw new Error(epicRunConflictMessage(existing, root));
  }
  return await EpicEngine.create(
    {
      ...engineOptionOverrides(options),
      repoPath: root,
      epicId,
      runtime: options.runtime ?? "sdk",
    },
    store,
  );
}

async function defaultTui(epicId: string | undefined, options: CommonOptions): Promise<void> {
  const root = await new GitClient(resolve(options.repo)).root();
  await withStateStore(async (store) => {
    const directRun = epicId ? recoverableRun(store, root, epicId) : null;
    const workflowOwner = epicId ? requireValidInspection(store.inspectWorkflowOwner(root)) : null;
    if (epicId && !directRun && workflowOwner) {
      throw new Error(
        `An existing ${workflowOwner.phase} run still owns this repository. Use: epicd resume ${workflowOwner.epicId} --repo ${root}`,
      );
    }
    if (directRun) assertResumeOptions(directRun, options);
    const preflight = resolveRunPreflight(directRun, options.runtime);
    const doctor = await runDoctor(root, preflight.runtime, {
      mode: epicId ? preflight.mode : "selection",
      ...(options.codexPath ? { codexPath: options.codexPath } : {}),
    });
    assertLaunchChecks(doctor.checks);
    if (epicId) {
      const existing = directRun;
      const engine = existing
        ? resumeEngine(existing, options, store)
        : await EpicEngine.create(
            {
              ...engineOptionOverrides(options),
              repoPath: doctor.repoPath,
              epicId,
              runtime: preflight.runtime,
            },
            store,
          );
      await launchEngine(engine);
      return;
    }

    if (!process.stdout.isTTY) throw new Error("An epic ID is required when stdout is not a TTY");
    const epics = await new BeadsClient(doctor.repoPath).listOpenEpics();
    const items: PickerItem[] = epics.map((epic) => ({
      epic,
      ...pickerRun(store, doctor.repoPath, epic.id),
    }));
    if (items.length === 0) throw new Error("No open Beads epics were found in this repository");
    await render(
      <EpicdApp
        items={items}
        loadEngine={async (item) => {
          const selectedRun = recoverableRun(store, doctor.repoPath, item.epic.id);
          if (item.run && !selectedRun) {
            throw new Error(
              `${item.epic.id} no longer needs recovery; return to the picker to refresh its status`,
            );
          }
          if (selectedRun) assertResumeOptions(selectedRun, options);
          const selectedPreflight = resolveRunPreflight(selectedRun, options.runtime);
          const selectedDoctor = await runDoctor(doctor.repoPath, selectedPreflight.runtime, {
            mode: selectedPreflight.mode,
            ...(options.codexPath ? { codexPath: options.codexPath } : {}),
          });
          assertLaunchChecks(selectedDoctor.checks);
          if (selectedRun) return resumeEngine(selectedRun, options, store);
          return await EpicEngine.create(
            {
              ...engineOptionOverrides(options),
              repoPath: selectedDoctor.repoPath,
              epicId: item.epic.id,
              runtime: selectedPreflight.runtime,
            },
            store,
          );
        }}
      />,
      { exitOnCtrlC: false },
    ).waitUntilExit();
  });
}

function reasoningOption(flags: string, description: string): Option {
  return new Option(flags, description).choices(ReasoningEffortSchema.options);
}

function inheritOption(flags: string, description: string, conflictsWith: string): Option {
  return new Option(flags, description).conflicts(conflictsWith);
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

const program = new Command();
program
  .name("epicd")
  .description("Deliver Beads epics through persistent SDK or Herdr agent sessions")
  .version("0.1.0")
  .argument("[epic-id]", "open this epic directly; omit to choose in the TUI")
  .option("-C, --repo <path>", "repository containing .beads", process.cwd())
  .option("--codex-path <path>", "use a specific local Codex executable instead of the SDK runtime")
  .addOption(modelOption("--model <model>", "model fallback for all agent roles"))
  .addOption(
    inheritOption(
      "--model-inherit",
      "reset the run-wide model fallback to the provider default",
      "model",
    ),
  )
  .addOption(reasoningOption("--reasoning <effort>", "reasoning fallback for all agent roles"))
  .addOption(
    inheritOption(
      "--reasoning-inherit",
      "reset the run-wide reasoning fallback to built-in role defaults",
      "reasoning",
    ),
  )
  .addOption(modelOption("--orchestrator-model <model>", "orchestrator model override"))
  .addOption(
    inheritOption(
      "--orchestrator-model-inherit",
      "reset orchestrator model to the run-wide fallback",
      "orchestratorModel",
    ),
  )
  .addOption(
    reasoningOption("--orchestrator-reasoning <effort>", "orchestrator reasoning override"),
  )
  .addOption(
    inheritOption(
      "--orchestrator-reasoning-inherit",
      "reset orchestrator reasoning to the run-wide fallback",
      "orchestratorReasoning",
    ),
  )
  .addOption(modelOption("--implementation-model <model>", "implementation model override"))
  .addOption(
    inheritOption(
      "--implementation-model-inherit",
      "reset implementation model to the run-wide fallback",
      "implementationModel",
    ),
  )
  .addOption(
    reasoningOption("--implementation-reasoning <effort>", "implementation reasoning override"),
  )
  .addOption(
    inheritOption(
      "--implementation-reasoning-inherit",
      "reset implementation reasoning to the run-wide fallback",
      "implementationReasoning",
    ),
  )
  .addOption(modelOption("--review-model <model>", "review model override"))
  .addOption(
    inheritOption(
      "--review-model-inherit",
      "reset review model to the run-wide fallback",
      "reviewModel",
    ),
  )
  .addOption(reasoningOption("--review-reasoning <effort>", "review reasoning override"))
  .addOption(
    inheritOption(
      "--review-reasoning-inherit",
      "reset review reasoning to the run-wide fallback",
      "reviewReasoning",
    ),
  )
  .addOption(
    new Option(
      "--max-review-passes <count>",
      "maximum fix passes per review cycle for new runs (default: 3)",
    ).argParser(positiveInteger),
  )
  .option(
    "--dangerously-bypass-approvals-and-sandbox",
    "give all agents unsandboxed host access without approvals (DANGEROUS)",
  )
  .addOption(
    new Option("--runtime <runtime>", "agent runtime for new runs").choices([
      "sdk",
      "herdr",
    ] as const),
  )
  .action(
    async (epicId: string | undefined, options: CommonOptions) => await defaultTui(epicId, options),
  );
program.configureHelp({ showGlobalOptions: true });

program
  .command("run")
  .description("start a new epic run")
  .argument("<epic-id>")
  .option("--no-tui", "stream line-oriented events")
  .action(async (epicId: string, options: { tui: boolean }, command: Command) => {
    const common = commonOptions(command);
    const doctor = await runDoctor(common.repo, common.runtime ?? "sdk", {
      ...(common.codexPath ? { codexPath: common.codexPath } : {}),
    });
    assertLaunchChecks(doctor.checks);
    await withStateStore(async (store) => {
      const engine = await createOrReject(epicId, common, store);
      await launchEngine(engine, options.tui && process.stdout.isTTY);
    });
  });

program
  .command("resume")
  .description("resume the latest recoverable run for an epic")
  .argument("<epic-id>")
  .option("--no-tui", "stream line-oriented events")
  .action(async (epicId: string, options: { tui: boolean }, command: Command) => {
    const common = commonOptions(command);
    const root = await new GitClient(resolve(common.repo)).root();
    await withStateStore(async (store) => {
      const state = recoverableRun(store, root, epicId);
      if (!state) {
        const latest = requireValidInspection(store.inspectLatest(root, epicId), epicId);
        if (latest) throw new Error(`${epicId} is already complete`);
        throw new Error(`No epicd run found for ${epicId}`);
      }
      assertResumeOptions(state, common);
      const preflight = resolveRunPreflight(state, common.runtime);
      const doctor = await runDoctor(root, preflight.runtime, {
        mode: preflight.mode,
        ...(common.codexPath ? { codexPath: common.codexPath } : {}),
      });
      assertLaunchChecks(doctor.checks);
      const engine = resumeEngine(state, common, store);
      await launchEngine(engine, options.tui && process.stdout.isTTY);
    });
  });

program
  .command("status")
  .description("show persisted epic run status")
  .argument("[epic-id]")
  .option("--json", "emit machine-readable JSON")
  .action(async (epicId: string | undefined, options: { json?: boolean }, command: Command) => {
    const common = commonOptions(command);
    const repoPath = await new GitClient(resolve(common.repo)).root();
    await withStateStore((store) => {
      const current = epicId ? store.inspectCurrent(repoPath, epicId) : null;
      const inspected = epicId ? (current ? [current] : []) : store.inspect(repoPath);
      const valid = inspected.flatMap((entry) => (entry.kind === "valid" ? [entry.state] : []));
      const invalid = inspected.filter((entry) => entry.kind === "invalid");
      for (const entry of invalid) {
        process.stderr.write(
          `epicd: run ${entry.runId} has invalid persisted state: ${runStateDecodeDetail(entry.error)}${options.json ? "; omitted from JSON status" : ""}; ${invalidRunRecovery(entry.runId, entry)}\n`,
        );
      }
      if (options.json && invalid.length > 0) process.exitCode = 1;
      if (options.json)
        process.stdout.write(
          `${JSON.stringify(
            valid.map((state) => runStatusView(state, store.controllerLease(state.runId))),
            null,
            2,
          )}\n`,
        );
      else if (inspected.length === 0) process.stdout.write("No epicd runs found.\n");
      else {
        for (const entry of inspected) {
          if (entry.kind === "invalid") {
            const lease = store.controllerLease(entry.runId);
            const controller = lease
              ? `\n  controller pid ${lease.pid} · lease ${lease.leaseId} · ${lease.alive ? "alive" : "stale"}`
              : "";
            process.stdout.write(
              `${entry.epicId} (${entry.runId})\n  invalid persisted state (${runStateDecodeDetail(entry.error)}) · recorded phase ${entry.phase} · updated ${entry.updatedAt}${controller}\n  ${invalidRunRecovery(entry.runId, entry)}\n`,
            );
            continue;
          }
          const state = entry.state;
          process.stdout.write(`${humanRunStatus(state, store.controllerLease(state.runId))}\n`);
        }
      }
    });
  });

program
  .command("unlock")
  .description("force-release a run controller lease after verifying its reported owner")
  .argument("<run-id>")
  .requiredOption("--owner-pid <pid>", "current owner PID reported by epicd", positiveInteger)
  .requiredOption("--lease-id <id>", "opaque lease identity reported by epicd")
  .requiredOption("--force", "acknowledge that this can allow a second controller")
  .action(async (runId: string, options: { ownerPid: number; leaseId: string }) => {
    await withStateStore((store) => {
      const released = store.forceReleaseLease(runId, options.ownerPid, options.leaseId);
      process.stdout.write(
        released
          ? `Released the controller lease for ${runId}. This did not stop process ${options.ownerPid}.\n`
          : `Run ${runId} has no controller lease.\n`,
      );
    });
  });

program
  .command("cleanup")
  .description("explicitly abandon agent cleanup that cannot be completed")
  .argument("<run-id>")
  .requiredOption("--abandon", "acknowledge that external agent resources may remain open")
  .action(async (runId: string) => {
    await withStateStore((store) => {
      const result = store.abandonAgentCleanup(runId);
      process.stdout.write(
        result.abandonedActions > 0
          ? `Abandoned ${result.abandonedActions} cleanup action(s) for ${runId}. External agent resources may remain open.\n`
          : `Cleared the completed cleanup diagnostic for ${runId}.\n`,
      );
    });
  });

program
  .command("quarantine")
  .description("quarantine an invalid persisted run so it no longer owns its epic or repository")
  .argument("<run-id>")
  .requiredOption(
    "--force",
    "acknowledge that invalid state cannot be used to clean up external agent resources",
  )
  .action(async (runId: string) => {
    await withStateStore((store) => {
      const result = store.quarantineInvalidRun(runId);
      process.stdout.write(
        `Quarantined invalid run ${runId} (${result.reason}). Its raw state and events remain in the local state database; external agent resources may remain open.\n`,
      );
    });
  });

program
  .command("doctor")
  .description("check repository, Beads, Git, and selected runtime prerequisites")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: { json?: boolean }, command: Command) => {
    const common = commonOptions(command);
    const result = await runDoctor(common.repo, common.runtime ?? "sdk", {
      probeModelDiscovery: true,
      ...(common.codexPath ? { codexPath: common.codexPath } : {}),
    });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const check of result.checks) {
        const symbol = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "×";
        process.stdout.write(`${symbol} ${check.name}: ${check.message}\n`);
      }
    }
    if (result.checks.some((check) => check.status === "fail")) process.exitCode = 1;
  });

await program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`epicd: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
