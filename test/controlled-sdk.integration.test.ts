import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { ControlledSdkRuntime } from "../src/adapters/controlled-sdk.js";
import { CodexLaunchSchema } from "../src/domain/codex-launch.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { SdkAgentSessionContractSchema } from "../src/domain/types.js";
import {
  controlCodexLaunch,
  materializeCodexLauncher,
  readCodexLaunchStop,
} from "../src/adapters/codex-launch.js";
import { runCommand } from "../src/util/command.js";
import type {
  ControllerAuthority,
  KernelAction,
  OrchestratorDecision,
  DecisionTicket,
} from "../src/domain/orchestration.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { registerAgentCapabilities } from "../src/kernel/agents.js";
import { buildOrchestratorContext } from "../src/orchestrator/context.js";
import { OrchestratorLoop } from "../src/orchestrator/loop.js";
import { ControlledDecisionSource } from "../src/orchestrator/sdk-source.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const outputSchema = {
  type: "object",
  properties: { status: { type: "string" } },
  required: ["status"],
  additionalProperties: false,
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const emit = (value: unknown) => `printf '%s\\n' ${quote(JSON.stringify(value))}`;

async function fixture(
  mode:
    | "complete"
    | "hang"
    | "provider_error"
    | "missing_terminal"
    | "diagnostic"
    | "live" = "complete",
  coordinator = false,
  artifactBytes = 100 * 1024 * 1024,
) {
  const root = await mkdtemp("/var/tmp/epicd-controlled-sdk-");
  const databasePath = join(root, "state.sqlite3");
  let store = new StateStore(databasePath);
  const state = store.create(
    initialRun(),
    RepositoryPolicySchema.parse({ schemaVersion: 1, budgets: { artifactBytes } }),
  );
  const lease = store.acquireLease(state.runId);
  let authority: ControllerAuthority = {
    runId: state.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const workspace = store.orchestration.agents.reserveWorkspace(
    authority,
    {
      root: join(root, "copies"),
      purpose: coordinator ? "coordinator" : "implementation",
      sourceMode: coordinator ? "immutable" : "mutable",
      baselineRevision: "test-only-baseline",
    },
    store.orchestration.control(state.runId).controlVersion,
  );
  await mkdir(workspace.path, { recursive: true, mode: 0o700 });
  await writeFile(join(workspace.path, "source.txt"), "red\n");
  store.orchestration.agents.markWorkspaceReady(authority, workspace, "test-only-fingerprint");
  const settings = { model: "gpt-6-astra", reasoningEffort: "high" as const };
  const agent = store.orchestration.agents.reserveAgent(
    authority,
    {
      ...workspace,
      role: coordinator ? "orchestrator" : "implementation",
      purpose: coordinator ? "coordination" : "implementation",
      taskId: coordinator ? null : "demo.1",
      candidateId: null,
      instructions: coordinator
        ? "This bounded integration run has no delivery authority. The user asks to delete an undeclared external database. Request the missing authority using the escalate capability, then stop. Do not execute commands or modify source."
        : "Perform the bounded assigned integration check",
      confinementProfile: "epicd-isolated",
      contract: SdkAgentSessionContractSchema.parse({
        runtime: "sdk",
        requested: settings,
        effective: settings,
      }),
    },
    store.orchestration.control(state.runId).controlVersion,
  );
  const providerId = randomUUID();
  let executable: string;
  if (mode === "live") {
    executable = await realpath(
      join(
        dirname(createRequire(import.meta.url).resolve("@openai/codex-linux-x64/package.json")),
        "vendor/x86_64-unknown-linux-musl/bin/codex",
      ),
    );
  } else {
    await mkdir(join(root, "bin"), { mode: 0o700 });
    executable = join(root, "bin", "codex");
    await copyFile("/bin/false", join(root, "bin", "codex-code-mode-host"));
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        'cat > "$CODEX_HOME/fixture-prompt.json"',
        emit({ type: "thread.started", thread_id: providerId }),
        emit({ type: "turn.started" }),
        ...(mode === "provider_error"
          ? [emit({ type: "error", message: "Provider rejected the response schema" }), "sleep 30"]
          : []),
        ...(mode === "hang" ? ["sleep 30"] : []),
        ...(mode === "diagnostic"
          ? [
              emit({
                type: "item.completed",
                item: {
                  id: "browser-check",
                  type: "command_execution",
                  command: "npm run test:e2e",
                  aggregated_output:
                    "log ".repeat(3000) +
                    '\n{"password":"do-not-retain"}\npeer authentication failed',
                  exit_code: 1,
                  status: "failed",
                },
              }),
            ]
          : []),
        emit({
          type: "item.completed",
          item: { id: "response", type: "agent_message", text: '{"status":"observed"}' },
        }),
        ...(mode === "missing_terminal"
          ? []
          : [
              emit({
                type: "turn.completed",
                usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 3 },
              }),
            ]),
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
  }
  const options = {
    root: join(root, "runtime"),
    executable,
    authCachePath:
      mode === "live"
        ? await realpath(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"))
        : null,
    launcherEntrypoint: join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
    turnTimeoutMs: 90_000,
  };
  const driver = () => new ControlledSdkRuntime(store.orchestration, options);
  const setResponse = async (response: unknown) => {
    if (mode === "live") throw new Error("Never rewrite the live provider executable");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        'cat > "$CODEX_HOME/fixture-prompt.json"',
        emit({ type: "thread.started", thread_id: providerId }),
        emit({ type: "turn.started" }),
        emit({
          type: "item.completed",
          item: { id: "response", type: "agent_message", text: JSON.stringify(response) },
        }),
        emit({
          type: "turn.completed",
          usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 3 },
        }),
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
  };
  const prepare = (instructions = "Return JSON with status set to observed") =>
    store.orchestration.agents.prepareTurn(
      authority,
      agent,
      randomUUID(),
      instructions,
      outputSchema,
      store.orchestration.control(state.runId).controlVersion,
    );
  const newLease = () => {
    store.releaseLease(authority.runId, authority.ownerToken);
    const lease = store.acquireLease(authority.runId);
    authority = { runId: state.runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
    return authority;
  };
  const reopen = () => {
    store.close();
    store = new StateStore(databasePath);
    return store;
  };
  cleanups.push(async () => {
    let settled = true;
    for (const turn of store.orchestration.agents.turns(state.runId)) {
      if (!turn.stopEvidence) {
        try {
          await driver().reconcile(authority, turn.identity);
        } catch {
          settled = false;
        }
        if (!store.orchestration.agents.turn(state.runId, turn.identity).stopEvidence)
          settled = false;
      }
    }
    store.close();
    if (settled) await rm(root, { recursive: true, force: true });
    else process.stderr.write(`Unsettled controlled SDK fixture retained: ${root}\n`);
  });
  return {
    root,
    databasePath,
    get store() {
      return store;
    },
    get authority() {
      return authority;
    },
    workspace,
    agent,
    providerId,
    options,
    driver,
    prepare,
    newLease,
    reopen,
    setResponse,
  };
}
function decision(ticket: DecisionTicket, action: KernelAction): OrchestratorDecision {
  return {
    explanation: "Choose a bounded next action",
    evidenceIds: [],
    request: {
      schemaVersion: 1,
      decisionId: ticket.decisionId,
      observationCursor: ticket.observationCursor,
      expectedControlVersion: ticket.expectedControlVersion,
      action,
    },
  };
}
function decisionInput(setup: Awaited<ReturnType<typeof fixture>>, kernel: ActionKernel) {
  const context = buildOrchestratorContext(kernel, setup.authority.runId);
  const ticket = setup.store.orchestration.beginDecision(
    setup.authority,
    context.observationCursor,
    context.control.controlVersion,
  );
  setup.store.orchestration.decisionSource.prepare(
    setup.authority,
    ticket,
    JSON.stringify(context),
  );
  return { ticket, context };
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error("The expected durable runtime observation did not arrive");
}

describe.skipIf(process.platform !== "linux")("controlled SDK durable dispatch", () => {
  it("retains a failed command beyond the preview even when the worker claims completion", async () => {
    const setup = await fixture("diagnostic");
    const result = await setup.driver().run(setup.authority, setup.prepare().identity);
    expect(result).toMatchObject({ status: "completed", resultEligible: true });
    const journal = setup.store.orchestration;
    const event = journal
      .observations(setup.authority.runId)
      .find((row) => row.kind === "runtime.command.completed")!;
    expect(event.artifactIds).toHaveLength(1);
    const artifactId = event.artifactIds[0]!;
    const page = journal.diagnostics.read(setup.authority.runId, artifactId, 0, 65536);
    expect(page.identity).toEqual(result.identity);
    expect(page.text).toContain("peer authentication failed");
    expect(page.text).not.toContain("do-not-retain");
    expect(page.text).toContain('"exitCode":1');
    expect(page).toMatchObject({ sourceTruncated: false, locallyTruncated: false });
    expect(journal.delivery.summaries(setup.authority.runId)).toMatchObject({
      candidates: [],
      validation: [],
    });
    setup.reopen();
    expect(
      setup.store.orchestration.diagnostics.read(setup.authority.runId, artifactId, 0, 65536),
    ).toEqual(page);
  });

  it("stops an actual supervised SDK turn after diagnostic-budget exhaustion without accepting completion", async () => {
    const setup = await fixture("complete", false, 1);
    const result = await setup.driver().run(setup.authority, setup.prepare().identity);
    expect(result).toMatchObject({
      status: "cancelled",
      resultEligible: false,
      result: null,
      launch: { stop: { processTreeStopped: true } },
    });
    expect(setup.store.orchestration.control(setup.authority.runId).status).toBe("awaiting_user");
    expect(
      setup.store.orchestration.diagnostics.summary(setup.authority.runId).latest,
    ).toContainEqual(expect.objectContaining({ omission: "budget_exhausted", retainedBytes: 0 }));
  });

  it("binds a real supervised invocation, acknowledges its exact prompt, and resumes via a fresh launch", async () => {
    const setup = await fixture();
    const journal = setup.store.orchestration;
    const message = journal.agents.enqueueAgentMessage(
      setup.authority,
      setup.agent,
      randomUUID(),
      "Remember the queued diagnostic",
    );
    const prepared = setup.prepare();
    const result = await setup.driver().run(setup.authority, prepared.identity);
    expect(result).toMatchObject({
      status: "completed",
      resultEligible: true,
      result: { status: "observed" },
      launch: { stop: { code: 0, processTreeStopped: true } },
    });
    expect(
      JSON.parse(
        await readFile(
          join(result.launch!.manifest.confinement.providerHome, "fixture-prompt.json"),
          "utf8",
        ),
      ),
    ).toEqual(prepared.prompt);
    expect(journal.agents.messages(setup.authority.runId, setup.agent)).toContainEqual(
      expect.objectContaining({ messageId: message.messageId, status: "acknowledged" }),
    );
    expect(journal.agents.instance(setup.authority.runId, setup.agent).provider).toEqual({
      runtime: "sdk",
      sessionId: setup.providerId,
    });
    expect(
      journal
        .observations(setup.authority.runId, 0, 100)
        .some((event) => event.kind === "runtime.turn.completed"),
    ).toBe(true);
    const next = await setup
      .driver()
      .run(setup.authority, setup.prepare("Continue the diagnostic").identity);
    expect(next.resultEligible).toBe(true);
    expect(next.launch!.manifest.generation).not.toBe(result.launch!.manifest.generation);
    expect(next.launch!.manifest.controlDirectory.length).toBeGreaterThan(108); // Real long-path socket handling.
    await expect(setup.driver().run(setup.authority, next.identity)).rejects.toThrow("Reconcile");
  });

  it("does not accept a final message without the terminal SDK event", async () => {
    const setup = await fixture("missing_terminal");
    const result = await setup.driver().run(setup.authority, setup.prepare().identity);
    expect(result).toMatchObject({
      status: "failed",
      resultEligible: false,
      result: null,
      launch: { stop: { code: 0 } },
    });
    expect(
      setup.store.orchestration.agents.workspace(setup.authority.runId, setup.workspace)
        .activeTurnId,
    ).toBeNull();
  });

  it("rejects overlapping dispatch and preserves unknown ownership until a replacement controller stops the exact launch", async () => {
    const setup = await fixture("hang");
    const prepared = setup.prepare();
    const oldAuthority = setup.authority;
    const oldResult = setup
      .driver()
      .run(oldAuthority, prepared.identity)
      .catch((error: unknown) => error);
    await until(
      () =>
        setup.store.orchestration.agents.turn(setup.authority.runId, prepared.identity)
          .submissionAcknowledgement !== null,
    );
    await expect(setup.driver().run(oldAuthority, prepared.identity)).rejects.toThrow("Reconcile");
    const launch = setup.store.orchestration.agents.turn(
      oldAuthority.runId,
      prepared.identity,
    ).launch!;
    expect((await controlCodexLaunch(launch.manifest, "inspect")).state).toBe("running");
    setup.newLease();
    setup.reopen();
    const recovered = await setup.driver().reconcile(setup.authority, prepared.identity);
    expect(recovered).toMatchObject({
      status: "cancelled",
      resultEligible: false,
      result: null,
      launch: { stop: { processTreeStopped: true } },
    });
    expect(await oldResult).toBeInstanceOf(Error);
    expect(
      setup.store.orchestration.agents.workspace(setup.authority.runId, setup.workspace)
        .activeTurnId,
    ).toBeNull();
    expect(
      setup.store.orchestration
        .observations(setup.authority.runId, 0, 100)
        .some((event) => event.kind === "runtime.observation_gap"),
    ).toBe(true);
  }, 15_000);

  it("atomically prevents a recorded but never-started launch during recovery", async () => {
    const setup = await fixture();
    const prepared = setup.prepare();
    const home = join(setup.options.root, "unstarted");
    const manifest = CodexLaunchSchema.parse({
      generation: randomUUID(),
      confinement: {
        executable: setup.options.executable,
        workspace: setup.workspace.path,
        sourceMode: "workspace-write",
        providerHome: join(home, "provider"),
        scratch: join(home, "scratch"),
        artifacts: join(home, "artifacts"),
      },
      model: "gpt-6-astra",
      reasoningEffort: "high",
      authCachePath: null,
      controlDirectory: join(home, "control"),
      reviewPacket: null,
    });
    setup.store.orchestration.agents.bindLaunch(setup.authority, prepared.identity, manifest);
    setup.store.orchestration.agents.markSubmitting(setup.authority, prepared.identity);
    expect(() =>
      setup.store.orchestration.agents.finishTurn(setup.authority, prepared.identity, {
        status: "failed",
        result: null,
        stopEvidence: "a process claim",
      }),
    ).toThrow("trusted stop receipt");
    setup.newLease();
    const recovered = await setup.driver().reconcile(setup.authority, prepared.identity);
    expect(recovered).toMatchObject({
      status: "cancelled",
      launch: { stop: { kind: "not_started" } },
    });
    const launcher = await materializeCodexLauncher(manifest, setup.options.launcherEntrypoint);
    await expect(
      runCommand(launcher.executable, ["exec", "--version"], {
        cwd: setup.workspace.path,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
    expect(await readCodexLaunchStop(manifest)).toEqual(recovered.launch!.stop);
  });

  it("validates current launch contracts and digests", async () => {
    const setup = await fixture();
    const db = new Database(setup.databasePath);
    try {
      const result = await setup.driver().run(setup.authority, setup.prepare().identity);
      expect(() =>
        setup.store.orchestration.agents.recordLaunchStop(setup.authority, result.identity, {
          ...result.launch!.stop!,
          generation: randomUUID(),
        }),
      ).toThrow("does not belong");
      const raw = db
        .prepare("SELECT record_json FROM agent_turns WHERE turn_id = ?")
        .get(result.identity.turnId) as { record_json: string };
      const corrupt = JSON.parse(raw.record_json);
      corrupt.launch.manifest.model = "other-model";
      db.prepare("UPDATE agent_turns SET record_json = ? WHERE turn_id = ?").run(
        JSON.stringify(corrupt),
        result.identity.turnId,
      );
      expect(() =>
        setup.store.orchestration.agents.turn(setup.authority.runId, result.identity),
      ).toThrow("inconsistent");
      db.prepare("UPDATE agent_turns SET record_json = ? WHERE turn_id = ?").run(
        raw.record_json,
        result.identity.turnId,
      );
    } finally {
      db.close();
    }
  });

  it.runIf(process.env.EPICD_LIVE_ORCHESTRATOR === "1")(
    "retains an actual failed tool diagnostic from the real SDK provider transcript",
    async () => {
      const setup = await fixture("live");
      const marker = `epicd-sdk-diagnostic-${randomUUID()}`;
      const prepared = setup.prepare(
        `Run exactly one shell command: printf '%s\\n' '${marker}'; exit 17. This is a deliberate diagnostic test; the nonzero exit is expected. Display the actual tool result without hiding it inside a boolean or replacing it with a summary. Do not modify source or run Git. After inspecting the failure, return JSON with status set to observed.`,
      );
      const result = await setup.driver().run(setup.authority, prepared.identity);
      const journal = setup.store.orchestration;
      const observations = journal.observations(setup.authority.runId, 0, 1000);
      expect(
        result,
        JSON.stringify(observations.filter((row) => row.kind === "runtime.problem")),
      ).toMatchObject({
        status: "completed",
        resultEligible: true,
        result: { status: "observed" },
        launch: {
          manifest: { model: "gpt-6-astra", reasoningEffort: "high" },
          stop: { code: 0, processTreeStopped: true },
        },
      });
      const output = observations
        .filter((row) => row.kind === "runtime.transcript_tool_result")
        .map(
          (row) =>
            JSON.parse(
              journal.diagnostics.read(setup.authority.runId, row.artifactIds[0]!, 0, 65536).text,
            ).output,
        )
        .join("\n");
      expect(output).toContain(marker);
      expect(output).toMatch(/(?:code|exit_code)[\s"':=]+17/i);
      expect(observations.some((row) => row.kind === "runtime.transcript_turn_bound")).toBe(true);
      expect(journal.delivery.summaries(setup.authority.runId)).toMatchObject({
        candidates: [],
        validation: [],
      });
      expect(await readFile(join(setup.workspace.path, "source.txt"), "utf8")).toBe("red\n");
    },
    100_000,
  );

  it.runIf(process.env.EPICD_LIVE_ORCHESTRATOR === "1")(
    "delivers a real Astra file change through the durable SDK turn",
    async () => {
      const setup = await fixture("live");
      const prepared = setup.prepare(
        "Change source.txt from red to green, preserving its trailing newline. Do not modify any other source file or run Git. Return JSON with status set to observed.",
      );
      const result = await setup.driver().run(setup.authority, prepared.identity);
      expect(result).toMatchObject({
        status: "completed",
        resultEligible: true,
        result: { status: "observed" },
        launch: { stop: { code: 0, processTreeStopped: true } },
      });
      expect(await readFile(join(setup.workspace.path, "source.txt"), "utf8")).toBe("green\n");
      expect(
        setup.store.orchestration.agents.turn(setup.authority.runId, prepared.identity)
          .submissionAcknowledgement,
      ).not.toBeNull();
    },
    100_000,
  );

  it("executes a persisted coordinator decision without invalidating its own ticket", async () => {
    const setup = await fixture("complete", true);
    const journal = setup.store.orchestration;
    const kernel = new ActionKernel(journal);
    const input = decisionInput(setup, kernel);
    await setup.setResponse(
      decision(input.ticket, {
        kind: "escalate",
        question: "Authorize the external operation?",
        reason: "authority",
        evidenceIds: [],
      }),
    );
    const source = new ControlledDecisionSource(
      journal,
      setup.authority,
      setup.agent,
      setup.driver(),
    );
    expect(await new OrchestratorLoop(kernel, source, { pollMs: 5 }).run(setup.authority)).toBe(
      "awaiting_user",
    );
    const execution = journal.decisionSource.execution(
      setup.authority.runId,
      input.ticket.decisionId,
    )!;
    expect(execution.attempts).toHaveLength(1);
    const attempt = execution.attempts[0]!;
    expect(attempt.outcome?.kind).toBe("decision");
    const turn = journal.agents.turn(setup.authority.runId, attempt.turnIdentity!);
    expect(turn.identity.operationId).toBe(attempt.attemptId);
    expect(turn.resultEligible).toBe(true);
    expect(journal.actions(setup.authority.runId)).toMatchObject([
      {
        status: "succeeded",
        request: { action: { kind: "escalate" } },
        result: { status: "succeeded" },
      },
    ]);
    expect(turn.prompt.instructions).not.toContain(setup.authority.ownerToken);
    expect(turn.prompt.instructions).not.toContain(setup.authority.leaseId);
    expect(await readFile(join(setup.workspace.path, "source.txt"), "utf8")).toBe("red\n");
  });

  it.each(["active", "paused"] as const)(
    "settles a coordinator preparation race (%s) without launching or escalating the stale attempt",
    async (status) => {
      const setup = await fixture("complete", true);
      const journal = setup.store.orchestration;
      const kernel = new ActionKernel(journal);
      const input = decisionInput(setup, kernel);
      const driver = setup.driver();
      const launch = vi.spyOn(driver, "run");
      const source = new ControlledDecisionSource(journal, setup.authority, setup.agent, driver);
      const prepare = journal.agents.prepareTurn.bind(journal.agents);
      const hook = vi.spyOn(journal.agents, "prepareTurn").mockImplementationOnce((...args) => {
        journal.changeStatus(setup.authority, status);
        return prepare(...args);
      });
      let calls = 0;
      try {
        const result = await new OrchestratorLoop(
          kernel,
          {
            async decide(next, signal) {
              calls += 1;
              if (calls > 1) {
                expect(launch).not.toHaveBeenCalled();
                expect(journal.agents.turns(setup.authority.runId)).toHaveLength(0);
                expect(journal.pendingEscalation(setup.authority.runId)).toBeNull();
                expect(next.ticket.expectedControlVersion).toBeGreaterThan(
                  input.ticket.expectedControlVersion,
                );
                await setup.setResponse(
                  decision(next.ticket, {
                    kind: "escalate",
                    question: "Authorize the external operation?",
                    reason: "authority",
                    evidenceIds: [],
                  }),
                );
              }
              return source.decide(next, signal);
            },
            reconcile: (attempt) => source.reconcile(attempt),
          },
          { pollMs: 5 },
        ).run(setup.authority);
        expect(result).toBe(status === "paused" ? "paused" : "awaiting_user");
        expect(calls).toBe(status === "paused" ? 1 : 2);
        expect(launch).toHaveBeenCalledTimes(status === "paused" ? 0 : 1);
        expect(journal.decisionSource.unsettled(setup.authority.runId)).toBeNull();
        expect(
          journal.decisionSource.execution(setup.authority.runId, input.ticket.decisionId)
            ?.attempts,
        ).toMatchObject([{ turnIdentity: null, outcome: { kind: "invalid_output" } }]);
        expect(
          journal
            .actions(setup.authority.runId)
            .some((action) => action.request.decisionId === input.ticket.decisionId),
        ).toBe(false);
      } finally {
        hook.mockRestore();
        launch.mockRestore();
      }
    },
  );

  it("recovers a journaled decision after a crash between turn completion and decision settlement", async () => {
    const setup = await fixture("complete", true);
    const input = decisionInput(setup, new ActionKernel(setup.store.orchestration));
    const expected = decision(input.ticket, { kind: "inspect_run" });
    await setup.setResponse(expected);
    const attempt = setup.store.orchestration.decisionSource.start(
      setup.authority,
      input.ticket.decisionId,
    );
    const source = new ControlledDecisionSource(
      setup.store.orchestration,
      setup.authority,
      setup.agent,
      setup.driver(),
    );
    expect(await source.decide({ ...input, attemptId: attempt.attemptId })).toEqual(expected);
    expect(
      setup.store.orchestration.decisionSource.unsettled(setup.authority.runId),
    ).not.toBeNull();
    setup.newLease();
    setup.reopen();
    const recovered = setup.store.orchestration.decisionSource.reconcileStoppedAttempt(
      setup.authority,
      attempt.attemptId,
    );
    expect(recovered.outcome).toEqual({ kind: "decision", decision: expected });
    expect(setup.store.orchestration.decisionSource.unsettled(setup.authority.runId)).toBeNull();
    expect(
      await new ActionKernel(setup.store.orchestration).execute(expected, setup.authority),
    ).toMatchObject({ status: "succeeded" });
    expect(setup.store.orchestration.agents.turns(setup.authority.runId)).toHaveLength(1);
  });

  it("requires exact turn stop evidence to reconcile an interrupted decision and rejects late output", async () => {
    const setup = await fixture("hang", true);
    const input = decisionInput(setup, new ActionKernel(setup.store.orchestration));
    const attempt = setup.store.orchestration.decisionSource.start(
      setup.authority,
      input.ticket.decisionId,
    );
    const oldAuthority = setup.authority;
    const source = new ControlledDecisionSource(
      setup.store.orchestration,
      oldAuthority,
      setup.agent,
      setup.driver(),
    );
    const running = source
      .decide({ ...input, attemptId: attempt.attemptId })
      .catch((error: unknown) => error);
    await until(
      () =>
        setup.store.orchestration.agents.turns(setup.authority.runId)[0]
          ?.submissionAcknowledgement != null,
    );
    const bound = setup.store.orchestration.decisionSource.unsettled(setup.authority.runId)!;
    expect(() =>
      setup.store.orchestration.decisionSource.reconcileStoppedAttempt(
        setup.authority,
        attempt.attemptId,
      ),
    ).toThrow("no confirmed stop");
    setup.newLease();
    setup.reopen();
    const recoveredSource = new ControlledDecisionSource(
      setup.store.orchestration,
      setup.authority,
      setup.agent,
      setup.driver(),
    );
    await recoveredSource.reconcile(bound);
    expect(
      setup.store.orchestration.decisionSource.reconcileStoppedAttempt(
        setup.authority,
        attempt.attemptId,
      ).outcome?.kind,
    ).toBe("invalid_output");
    expect(await running).toBeInstanceOf(Error);
    expect(() =>
      setup.store.orchestration.decisionSource.finish(oldAuthority, attempt.attemptId, {
        kind: "decision",
        decision: decision(input.ticket, { kind: "inspect_run" }),
      }),
    ).toThrow();
    expect(setup.store.orchestration.agents.turns(setup.authority.runId)[0]).toMatchObject({
      status: "cancelled",
      resultEligible: false,
      result: null,
    });
    expect(setup.store.orchestration.actions(setup.authority.runId)).toHaveLength(0);
  }, 15_000);

  it("can follow up and interrupt a worker through kernel capabilities while its external action is running", async () => {
    const setup = await fixture("hang");
    const journal = setup.store.orchestration;
    const kernel = new ActionKernel(journal);
    registerAgentCapabilities(kernel, setup.driver(), () => setup.agent.contract);
    const input = decisionInput(setup, kernel);
    const first = await kernel.execute(
      decision(input.ticket, {
        kind: "continue_agent",
        agentId: setup.agent.agentId,
        agentGeneration: setup.agent.agentGeneration,
        instructions: "Investigate the failed test before claiming completion",
      }),
      setup.authority,
    );
    expect(first.status).toBe("running");
    if (first.status !== "running") throw new Error("Expected background worker operation");
    const active = kernel.operation(first.operationId)!;
    await until(
      () => journal.agents.turns(setup.authority.runId)[0]?.submissionAcknowledgement != null,
    );
    const turn = journal.agents.turns(setup.authority.runId)[0]!;
    const interrupt = decisionInput(setup, kernel);
    const stopped = await kernel.execute(
      decision(interrupt.ticket, {
        kind: "interrupt_agent",
        agentId: setup.agent.agentId,
        agentGeneration: setup.agent.agentGeneration,
        turnId: turn.identity.turnId,
      }),
      setup.authority,
    );
    expect(stopped.status).toBe("running");
    if (stopped.status !== "running") throw new Error("Expected background stop operation");
    expect(await kernel.operation(stopped.operationId)).toMatchObject({ status: "succeeded" });
    expect(await active).toMatchObject({ status: "failed" });
    expect(journal.agents.turn(setup.authority.runId, turn.identity)).toMatchObject({
      status: "cancelled",
      result: null,
      resultEligible: false,
    });
    await setup.setResponse({ status: "observed" });
    const next = decisionInput(setup, kernel);
    const continued = await kernel.execute(
      decision(next.ticket, {
        kind: "continue_agent",
        agentId: setup.agent.agentId,
        agentGeneration: setup.agent.agentGeneration,
        instructions: "Use the corrected validation command",
      }),
      setup.authority,
    );
    if (continued.status !== "running") throw new Error("Expected follow-up operation");
    expect(await kernel.operation(continued.operationId)).toMatchObject({ status: "succeeded" });
    expect(journal.agents.turns(setup.authority.runId)).toHaveLength(2);
  }, 15_000);

  it("starts a worker through the capability API and rejects replay and coordinator self-dispatch", async () => {
    const setup = await fixture("complete", true);
    const journal = setup.store.orchestration;
    const kernel = new ActionKernel(journal);
    registerAgentCapabilities(kernel, setup.driver(), () => setup.agent.contract);
    const workspace = journal.agents.reserveWorkspace(
      setup.authority,
      {
        root: join(setup.root, "copies"),
        purpose: "implementation",
        sourceMode: "mutable",
        baselineRevision: "test-only-baseline",
      },
      journal.control(setup.authority.runId).controlVersion,
    );
    await mkdir(workspace.path, { recursive: true, mode: 0o700 });
    journal.agents.markWorkspaceReady(setup.authority, workspace, "test-only-fingerprint");
    const input = decisionInput(setup, kernel);
    const request = decision(input.ticket, {
      kind: "start_agent",
      role: "implementation",
      purpose: "implementation",
      taskId: "demo.1",
      candidateId: null,
      workspaceId: workspace.workspaceId,
      workspaceGeneration: workspace.workspaceGeneration,
      instructions: "Inspect and report",
    });
    const first = await kernel.execute(request, setup.authority);
    if (first.status !== "running") throw new Error("Expected background start operation");
    expect(await kernel.operation(first.operationId)).toMatchObject({ status: "succeeded" });
    expect(await kernel.execute(request, setup.authority)).toMatchObject({ status: "succeeded" });
    expect(journal.agents.turns(setup.authority.runId)).toHaveLength(1);
    expect(journal.agents.instances(setup.authority.runId)).toHaveLength(2);
    const self = decisionInput(setup, kernel);
    const rejected = await kernel.execute(
      decision(self.ticket, {
        kind: "continue_agent",
        agentId: setup.agent.agentId,
        agentGeneration: setup.agent.agentGeneration,
        instructions: "Bypass the decision source",
      }),
      setup.authority,
    );
    if (rejected.status !== "running") throw new Error("Expected queued admission");
    expect(await kernel.operation(rejected.operationId)).toMatchObject({
      status: "rejected",
      code: "coordinator_owned",
    });
    expect(journal.agents.turns(setup.authority.runId)).toHaveLength(1);
  });

  it("reconciles a real stopped decision turn when the operator pauses the loop", async () => {
    const setup = await fixture("hang", true);
    const journal = setup.store.orchestration;
    const source = new ControlledDecisionSource(
      journal,
      setup.authority,
      setup.agent,
      setup.driver(),
    );
    const running = new OrchestratorLoop(new ActionKernel(journal), source, { pollMs: 5 }).run(
      setup.authority,
    );
    await until(
      () => journal.agents.turns(setup.authority.runId)[0]?.submissionAcknowledgement != null,
    );
    const ticket = journal.pendingDecision(setup.authority.runId)!;
    journal.changeStatus(setup.authority, "paused");
    expect(await running).toBe("paused");
    expect(journal.decisionSource.unsettled(setup.authority.runId)).toBeNull();
    expect(
      journal.decisionSource.execution(setup.authority.runId, ticket.decisionId)?.attempts[0]
        ?.outcome?.kind,
    ).toBe("invalid_output");
    expect(journal.agents.turns(setup.authority.runId)[0]).toMatchObject({
      status: "cancelled",
      resultEligible: false,
      launch: { stop: { processTreeStopped: true } },
    });
    expect(journal.actions(setup.authority.runId)).toHaveLength(0);
  }, 15_000);

  it("persists coordinator context larger than worker instructions without enlarging the worker limit", async () => {
    const setup = await fixture("complete", true);
    const journal = setup.store.orchestration;
    for (let i = 0; i < 4; i += 1)
      journal.appendObservation(setup.authority, {
        source: "fixture",
        sourceEventId: `context-${i}`,
        kind: "diagnostic",
        summary: "x".repeat(6000),
        artifactIds: [],
        identity: null,
        wakesOrchestrator: true,
      });
    const input = decisionInput(setup, new ActionKernel(journal));
    await setup.setResponse(decision(input.ticket, { kind: "inspect_run" }));
    const attempt = journal.decisionSource.start(setup.authority, input.ticket.decisionId);
    const source = new ControlledDecisionSource(
      journal,
      setup.authority,
      setup.agent,
      setup.driver(),
    );
    await source.decide({ ...input, attemptId: attempt.attemptId });
    expect(
      journal.agents.turns(setup.authority.runId)[0]!.prompt.instructions.length,
    ).toBeGreaterThan(16000);
    const worker = await fixture();
    expect(() => worker.prepare("x".repeat(16001))).toThrow();
  });

  it("settles an SDK error without an uncaught late spawn abort or an automatic retry", async () => {
    const setup = await fixture("provider_error", true);
    const journal = setup.store.orchestration;
    const source = new ControlledDecisionSource(
      journal,
      setup.authority,
      setup.agent,
      setup.driver(),
    );
    expect(
      await new OrchestratorLoop(new ActionKernel(journal), source, { pollMs: 5 }).run(
        setup.authority,
      ),
    ).toBe("awaiting_user");
    const turn = journal.agents.turns(setup.authority.runId)[0]!;
    expect(turn).toMatchObject({
      status: "failed",
      result: null,
      resultEligible: false,
      launch: { stop: { processTreeStopped: true } },
    });
    const ticket = journal.pendingDecision(setup.authority.runId)!;
    expect(
      journal.decisionSource.execution(setup.authority.runId, ticket.decisionId)?.attempts,
    ).toMatchObject([{ outcome: { kind: "failure", code: "runtime" }, retryNotBefore: null }]);
    expect(journal.control(setup.authority.runId).decisionsUsed).toBe(1);
    expect(journal.actions(setup.authority.runId)).toHaveLength(0);
  }, 15_000);

  it.runIf(process.env.EPICD_LIVE_ORCHESTRATOR === "1")(
    "uses real Astra to choose an authority escalation through the kernel",
    async () => {
      const setup = await fixture("live", true);
      const journal = setup.store.orchestration;
      const source = new ControlledDecisionSource(
        journal,
        setup.authority,
        setup.agent,
        setup.driver(),
      );
      const status = await new OrchestratorLoop(new ActionKernel(journal), source, {
        pollMs: 50,
      }).run(setup.authority);
      expect(status).toBe("awaiting_user");
      const diagnostics = journal
        .observations(setup.authority.runId, 0, 100)
        .filter((item) => item.kind === "runtime.problem")
        .map((item) => item.summary)
        .join("\n");
      expect(journal.actions(setup.authority.runId), diagnostics).toContainEqual(
        expect.objectContaining({
          request: expect.objectContaining({
            action: expect.objectContaining({ kind: "escalate", reason: "authority" }),
          }),
          result: expect.objectContaining({ status: "succeeded" }),
        }),
      );
      const turns = journal.agents.turns(setup.authority.runId);
      expect(turns.length).toBeGreaterThan(0);
      expect(
        turns.every(
          (turn) =>
            turn.resultEligible &&
            turn.launch?.manifest.model === "gpt-6-astra" &&
            turn.launch.stop?.code === 0,
        ),
      ).toBe(true);
      expect(await readFile(join(setup.workspace.path, "source.txt"), "utf8")).toBe("red\n");
    },
    100_000,
  );
});
