#!/usr/bin/env node
import process from "node:process";
import { resolve } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { render } from "ink";
import React from "react";
import { BeadsClient } from "./adapters/beads.js";
import { GitClient } from "./adapters/git.js";
import { StateStore } from "./adapters/store.js";
import { runDoctor } from "./doctor.js";
import { EpicEngine } from "./engine/engine.js";
import type { EpicEngineOptions } from "./engine/engine.js";
import { EpicdApp } from "./tui/app.js";
import { RunView } from "./tui/run-view.js";
import { ReasoningEffortSchema, type ReasoningEffort, type RuntimeKind } from "./domain/types.js";
import type { PickerItem } from "./tui/picker.js";

type CommonOptions = {
  repo: string;
  model?: string;
  reasoning?: ReasoningEffort;
  orchestratorModel?: string;
  orchestratorReasoning?: ReasoningEffort;
  implementationModel?: string;
  implementationReasoning?: ReasoningEffort;
  reviewModel?: string;
  reviewReasoning?: ReasoningEffort;
  runtime?: RuntimeKind;
  maxReviewPasses?: number;
};

function commonOptions(command: Command): CommonOptions {
  const options = command.optsWithGlobals<CommonOptions>();
  return options;
}

function agentOptions(
  options: CommonOptions,
): Pick<EpicEngineOptions, "model" | "reasoningEffort" | "agentSettings"> {
  const orchestrator = {
    ...(options.orchestratorModel ? { model: options.orchestratorModel } : {}),
    ...(options.orchestratorReasoning ? { reasoningEffort: options.orchestratorReasoning } : {}),
  };
  const implementation = {
    ...(options.implementationModel ? { model: options.implementationModel } : {}),
    ...(options.implementationReasoning
      ? { reasoningEffort: options.implementationReasoning }
      : {}),
  };
  const review = {
    ...(options.reviewModel ? { model: options.reviewModel } : {}),
    ...(options.reviewReasoning ? { reasoningEffort: options.reviewReasoning } : {}),
  };
  const agentSettings = {
    ...(Object.keys(orchestrator).length > 0 ? { orchestrator } : {}),
    ...(Object.keys(implementation).length > 0 ? { implementation } : {}),
    ...(Object.keys(review).length > 0 ? { review } : {}),
  };
  return {
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoning ? { reasoningEffort: options.reasoning } : {}),
    ...(Object.keys(agentSettings).length > 0 ? { agentSettings } : {}),
  };
}

function reviewLoopOptions(options: CommonOptions): Pick<EpicEngineOptions, "maxReviewPasses"> {
  return options.maxReviewPasses === undefined ? {} : { maxReviewPasses: options.maxReviewPasses };
}

function resumeEngine(
  state: Parameters<typeof EpicEngine.resume>[0],
  options: CommonOptions,
  store: StateStore,
): EpicEngine {
  return EpicEngine.resume(
    state,
    {
      ...agentOptions(options),
      ...reviewLoopOptions(options),
      ...(options.runtime ? { runtime: options.runtime } : {}),
    },
    store,
  );
}

async function launchEngine(engine: EpicEngine, interactive = process.stdout.isTTY): Promise<void> {
  if (interactive) {
    await render(<RunView engine={engine} />, { exitOnCtrlC: false }).waitUntilExit();
    return;
  }
  engine.onEvent((event) => {
    process.stdout.write(
      `${event.at} ${event.level.toUpperCase()} ${event.message}${event.detail ? ` — ${event.detail}` : ""}\n`,
    );
  });
  const result = await engine.run();
  if (result.phase !== "complete") process.exitCode = 1;
}

async function createOrReject(
  epicId: string,
  options: CommonOptions,
  store: StateStore,
): Promise<EpicEngine> {
  const repoPath = resolve(options.repo);
  const root = await new GitClient(repoPath).root();
  const existing = store.findLatest(root, epicId);
  if (existing && existing.phase !== "complete") {
    throw new Error(
      `An existing ${existing.phase} run already owns ${epicId}. Use: epicd resume ${epicId} --repo ${root}`,
    );
  }
  return await EpicEngine.create(
    {
      repoPath: root,
      epicId,
      runtime: options.runtime ?? "sdk",
      ...agentOptions(options),
      ...reviewLoopOptions(options),
    },
    store,
  );
}

async function defaultTui(epicId: string | undefined, options: CommonOptions): Promise<void> {
  const root = await new GitClient(resolve(options.repo)).root();
  const store = new StateStore();
  const directRun = epicId ? store.findLatest(root, epicId) : null;
  const runtime = options.runtime ?? directRun?.runtime ?? "sdk";
  const doctor = await runDoctor(root, runtime);
  const failed = doctor.checks.filter((check) => check.status === "fail");
  if (failed.length > 0)
    throw new Error(failed.map((check) => `${check.name}: ${check.message}`).join("\n"));
  if (epicId) {
    const existing = directRun;
    const engine =
      existing && existing.phase !== "complete"
        ? resumeEngine(existing, options, store)
        : await EpicEngine.create(
            {
              repoPath: doctor.repoPath,
              epicId,
              runtime,
              ...agentOptions(options),
              ...reviewLoopOptions(options),
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
    run: store.findLatest(doctor.repoPath, epic.id),
  }));
  if (items.length === 0) throw new Error("No open Beads epics were found in this repository");
  await render(
    <EpicdApp
      items={items}
      loadEngine={async (item) => {
        if (item.run && item.run.phase !== "complete")
          return resumeEngine(item.run, options, store);
        return await EpicEngine.create(
          {
            repoPath: doctor.repoPath,
            epicId: item.epic.id,
            runtime,
            ...agentOptions(options),
            ...reviewLoopOptions(options),
          },
          store,
        );
      }}
    />,
    { exitOnCtrlC: false },
  ).waitUntilExit();
}

function reasoningOption(flags: string, description: string): Option {
  return new Option(flags, description).choices(ReasoningEffortSchema.options);
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
  .option("--model <model>", "model fallback for all agent roles")
  .addOption(reasoningOption("--reasoning <effort>", "reasoning fallback for all agent roles"))
  .option("--orchestrator-model <model>", "orchestrator model override")
  .addOption(
    reasoningOption("--orchestrator-reasoning <effort>", "orchestrator reasoning override"),
  )
  .option("--implementation-model <model>", "implementation model override")
  .addOption(
    reasoningOption("--implementation-reasoning <effort>", "implementation reasoning override"),
  )
  .option("--review-model <model>", "review model override")
  .addOption(reasoningOption("--review-reasoning <effort>", "review reasoning override"))
  .addOption(
    new Option(
      "--max-review-passes <count>",
      "maximum fix passes per review cycle for new runs (default: 3)",
    ).argParser(positiveInteger),
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
    const doctor = await runDoctor(common.repo, common.runtime ?? "sdk");
    const failed = doctor.checks.filter((check) => check.status === "fail");
    if (failed.length > 0)
      throw new Error(failed.map((check) => `${check.name}: ${check.message}`).join("\n"));
    const store = new StateStore();
    const engine = await createOrReject(epicId, common, store);
    await launchEngine(engine, options.tui && process.stdout.isTTY);
  });

program
  .command("resume")
  .description("resume the latest recoverable run for an epic")
  .argument("<epic-id>")
  .option("--no-tui", "stream line-oriented events")
  .action(async (epicId: string, options: { tui: boolean }, command: Command) => {
    const common = commonOptions(command);
    const root = await new GitClient(resolve(common.repo)).root();
    const store = new StateStore();
    const state = store.findLatest(root, epicId);
    if (!state) throw new Error(`No epicd run found for ${epicId}`);
    if (state.phase === "complete") throw new Error(`${epicId} is already complete`);
    const doctor = await runDoctor(root, common.runtime ?? state.runtime);
    const failed = doctor.checks.filter((check) => check.status === "fail");
    if (failed.length > 0)
      throw new Error(failed.map((check) => `${check.name}: ${check.message}`).join("\n"));
    const engine = resumeEngine(state, common, store);
    engine.continueRun();
    await launchEngine(engine, options.tui && process.stdout.isTTY);
  });

program
  .command("status")
  .description("show persisted epic run status")
  .argument("[epic-id]")
  .option("--json", "emit machine-readable JSON")
  .action(async (epicId: string | undefined, options: { json?: boolean }, command: Command) => {
    const common = commonOptions(command);
    const repoPath = await new GitClient(resolve(common.repo)).root();
    const store = new StateStore();
    const states = epicId
      ? [store.findLatest(repoPath, epicId)].filter(Boolean)
      : store.list(repoPath);
    if (options.json) process.stdout.write(`${JSON.stringify(states, null, 2)}\n`);
    else if (states.length === 0) process.stdout.write("No epicd runs found.\n");
    else {
      for (const state of states) {
        if (!state) continue;
        process.stdout.write(
          `${state.epicId}\n  ${state.phase} · ${state.runtime} · ${state.completedTasks}/${state.totalTasks} tasks · updated ${state.updatedAt}\n`,
        );
      }
    }
  });

program
  .command("doctor")
  .description("check repository, Beads, Git, and selected runtime prerequisites")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: { json?: boolean }, command: Command) => {
    const common = commonOptions(command);
    const result = await runDoctor(common.repo, common.runtime ?? "sdk");
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
