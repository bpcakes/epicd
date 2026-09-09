import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_OWNERSHIP_REF } from "../dist/adapters/publication-git.js";
import { StateStore } from "../dist/adapters/store.js";
import { ControlledSdkRuntime } from "../dist/adapters/controlled-sdk.js";
import { WorkspaceManager } from "../dist/adapters/workspaces.js";
import * as commandLifetime from "../dist/adapters/command-lifetime.js";
import { OrchestratorController, controlledDriver } from "../dist/controller.js";
import { ActionKernel } from "../dist/kernel/actions.js";
import { buildOrchestratorContext } from "../dist/orchestrator/context.js";
import { ControlledDecisionSource } from "../dist/orchestrator/sdk-source.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import type {
  ControllerAuthority,
  KernelAction,
  TurnIdentity,
} from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const emit = (value: unknown) => "printf '%s\\n' " + quote(JSON.stringify(value));
const question: KernelAction = {
  kind: "escalate",
  question: "This bounded test is finished; no epic delivery is claimed.",
  reason: "judgment",
  evidenceIds: [],
};
function fixture(identicalFailures = 3) {
  const root = mkdtempSync("/var/tmp/epicd-controller-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "app.txt"), "unchanged\n");
  git("add", "app.txt");
  git("commit", "-qm", "baseline");
  const path = join(root, "state.sqlite3"),
    store = new StateStore(path);
  cleanup.push(() => store.close());
  mkdirSync(join(root, "bin"));
  const executable = join(root, "bin", "codex");
  copyFileSync("/bin/false", join(root, "bin", "codex-code-mode-host"));
  const state = store.create(
    {
      ...initialRun(),
      repoPath: source,
      epicBaseRevision: git("rev-parse", "HEAD"),
      runtimeConfiguration: {
        commonDirectory: {
          path: join(source, ".git"),
          device: String(statSync(join(source, ".git"), { bigint: true }).dev),
          inode: String(statSync(join(source, ".git"), { bigint: true }).ino),
        },
        executable,
        trackerExecutable: "/usr/bin/false",
        runtimeRoot: join(root, "runtime"),
        workspaceRoot: join(root, "workspaces"),
        authCachePath: null,
        turnTimeoutMs: 15_000,
        herdr: null,
      },
    },
    RepositoryPolicySchema.parse({ schemaVersion: 1, budgets: { identicalFailures } }),
  );
  const providerIds = new Map<string, string>();
  const observed: {
    ticket: Record<string, unknown>;
    context: { objective: unknown; capabilities: { kind: string; available: boolean }[] };
  }[] = [];
  function driverFactory(actions: KernelAction[], hang = false, inputTokens = 10) {
    return (selectedStore: StateStore) => {
      const journal = selectedStore.orchestration;
      const driver = controlledDriver(selectedStore, state);
      expect(driver).toBeInstanceOf(ControlledSdkRuntime);
      return {
        kind: "sdk" as const,
        async run(authority: ControllerAuthority, identity: TurnIdentity, signal?: AbortSignal) {
          const key = `${identity.agentId}/${identity.agentGeneration}`;
          const providerId = providerIds.get(key) ?? randomUUID();
          providerIds.set(key, providerId);
          const prompt = journal.agents.turn(authority.runId, identity).prompt.instructions;
          const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
          observed.push(input);
          const action = actions.shift() ?? question;
          const decision = {
            explanation: "Scripted next action for bootstrap integration, not model reasoning",
            evidenceIds: [],
            request: {
              schemaVersion: 1,
              decisionId: input.ticket.decisionId,
              observationCursor: input.ticket.observationCursor,
              expectedControlVersion: input.ticket.expectedControlVersion,
              action,
            },
          };
          writeFileSync(
            executable,
            [
              "#!/bin/sh",
              "cat >/dev/null",
              emit({ type: "thread.started", thread_id: providerId }),
              emit({ type: "turn.started" }),
              ...(hang ? ["sleep 30"] : []),
              emit({
                type: "item.completed",
                item: { type: "agent_message", id: "decision", text: JSON.stringify(decision) },
              }),
              emit({
                type: "turn.completed",
                usage: { input_tokens: inputTokens, cached_input_tokens: 0, output_tokens: 5 },
              }),
              "",
            ].join("\n"),
            { mode: 0o700 },
          );
          return driver.run(authority, identity, signal);
        },
        reconcile: driver.reconcile.bind(driver),
      };
    };
  }
  return { root, source, path, store, state, git, observed, driverFactory };
}

function coordinatorCreations(store: StateStore, run: string) {
  return store.orchestration.agents
    .workspaces(run)
    .filter((workspace) => workspace.purpose === "coordinator")
    .map((workspace) => {
      const creation = store.orchestration.workspaceCreations.forWorkspace(run, workspace);
      if (!creation) throw new Error("Coordinator copy has no creation record");
      return creation;
    });
}

// Real SQLite, private Git copies, SDK event parsing and supervised process stop.
// Decision content is scripted; green does not establish Astra's delivery competence.
describe.runIf(process.platform === "linux")("single orchestrator controller bootstrap", () => {
  it("starts the coordinator from a fresh copy after a proven failed creation, preserving the original copy and user bytes", async () => {
    const f = fixture(),
      run = f.state.runId,
      journal = f.store.orchestration,
      db = new Database(f.path);
    writeFileSync(join(f.source, "app.txt"), "user staged bytes\n");
    f.git("add", "app.txt");
    const index = readFileSync(join(f.source, ".git/index"));
    writeFileSync(join(f.source, "app.txt"), "user unstaged bytes\n");
    db.exec(
      "CREATE TRIGGER fail_first_coordinator_completion BEFORE UPDATE OF record_json ON workspace_creations WHEN json_extract(NEW.record_json,'$.purpose')='coordinator' AND json_extract(NEW.record_json,'$.workerResult.status')='created' AND (SELECT count(*) FROM workspace_creations WHERE run_id=NEW.run_id AND json_extract(record_json,'$.purpose')='coordinator')=1 BEGIN SELECT RAISE(ABORT,'Lost first coordinator completion'); END",
    );
    try {
      await expect(
        new OrchestratorController(f.store, run, { driver: f.driverFactory([question]) }).run(),
      ).resolves.toMatchObject({ control: { status: "awaiting_user" } });
      const copies = coordinatorCreations(f.store, run);
      expect(copies).toHaveLength(2);
      expect(copies[0]).toMatchObject({ outcome: "failed", stop: { kind: "stopped", code: 1 } });
      expect(copies[1]).toMatchObject({ outcome: "created", stop: { kind: "stopped", code: 0 } });
      expect(copies[1]!.workspaceId).not.toBe(copies[0]!.workspaceId);
      for (const copy of copies) {
        const workspace = journal.agents.workspace(run, copy);
        expect(readFileSync(join(workspace.path, "app.txt"), "utf8")).toBe("unchanged\n");
        expect(journal.agents.activeWorkspaceOperation(run, copy)).toBeNull();
      }
      expect(journal.agents.instances(run)).toHaveLength(1);
      expect(journal.agents.instances(run)[0]!.workspaceId).toBe(copies[1]!.workspaceId);
      expect(journal.agents.instances(run)[0]!.contract.effective).toMatchObject({
        model: "gpt-6-astra",
        reasoningEffort: "high",
      });
      expect(f.observed).toHaveLength(1);
      expect(journal.reviews.records(run)).toEqual([]);
      expect(f.git("rev-parse", "HEAD")).toBe(f.state.epicBaseRevision);
      expect(readFileSync(join(f.source, ".git/index"))).toEqual(index);
      expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("user unstaged bytes\n");
    } finally {
      db.close();
    }
  });

  it.each([1, 3])(
    "does not refill the coordinator-copy attempt budget of %i after a stopped failure and operator resume",
    async (limit) => {
      const f = fixture(limit),
        run = f.state.runId,
        journal = f.store.orchestration,
        db = new Database(f.path);
      db.exec(
        "CREATE TRIGGER fail_coordinator_completion BEFORE UPDATE OF record_json ON workspace_creations WHEN json_extract(NEW.record_json,'$.purpose')='coordinator' AND json_extract(NEW.record_json,'$.workerResult.status')='created' BEGIN SELECT RAISE(ABORT,'Lost coordinator completion'); END",
      );
      try {
        await expect(
          new OrchestratorController(f.store, run, { driver: f.driverFactory([question]) }).run(),
        ).rejects.toThrow("attempt budget exhausted");
        const copies = coordinatorCreations(f.store, run);
        expect(copies).toHaveLength(journal.policy(run).budgets.identicalFailures);
        for (const copy of copies) {
          expect(copy).toMatchObject({ outcome: "failed", stop: { kind: "stopped", code: 1 } });
          expect(journal.agents.activeWorkspaceOperation(run, copy)).toBeNull();
        }
        expect(f.observed).toEqual([]);
        const escalation = journal.pendingEscalation(run)!;
        journal.operatorControl(run, journal.control(run).controlVersion, {
          kind: "respond",
          escalationId: escalation.escalationId,
          message: "Resume without changing the creation budget",
        });
        const reopened = new StateStore(f.path);
        cleanup.push(() => reopened.close());
        await expect(
          new OrchestratorController(reopened, run, { driver: f.driverFactory([question]) }).run(),
        ).rejects.toThrow("attempt budget exhausted");
        expect(coordinatorCreations(f.store, run)).toEqual(copies);
        expect(journal.agents.instances(run)).toEqual([]);
      } finally {
        db.close();
      }
    },
  );

  it("keeps one coordinator reservation when its creation stop is unknown, then recovers that original copy", async () => {
    const f = fixture(),
      run = f.state.runId,
      journal = f.store.orchestration;
    const recover = commandLifetime.recoverCommandStop;
    const missing = vi
      .spyOn(commandLifetime, "recoverCommandStop")
      .mockImplementation((execution) => {
        const creation = journal.agents
          .workspaces(run)
          .filter((workspace) => workspace.purpose === "coordinator")
          .map((workspace) => journal.workspaceCreations.forWorkspace(run, workspace))
          .find((record) => record?.execution?.ioId === execution.ioId);
        return creation ? Promise.resolve(null) : recover(execution);
      });
    await expect(
      new OrchestratorController(f.store, run, { driver: f.driverFactory([question]) }).run(),
    ).rejects.toThrow("no independent stop receipt");
    const copies = coordinatorCreations(f.store, run);
    expect(copies).toHaveLength(1);
    const original = copies[0]!;
    expect(original).toMatchObject({
      outcome: null,
      stop: null,
      workerResult: { status: "created" },
    });
    const receipt = await commandLifetime.readCommandStop(original.execution!);
    expect(receipt).toMatchObject({ kind: "stopped", code: 0 });
    expect(journal.agents.activeWorkspaceOperation(run, original)?.operationId).toBe(
      original.workspaceOperationId,
    );
    expect(f.observed).toEqual([]);
    missing.mockRestore();
    journal.operatorControl(run, journal.control(run).controlVersion, {
      kind: "respond",
      escalationId: journal.pendingEscalation(run)!.escalationId,
      message: "Reconcile the original receipt without creating another copy",
    });
    const reopened = new StateStore(f.path);
    cleanup.push(() => reopened.close());
    await expect(
      new OrchestratorController(reopened, run, { driver: f.driverFactory([question]) }).run(),
    ).resolves.toMatchObject({ control: { status: "awaiting_user" } });
    expect(coordinatorCreations(f.store, run)).toHaveLength(1);
    expect(journal.workspaceCreations.get(run, original.creationId)).toMatchObject({
      outcome: "created",
      stop: receipt,
    });
    expect(journal.agents.instances(run)[0]!.workspaceId).toBe(original.workspaceId);
    expect(journal.agents.activeWorkspaceOperation(run, original)).toBeNull();
  });

  it.each([false, true])(
    "preserves an acknowledged-lost coordinator copy without replacement (changed=%s)",
    async (changed) => {
      const f = fixture(),
        run = f.state.runId,
        journal = f.store.orchestration;
      const create = WorkspaceManager.prototype.create;
      const fault = vi
        .spyOn(WorkspaceManager.prototype, "create")
        .mockImplementation(async function (this: WorkspaceManager, ...args) {
          const workspace = await create.apply(this, args);
          if (changed)
            writeFileSync(join(workspace.path, "app.txt"), "unexpected retained bytes\n");
          throw new Error("Lost coordinator creation acknowledgement");
        });
      const running = new OrchestratorController(f.store, run, {
        driver: f.driverFactory([question]),
      }).run();
      if (changed) await expect(running).rejects.toThrow("incomplete");
      else await expect(running).resolves.toMatchObject({ control: { status: "awaiting_user" } });
      expect(fault).toHaveBeenCalledOnce();
      const copies = coordinatorCreations(f.store, run);
      expect(copies).toHaveLength(1);
      expect(copies[0]).toMatchObject({ outcome: "created", stop: { kind: "stopped", code: 0 } });
      const workspace = journal.agents.workspace(run, copies[0]!);
      expect(readFileSync(join(workspace.path, "app.txt"), "utf8")).toBe(
        changed ? "unexpected retained bytes\n" : "unchanged\n",
      );
      expect(journal.agents.instances(run)).toHaveLength(changed ? 0 : 1);
      expect(journal.reviews.records(run)).toEqual([]);
      expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("unchanged\n");
    },
  );

  it.each(["abort", "pause", "ownership"] as const)(
    "does not start another coordinator copy after %s interrupts recovery",
    async (intervention) => {
      const f = fixture(),
        run = f.state.runId,
        journal = f.store.orchestration,
        db = new Database(f.path);
      db.exec(
        "CREATE TRIGGER fail_coordinator_completion BEFORE UPDATE OF record_json ON workspace_creations WHEN json_extract(NEW.record_json,'$.purpose')='coordinator' AND json_extract(NEW.record_json,'$.workerResult.status')='created' BEGIN SELECT RAISE(ABORT,'Lost coordinator completion'); END",
      );
      const signal = new AbortController(),
        create = WorkspaceManager.prototype.create;
      const fault = vi
        .spyOn(WorkspaceManager.prototype, "create")
        .mockImplementation(async function (this: WorkspaceManager, ...args) {
          try {
            return await create.apply(this, args);
          } catch (error) {
            if (intervention === "abort") signal.abort();
            else if (intervention === "pause")
              journal.operatorControl(run, journal.control(run).controlVersion, { kind: "pause" });
            else f.git("update-ref", RUN_OWNERSHIP_REF, f.state.epicBaseRevision);
            throw error;
          }
        });
      try {
        const running = new OrchestratorController(f.store, run, {
          driver: f.driverFactory([question]),
        }).run(signal.signal);
        if (intervention === "abort")
          await expect(running).resolves.toMatchObject({ control: { status: "paused" } });
        else
          await expect(running).rejects.toThrow(
            intervention === "pause" ? "no longer active" : "Repository ownership changed",
          );
        expect(fault).toHaveBeenCalledOnce();
        const copies = coordinatorCreations(f.store, run);
        expect(copies).toHaveLength(1);
        expect(copies[0]).toMatchObject({ outcome: "failed", stop: { kind: "stopped", code: 1 } });
        expect(journal.agents.instances(run)).toEqual([]);
        expect(f.observed).toEqual([]);
        if (intervention === "pause") expect(journal.control(run).status).toBe("paused");
        if (intervention === "ownership")
          expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(f.state.epicBaseRevision);
      } finally {
        db.close();
      }
    },
  );

  it("does not invent a retryable coordinator creation when no intent was admitted", async () => {
    const f = fixture(),
      run = f.state.runId;
    const fault = vi
      .spyOn(WorkspaceManager.prototype, "create")
      .mockRejectedValueOnce(new Error("No workspace was admitted"));
    await expect(
      new OrchestratorController(f.store, run, { driver: f.driverFactory([question]) }).run(),
    ).rejects.toThrow("No workspace was admitted");
    expect(fault).toHaveBeenCalledOnce();
    expect(f.store.orchestration.agents.workspaces(run)).toEqual([]);
    expect(f.store.orchestration.agents.instances(run)).toEqual([]);
    expect(f.observed).toEqual([]);
  });

  it("starts a fresh Astra conversation after an explicit runtime round trip and rebuilds continuity from the journal", async () => {
    const f = fixture(),
      run = f.state.runId;
    await new OrchestratorController(f.store, run, {
      driver: f.driverFactory([
        {
          kind: "record_memory",
          entry: {
            kind: "strategy",
            content: "Investigate the browser failure before independent review",
            scope: "run",
            taskId: null,
            confidence: "hypothesis",
            observationIds: [],
            evidenceIds: [],
            revision: null,
            environmentGeneration: null,
            supersedes: null,
          },
        },
        question,
      ]),
    }).run();
    const journal = f.store.orchestration;
    const prior = journal.agents.instances(run)[0]!;
    const turns = journal.agents.turns(run),
      memory = journal.memory(run),
      used = journal.control(run).decisionsUsed;
    const lease = f.store.acquireLease(run),
      authority = { runId: run, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
    // The native endpoint is deliberately unopened; actual native runtime behavior has its own suite.
    journal.handoffRuntime(authority, journal.control(run).controlVersion, {
      runtime: "herdr",
      executable: f.state.runtimeConfiguration!.executable,
      herdr: { executable: "/usr/bin/false", sessionName: "unopened", workspaceId: "unopened" },
    });
    journal.handoffRuntime(authority, journal.control(run).controlVersion, {
      runtime: "sdk",
      executable: f.state.runtimeConfiguration!.executable,
      herdr: null,
    });
    f.store.releaseLease(run, lease.ownerToken);
    const pending = journal.pendingEscalation(run)!;
    journal.operatorControl(run, journal.control(run).controlVersion, {
      kind: "respond",
      escalationId: pending.escalationId,
      message: "Continue the same epic after runtime handoff",
    });
    await new OrchestratorController(f.store, run, { driver: f.driverFactory([question]) }).run();
    const agents = journal.agents.instances(run);
    expect(agents).toHaveLength(2);
    const fresh = agents.find((agent) => agent.agentId !== prior.agentId)!;
    expect(journal.agents.instance(run, prior)).toMatchObject({
      status: "released",
      provider: prior.provider,
      contract: prior.contract,
    });
    expect(fresh.provider).not.toEqual(prior.provider);
    expect(fresh.workspaceId).not.toBe(prior.workspaceId);
    expect(fresh.contract).toMatchObject({
      runtime: "sdk",
      effective: { model: "gpt-6-astra", reasoningEffort: "high" },
    });
    for (const turn of turns) expect(journal.agents.turn(run, turn.identity)).toEqual(turn);
    expect(f.observed.at(-1)?.context).toMatchObject({ memory });
    expect(journal.control(run).decisionsUsed).toBe(used + 1);
  });

  it("invokes registered capabilities from coordinator decisions without a lifecycle dispatcher", async () => {
    const f = fixture();
    const baseline = f.git("rev-parse", "HEAD");
    const controller = new OrchestratorController(f.store, f.state.runId, {
      driver: f.driverFactory([{ kind: "inspect_run" }, question]),
    });
    const status = await controller.run();
    expect(status.control.status).toBe("awaiting_user");
    expect(status.escalation?.question).toBe(question.question);
    expect(f.observed[0]?.context.objective).toMatchObject({
      epicId: f.state.epicId,
      baselineRevision: baseline,
    });
    for (const kind of [
      "start_agent",
      "create_diagnostic_workspace",
      "inspect_fixture",
      "provision_declared_fixture",
      "reconcile_fixture_creation",
      "run_validation",
      "run_review",
      "request_commit",
      "reconcile_action",
      "request_publish",
      "export_tracker",
      "request_beads_transition",
      "complete_run",
    ])
      expect(f.observed[0]?.context.capabilities).toContainEqual(
        expect.objectContaining({ kind, available: true }),
      );
    expect(
      f.store.orchestration.actions(f.state.runId).map((action) => action.request.action.kind),
    ).toEqual(["inspect_run", "escalate"]);
    const agents = f.store.orchestration.agents.instances(f.state.runId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.contract.effective).toEqual({
      model: "gpt-6-astra",
      reasoningEffort: "high",
    });
    const turns = f.store.orchestration.agents.turns(f.state.runId);
    expect(turns).toHaveLength(2);
    expect(
      turns.every((turn) => turn.launch?.stop?.processTreeStopped && turn.status === "completed"),
    ).toBe(true);
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
    expect(f.git("rev-parse", "HEAD")).toBe(baseline);
    expect(f.git("status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("unchanged\n");
  });
  it("reopens the same coordinator conversation after a correlated operator response", async () => {
    const f = fixture();
    await new OrchestratorController(f.store, f.state.runId, {
      driver: f.driverFactory([question]),
    }).run();
    const first = f.store.orchestration.agents.instances(f.state.runId)[0]!;
    const escalation = f.store.orchestration.pendingEscalation(f.state.runId)!;
    const second = new StateStore(f.path);
    cleanup.push(() => second.close());
    second.orchestration.operatorControl(
      f.state.runId,
      second.orchestration.control(f.state.runId).controlVersion,
      {
        kind: "respond",
        escalationId: escalation.escalationId,
        message: "Perform one more bounded inspection",
      },
    );
    await new OrchestratorController(second, f.state.runId, {
      driver: f.driverFactory([{ kind: "inspect_run" }, question]),
    }).run();
    const agents = second.orchestration.agents.instances(f.state.runId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.agentId).toBe(first.agentId);
    expect(agents[0]?.provider).toEqual(first.provider);
    expect(second.orchestration.agents.turns(f.state.runId)).toHaveLength(3);
    expect(second.controllerLease(f.state.runId)).toBeNull();
  });
  it.each([
    {
      kind: "provision_declared_fixture",
      fixtureId: "never-reserved",
      operation: "create",
      expectedGeneration: 0,
    },
    { kind: "reconcile_fixture_creation", creationId: "lost-read" },
    { kind: "reconcile_tracker_commit", trackerCommitId: "00000000-0000-4000-8000-000000000001" },
    {
      kind: "request_tracker_commit",
      trackerOperationId: "00000000-0000-4000-8000-000000000001",
      publicationId: "00000000-0000-4000-8000-000000000002",
    },
    { kind: "reconcile_action", actionId: "00000000-0000-4000-8000-000000000001" },
    {
      kind: "capture_candidate",
      taskId: "task",
      workspaceId: "copy",
      workspaceGeneration: 1,
      validationPlanId: "plan",
    },
    {
      kind: "run_validation",
      candidateId: "candidate",
      candidateGeneration: 1,
      workspaceId: "copy",
      workspaceGeneration: 1,
      validationPlanId: "plan",
      checkId: "tests",
    },
    {
      kind: "run_review",
      references: [],
      candidateId: "candidate",
      candidateGeneration: 1,
      workspaceId: "copy",
      workspaceGeneration: 1,
      agent: null,
      instructions: "Inspect",
    },
    {
      kind: "request_commit",
      candidateId: "candidate",
      candidateGeneration: 1,
      subject: "Undispatched commit",
    },
  ] satisfies KernelAction[])(
    "settles an interrupted $kind without an authorized external mutation",
    async (action) => {
      const f = fixture(),
        journal = f.store.orchestration;
      const lease = f.store.acquireLease(f.state.runId);
      const authority = {
        runId: f.state.runId,
        ownerToken: lease.ownerToken,
        leaseId: lease.leaseId,
      };
      const kernel = new ActionKernel(journal);
      kernel.registerExternal(action.kind, async () => {
        throw new Error("Lost result before any resource intent or external I/O");
      });
      const ticket = journal.beginDecision(
        authority,
        journal.latestObservationCursor(f.state.runId),
        journal.control(f.state.runId).controlVersion,
      );
      const pending = await kernel.execute(
        {
          explanation: "Inject a pre-I/O interruption",
          evidenceIds: [],
          request: {
            schemaVersion: 1,
            decisionId: ticket.decisionId,
            observationCursor: ticket.observationCursor,
            expectedControlVersion: ticket.expectedControlVersion,
            action,
          },
        },
        authority,
      );
      const result =
        pending.status === "running" ? await kernel.operation(pending.operationId) : pending;
      expect(result?.status).toBe("indeterminate");
      f.store.releaseLease(f.state.runId, authority.ownerToken);
      await new OrchestratorController(f.store, f.state.runId, {
        driver: f.driverFactory([question]),
      }).run();
      expect(journal.action(f.state.runId, pending.actionId)?.status).toBe("failed");
      expect(journal.fixtures.creations(f.state.runId)).toEqual([]);
      expect(journal.trackerCommits.records(f.state.runId)).toEqual([]);
    },
  );
  it("pauses a live coordinator and waits for its supervised stop before releasing ownership", async () => {
    const f = fixture();
    const controller = new OrchestratorController(f.store, f.state.runId, {
      driver: f.driverFactory([question], true),
    });
    const pending = controller.run();
    await expect
      .poll(
        () =>
          f.store.orchestration.agents
            .turns(f.state.runId)
            .some((turn) => turn.status === "running"),
        { timeout: 5000 },
      )
      .toBe(true);
    controller.pause();
    const result = await pending;
    expect(result.control.status).toBe("paused");
    const turns = f.store.orchestration.agents.turns(f.state.runId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      status: "cancelled",
      resultEligible: false,
      launch: { stop: { processTreeStopped: true } },
    });
    expect(f.store.orchestration.actions(f.state.runId)).toEqual([]);
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
  });
  it("changes coordinator effort through a journaled capability and cold-starts a new conversation without operator restart", async () => {
    const f = fixture();
    await new OrchestratorController(f.store, f.state.runId, {
      driver: f.driverFactory([
        {
          kind: "record_memory",
          entry: {
            kind: "strategy",
            content: "Inspect before delivery; preserve the user's checkout",
            scope: "run",
            taskId: null,
            confidence: "hypothesis",
            observationIds: [],
            evidenceIds: [],
            revision: null,
            environmentGeneration: null,
            supersedes: null,
          },
        },
        {
          kind: "change_agent_settings",
          role: "orchestrator",
          settings: { model: "gpt-6-astra", reasoningEffort: "xhigh" },
        },
        { kind: "inspect_run" },
        question,
      ]),
    }).run();
    const journal = f.store.orchestration;
    const agents = journal.agents.instances(f.state.runId);
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({
      status: "released",
      contract: { effective: { model: "gpt-6-astra", reasoningEffort: "high" } },
    });
    expect(agents[1]).toMatchObject({
      contract: { effective: { model: "gpt-6-astra", reasoningEffort: "xhigh" } },
    });
    expect(agents[1]?.provider).not.toEqual(agents[0]?.provider);
    expect(agents[1]?.workspaceId).not.toBe(agents[0]?.workspaceId);
    expect(journal.agents.turns(f.state.runId)).toHaveLength(4);
    expect(journal.control(f.state.runId).decisionsUsed).toBe(4);
    expect(journal.actions(f.state.runId).every((action) => action.status === "succeeded")).toBe(
      true,
    );
    expect(journal.memory(f.state.runId)[0]?.content).toContain("preserve the user's checkout");
    expect(JSON.stringify(f.observed.at(-1))).toContain("preserve the user's checkout");
    expect(f.git("status", "--porcelain")).toBe("");
  });
  it("rolls over from durable usage after reopening without revoking evidence or refilling budgets", async () => {
    const f = fixture(),
      run = f.state.runId;
    await new OrchestratorController(f.store, run, {
      driver: f.driverFactory(
        [
          {
            kind: "record_memory",
            entry: {
              kind: "strategy",
              content: "Retain the validation hypothesis across context rollover",
              scope: "run",
              taskId: null,
              confidence: "hypothesis",
              observationIds: [],
              evidenceIds: [],
              revision: null,
              environmentGeneration: null,
              supersedes: null,
            },
          },
          question,
        ],
        false,
        192 * 1024,
      ),
    }).run();
    const oldTurns = f.store.orchestration.agents.turns(run);
    expect(oldTurns).toHaveLength(2);
    expect(
      oldTurns.every((turn) => turn.resultEligible && turn.sdkUsage?.inputTokens === 192 * 1024),
    ).toBe(true);
    const reopened = new StateStore(f.path);
    cleanup.push(() => reopened.close());
    const journal = reopened.orchestration;
    const before = journal.control(run);
    journal.operatorControl(run, before.controlVersion, {
      kind: "respond",
      escalationId: journal.pendingEscalation(run)!.escalationId,
      message: "Continue the bounded inspection",
    });
    await new OrchestratorController(reopened, run, {
      driver: f.driverFactory([{ kind: "inspect_run" }, question]),
    }).run();
    const agents = journal.agents.instances(run);
    expect(agents).toHaveLength(3);
    expect(
      agents
        .slice(0, 2)
        .every((agent) => agent.status === "released" && agent.revokedReason === null),
    ).toBe(true);
    expect(new Set(agents.map((agent) => agent.workspaceId)).size).toBe(3);
    expect(new Set(agents.map((agent) => agent.provider?.sessionId)).size).toBe(3);
    expect(
      agents.every(
        (agent) =>
          agent.contract.runtime === "sdk" &&
          agent.contract.effective.model === "gpt-6-astra" &&
          agent.contract.effective.reasoningEffort === "high",
      ),
    ).toBe(true);
    expect(journal.agents.turns(run).slice(0, 2)).toEqual(oldTurns);
    expect(journal.control(run)).toMatchObject({
      decisionsUsed: before.decisionsUsed + 2,
      maxDecisions: before.maxDecisions,
    });
    expect(JSON.stringify(f.observed.at(-1))).toContain(
      "Retain the validation hypothesis across context rollover",
    );
    const retirements = journal
      .observations(run, 0, 1000)
      .filter((event) => event.kind === "agent.retired");
    expect(retirements).toHaveLength(2);
    expect(retirements.every((event) => event.summary.includes("usage_pressure"))).toBe(true);
    expect(f.git("status", "--porcelain")).toBe("");
  });
  it("reconciles a stopped coordinator result before rollover instead of invalidating its frozen ticket", async () => {
    const f = fixture(),
      run = f.state.runId;
    await new OrchestratorController(f.store, run, { driver: f.driverFactory([question]) }).run();
    const journal = f.store.orchestration;
    journal.operatorControl(run, journal.control(run).controlVersion, {
      kind: "respond",
      escalationId: journal.pendingEscalation(run)!.escalationId,
      message: "Perform a bounded inspection",
    });
    const lease = f.store.acquireLease(run),
      authority = { runId: run, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
    const previous = journal.agents.instances(run)[0]!;
    const context = buildOrchestratorContext(new ActionKernel(journal), run);
    const ticket = journal.beginDecision(
      authority,
      context.observationCursor,
      context.control.controlVersion,
    );
    journal.decisionSource.prepare(authority, ticket, JSON.stringify(context));
    const attempt = journal.decisionSource.start(authority, ticket.decisionId);
    const source = new ControlledDecisionSource(
      journal,
      authority,
      previous,
      f.driverFactory([{ kind: "inspect_run" }], false, 192 * 1024)(f.store),
    );
    await source.decide({ ticket, context, attemptId: attempt.attemptId });
    // Simulated lost transport acknowledgement, not lost process-stop proof.
    expect(journal.decisionSource.unsettled(run)?.attemptId).toBe(attempt.attemptId);
    const used = journal.control(run).decisionsUsed;
    f.store.releaseLease(run, authority.ownerToken);
    const reopened = new StateStore(f.path);
    cleanup.push(() => reopened.close());
    await new OrchestratorController(reopened, run, { driver: f.driverFactory([question]) }).run();
    const resumed = reopened.orchestration;
    expect(
      resumed.actions(run).filter((action) => action.request.decisionId === ticket.decisionId),
    ).toEqual([expect.objectContaining({ status: "succeeded" })]);
    expect(resumed.decisionSource.execution(run, ticket.decisionId)?.attempts).toHaveLength(1);
    expect(resumed.decisionSource.unsettled(run)).toBeNull();
    expect(resumed.agents.instances(run)).toHaveLength(2);
    expect(resumed.agents.instance(run, previous)).toMatchObject({
      status: "released",
      revokedReason: null,
    });
    expect(resumed.control(run).decisionsUsed).toBe(used + 1);
  });
  it("rejects a competing controller before creating a coordinator or invoking a runtime", async () => {
    const f = fixture();
    const lease = f.store.acquireLease(f.state.runId);
    let invoked = false;
    const controller = new OrchestratorController(f.store, f.state.runId, {
      driver: () => {
        invoked = true;
        throw new Error("unexpected");
      },
    });
    await expect(controller.run()).rejects.toThrow("already controlled");
    expect(invoked).toBe(false);
    expect(f.store.controllerLease(f.state.runId)?.leaseId).toBe(lease.leaseId);
    expect(f.store.orchestration.agents.instances(f.state.runId)).toEqual([]);
  });

  it.each(["sdk", "herdr"] as const)(
    "rejects another state file before invoking its %s runtime even after the owning controller detached",
    async (runtime) => {
      const f = fixture();
      await new OrchestratorController(f.store, f.state.runId, {
        driver: f.driverFactory([question]),
      }).run();
      expect(f.store.controllerLease(f.state.runId)).toBeNull();
      const other = new StateStore(join(f.root, "other.sqlite3"));
      cleanup.push(() => other.close());
      const next = other.create(
        {
          ...f.state,
          runId: randomUUID(),
          runtime,
          runtimeConfiguration: {
            ...f.state.runtimeConfiguration!,
            herdr:
              runtime === "herdr"
                ? {
                    executable: "/usr/bin/false",
                    sessionName: "unopened",
                    workspaceId: "unopened",
                  }
                : null,
          },
        },
        RepositoryPolicySchema.parse({ schemaVersion: 1 }),
      );
      let invoked = false;
      const controller = new OrchestratorController(other, next.runId, {
        driver: () => {
          invoked = true;
          throw new Error("Unexpected runtime");
        },
      });
      await expect(controller.run()).rejects.toThrow("Another run owns");
      expect(invoked).toBe(false);
      expect(other.orchestration.agents.instances(next.runId)).toEqual([]);
      expect(other.orchestration.actions(next.runId)).toEqual([]);
      expect(other.controllerLease(next.runId)).toBeNull();
      expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(
        f.store.orchestration.repositoryAdmission.record(f.state.runId)!.revision,
      );
    },
  );

  it("refuses a coordinator's next action after the repository reservation is replaced", async () => {
    const f = fixture();
    const factory = f.driverFactory([
      {
        kind: "record_memory",
        entry: {
          kind: "strategy",
          content: "Must not be admitted after ownership changes",
          scope: "run",
          taskId: null,
          confidence: "hypothesis",
          observationIds: [],
          evidenceIds: [],
          revision: null,
          environmentGeneration: null,
          supersedes: null,
        },
      },
    ]);
    const controller = new OrchestratorController(f.store, f.state.runId, {
      driver: (store) => {
        const actual = factory(store);
        return {
          ...actual,
          async run(...args) {
            const result = await actual.run(...args);
            f.git("update-ref", RUN_OWNERSHIP_REF, f.state.epicBaseRevision);
            return result;
          },
        };
      },
    });
    await expect(controller.run()).rejects.toThrow(
      /ownership changed|settled repository ownership/,
    );
    expect(f.store.orchestration.repositoryAdmission.record(f.state.runId)?.phase).toBe("conflict");
    expect(f.store.orchestration.memory(f.state.runId)).toEqual([]);
    expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(f.state.epicBaseRevision);
    expect(
      f.store.orchestration.agents.turns(f.state.runId).every((turn) => turn.stopEvidence),
    ).toBe(true);
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
  });
});
