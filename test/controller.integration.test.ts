import { fixtureAccounts } from "./fixtures/accounts.js";
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
import { ControlledLaunches } from "../dist/adapters/controlled-launch.js";
import { ControlledAgentDispatcher } from "../dist/adapters/agent-dispatch.js";
import type { AgentDispatcher } from "../dist/adapters/agent-dispatch.js";
import { WorkspaceManager } from "../dist/adapters/workspaces.js";
import * as commandLifetime from "../dist/adapters/command-lifetime.js";
import { OrchestratorController } from "../dist/controller.js";
import { ActionKernel } from "../dist/kernel/actions.js";
import { buildOrchestratorContext } from "../dist/orchestrator/context.js";
import { ControlledDecisionSource } from "../dist/orchestrator/sdk-source.js";
import { digestJson, RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { SdkAgentSessionContractSchema } from "../src/domain/types.js";
import type {
  ControllerAuthority,
  KernelAction,
  TurnIdentity,
} from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
function fixture(identicalFailures = 3, runtime: "sdk" | "herdr" = "sdk") {
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
      runtime,
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
        accounts: fixtureAccounts(),
        turnTimeoutMs: 15_000,
        herdr:
          runtime === "herdr"
            ? {
                executable: "/usr/bin/false",
                sessionName: "controller-test",
                workspaceId: "controller-workspace",
              }
            : null,
      },
    },
    RepositoryPolicySchema.parse({ schemaVersion: 1, budgets: { identicalFailures } }),
  );
  const providerIds = new Map<string, string>();
  const observed: {
    ticket: Record<string, unknown>;
    context: { objective: unknown; capabilities: { kind: string; available: boolean }[] };
  }[] = [];
  function driverFactory(
    actions: KernelAction[],
    hang = false,
    inputTokens = 10,
  ): (selectedStore: StateStore) => AgentDispatcher {
    return (selectedStore: StateStore) => {
      const journal = selectedStore.orchestration;
      return new ControlledAgentDispatcher(journal, {
        "codex:sdk": (dispatchJournal, execution) => {
          const driver = new ControlledSdkRuntime(dispatchJournal, {
            root: execution.runtimeRoot,
            executable: execution.executable,
            turnTimeoutMs: execution.turnTimeoutMs,
          });
          return {
            backend: "codex" as const,
            kind: "sdk" as const,
            async run(
              authority: ControllerAuthority,
              identity: TurnIdentity,
              signal?: AbortSignal,
            ) {
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
        },
      });
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

function redirectTurnWorkspace(
  db: Database.Database,
  runId: string,
  turnId: string,
  workspace: { workspaceId: string; workspaceGeneration: number },
): TurnIdentity {
  const row = db
    .prepare("SELECT record_json FROM agent_turns WHERE run_id = ? AND turn_id = ?")
    .get(runId, turnId) as { record_json: string };
  const changed = JSON.parse(row.record_json);
  changed.identity.workspaceId = workspace.workspaceId;
  changed.identity.workspaceGeneration = workspace.workspaceGeneration;
  changed.prompt.identity = changed.identity;
  changed.promptDigest = digestJson(changed.prompt);
  db.prepare("UPDATE agent_turns SET record_json = ? WHERE run_id = ? AND turn_id = ?").run(
    JSON.stringify(changed),
    runId,
    turnId,
  );
  return changed.identity as TurnIdentity;
}

// Real SQLite, private Git copies, SDK event parsing and supervised process stop.
// Decision content is scripted; green does not establish Astra's delivery competence.
describe.runIf(process.platform === "linux")("single orchestrator controller bootstrap", () => {
  it("rejects unavailable Herdr before creating a coordinator or spending decision budget", async () => {
    const f = fixture(3, "herdr");
    vi.stubEnv("HERDR_ENV", "0");

    await expect(new OrchestratorController(f.store, f.state.runId).run()).rejects.toThrow(
      "Controlled Herdr requires HERDR_ENV=1",
    );

    const journal = f.store.orchestration;
    expect(journal.control(f.state.runId)).toMatchObject({
      status: "awaiting_user",
      decisionsUsed: 0,
    });
    expect(journal.pendingDecision(f.state.runId)).toBeNull();
    expect(journal.agents.instances(f.state.runId)).toEqual([]);
    expect(coordinatorCreations(f.store, f.state.runId)).toEqual([]);
    expect(f.observed).toEqual([]);
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
  });

  it("allocates a fresh workspace after its sole controller-created coordinator becomes isolated", async () => {
    const f = fixture(),
      run = f.state.runId;
    await new OrchestratorController(f.store, run, {
      dispatcher: f.driverFactory([question]),
    }).run();
    const original = f.store.orchestration.agents.instances(run)[0]!;
    const db = new Database(f.path);
    cleanup.push(() => db.close());
    const damaged = { ...original, schemaVersion: 1 };
    db.prepare(
      "UPDATE agent_instances SET record_json = ? WHERE agent_id = ? AND generation = ?",
    ).run(JSON.stringify(damaged), original.agentId, original.agentGeneration);
    const reopened = new StateStore(f.path);
    cleanup.push(() => reopened.close());
    const journal = reopened.orchestration;
    expect(journal.agents.ownershipAssessment(run, original).state).toBe("isolated");
    journal.operatorControl(run, journal.control(run).controlVersion, {
      kind: "respond",
      escalationId: journal.pendingEscalation(run)!.escalationId,
      message: "Continue the recovery regression",
    });
    await new OrchestratorController(reopened, run, {
      dispatcher: f.driverFactory([question]),
    }).run();
    const replacement = journal.agents.operationalInstances(run)[0]!;
    expect(replacement.workspaceId).not.toBe(original.workspaceId);
    expect(coordinatorCreations(reopened, run)).toHaveLength(2);
    expect(f.observed).toHaveLength(2);
    expect(journal.agents.ownershipAssessment(run, original).state).toBe("isolated");
    // Reopening and resuming the healthy generation must reuse its existing slot.
    journal.operatorControl(run, journal.control(run).controlVersion, {
      kind: "respond",
      escalationId: journal.pendingEscalation(run)!.escalationId,
      message: "Continue the recovery regression",
    });
    await new OrchestratorController(reopened, run, {
      dispatcher: f.driverFactory([question]),
    }).run();
    expect(coordinatorCreations(reopened, run)).toHaveLength(2);
  });

  it("blocks new dispatch when a readable owner has malformed persisted turn history", async () => {
    const f = fixture();
    const run = f.state.runId;
    await new OrchestratorController(f.store, run, {
      dispatcher: f.driverFactory([question]),
    }).run();
    const journal = f.store.orchestration;
    const turn = journal.agents.turns(run)[0]!;
    const changed = structuredClone(turn);
    changed.prompt.instructions = "Changed without updating its durable prompt digest";
    const db = new Database(f.path);
    cleanup.push(() => db.close());
    db.prepare("UPDATE agent_turns SET record_json = ? WHERE run_id = ? AND turn_id = ?").run(
      JSON.stringify(changed),
      run,
      turn.identity.turnId,
    );
    journal.operatorControl(run, journal.control(run).controlVersion, {
      kind: "respond",
      escalationId: journal.pendingEscalation(run)!.escalationId,
      message: "Attempt recovery without dispatching past damaged history",
    });

    await expect(
      new OrchestratorController(f.store, run, { dispatcher: f.driverFactory([]) }).run(),
    ).rejects.toThrow("readable owner(s) with damaged turn history");
    expect(f.observed).toHaveLength(1);
    expect(journal.agents.recoveryIntegrity(run)).toMatchObject([
      {
        state: "uncontained",
        ownerRecordReadable: true,
        affectedTurnIds: [turn.identity.turnId],
      },
    ]);
    expect(journal.observations(run)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "recovery.owner_uncontained",
          summary: expect.stringContaining(
            "persisted work whose integrity or stop cannot be proved",
          ),
        }),
      ]),
    );
  });

  it("reassesses containment after inspection recovery and deduplicates restart observations", async () => {
    const f = fixture(),
      run = f.state.runId,
      journal = f.store.orchestration;
    const lease = f.store.acquireLease(run);
    const authority = { runId: run, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
    const workspace = journal.agents.reserveWorkspace(
      authority,
      {
        root: join(f.root, "workspaces"),
        purpose: "coordinator",
        sourceMode: "immutable",
        baselineRevision: f.state.epicBaseRevision,
      },
      journal.control(run).controlVersion,
    );
    mkdirSync(workspace.path, { recursive: true });
    journal.agents.markWorkspaceReady(authority, workspace, "fixture");
    const settings = { model: "gpt-6-astra", reasoningEffort: "high" as const };
    const agent = journal.agents.reserveAgent(
      authority,
      {
        ...workspace,
        role: "orchestrator",
        purpose: "coordination",
        taskId: null,
        candidateId: null,
        instructions: "Stopped historical owner",
        confinementProfile: "epicd-isolated",
        contract: SdkAgentSessionContractSchema.parse({
          backend: "codex",
          runtime: "sdk",
          requested: settings,
          effective: settings,
        }),
      },
      journal.control(run).controlVersion,
    );
    const message = journal.agents.enqueueAgentMessage(
      authority,
      agent,
      randomUUID(),
      "Supersede only after later recovery proves this owner isolated",
    );
    const inspection = journal.workspaceInspections.reserve(
      authority,
      join(f.root, "workspaces"),
      workspace,
      { kind: "materialization" },
    );
    const db = new Database(f.path);
    cleanup.push(() => db.close());
    const damaged = { ...agent, schemaVersion: 1 };
    const raw = JSON.stringify(damaged);
    db.prepare(
      "UPDATE agent_instances SET record_json=? WHERE run_id=? AND agent_id=? AND generation=?",
    ).run(raw, run, agent.agentId, agent.agentGeneration);
    journal.operatorControl(run, journal.control(run).controlVersion, { kind: "pause" });
    f.store.releaseLease(run, lease.ownerToken);
    const finish = vi.spyOn(journal.workspaceInspections, "finish").mockImplementationOnce(() => {
      throw new Error("Temporary settlement failure");
    });
    await expect(
      new OrchestratorController(f.store, run, { dispatcher: f.driverFactory([]) }).run(),
    ).rejects.toThrow("unreadable agent owner");
    finish.mockRestore();
    expect(journal.agents.recoveryIntegrity(run)[0]?.state).toBe("uncontained");
    const messageStatus = () =>
      JSON.parse(
        (
          db
            .prepare("SELECT record_json FROM agent_messages WHERE message_id = ?")
            .get(message.messageId) as { record_json: string }
        ).record_json,
      ).status;
    expect(messageStatus()).toBe("queued");
    const restarted = new StateStore(f.path);
    cleanup.push(() => restarted.close());
    const status = await new OrchestratorController(restarted, run, {
      dispatcher: f.driverFactory([]),
    }).run();
    expect(status.agents.isolatedUnreadableOwners).toBe(1);
    expect(
      restarted.orchestration.workspaceInspections.get(run, inspection.inspectionId).outcome,
    ).toBe("failed");
    expect(messageStatus()).toBe("superseded");
    await new OrchestratorController(restarted, run, { dispatcher: f.driverFactory([]) }).run();
    const incidents = restarted.orchestration
      .observations(run)
      .filter((entry) => entry.kind.startsWith("recovery.owner_"));
    expect(incidents.map((entry) => entry.kind)).toEqual([
      "recovery.owner_uncontained",
      "recovery.owner_isolated",
    ]);
    expect(new Set(incidents.map((entry) => entry.sourceEventId)).size).toBe(2);
    expect(
      (
        db
          .prepare(
            "SELECT record_json FROM agent_instances WHERE run_id=? AND agent_id=? AND generation=?",
          )
          .get(run, agent.agentId, agent.agentGeneration) as { record_json: string }
      ).record_json,
    ).toBe(raw);
    restarted.orchestration.operatorControl(run, status.control.controlVersion, { kind: "resume" });
    await new OrchestratorController(restarted, run, {
      dispatcher: f.driverFactory([question]),
    }).run();
    expect(f.observed).toHaveLength(1);
    expect(restarted.orchestration.agents.operationalInstances(run)).toHaveLength(1);
  });

  it("contains redirected readable-owner turns through relational ownership", async () => {
    const f = fixture();
    const run = f.state.runId;
    const journal = f.store.orchestration;
    const lease = f.store.acquireLease(run);
    const authority: ControllerAuthority = {
      runId: run,
      ownerToken: lease.ownerToken,
      leaseId: lease.leaseId,
    };
    const settings = { model: "gpt-6-astra", reasoningEffort: "high" as const };
    const contract = SdkAgentSessionContractSchema.parse({
      backend: "codex",
      runtime: "sdk",
      requested: settings,
      effective: settings,
    });
    const reserveAgent = (label: string) => {
      const workspace = journal.agents.reserveWorkspace(
        authority,
        {
          root: join(f.root, "workspaces"),
          purpose: "coordinator",
          sourceMode: "immutable",
          baselineRevision: f.state.epicBaseRevision,
        },
        journal.control(run).controlVersion,
      );
      mkdirSync(workspace.path, { recursive: true, mode: 0o700 });
      writeFileSync(join(workspace.path, `${label}.txt`), "fixture\n");
      journal.agents.markWorkspaceReady(authority, workspace, `${label}-fingerprint`);
      return journal.agents.reserveAgent(
        authority,
        {
          ...workspace,
          role: "orchestrator",
          purpose: "coordination",
          taskId: null,
          candidateId: null,
          instructions: `Readable recovery fixture ${label}`,
          confinementProfile: "epicd-isolated",
          contract,
        },
        journal.control(run).controlVersion,
      );
    };
    const preparedOwner = reserveAgent("redirected-prepared");
    const stoppedOwner = reserveAgent("redirected-stopped");
    const unrelated = journal.agents.reserveWorkspace(
      authority,
      {
        root: join(f.root, "workspaces"),
        purpose: "diagnostic",
        sourceMode: "mutable",
        baselineRevision: f.state.epicBaseRevision,
      },
      journal.control(run).controlVersion,
    );
    mkdirSync(unrelated.path, { recursive: true, mode: 0o700 });
    journal.agents.markWorkspaceReady(authority, unrelated, "unrelated-fingerprint");
    const prepared = journal.agents.prepareTurn(
      authority,
      preparedOwner,
      "redirected-readable-prepared",
      "Cancel through the relational owner",
      { type: "object" },
      journal.control(run).controlVersion,
    );
    const stopped = journal.agents.prepareTurn(
      authority,
      stoppedOwner,
      "redirected-readable-stopped",
      "Settle through the relational owner",
      { type: "object" },
      journal.control(run).controlVersion,
    );
    const launches = new ControlledLaunches({
      root: stoppedOwner.execution.runtimeRoot,
      executable: stoppedOwner.execution.executable,
      turnTimeoutMs: stoppedOwner.execution.turnTimeoutMs,
    });
    const { manifest } = launches.reserve(journal, authority, stopped.identity);
    const stop = {
      generation: manifest.generation,
      stoppedAt: new Date().toISOString(),
      kind: "stopped" as const,
      code: 1,
      signal: null,
      interrupted: true,
      processTreeStopped: true as const,
    };
    journal.agents.recordLaunchStop(authority, stopped.identity, stop);
    const db = new Database(f.path);
    cleanup.push(() => db.close());
    const redirectedPrepared = redirectTurnWorkspace(db, run, prepared.identity.turnId, unrelated);
    const redirectedStopped = redirectTurnWorkspace(db, run, stopped.identity.turnId, unrelated);
    expect(journal.agents.turnForRecovery(run, redirectedPrepared).ownerValidity).toBe(
      "unreadable",
    );
    expect(journal.agents.turnForRecovery(run, redirectedStopped).ownerValidity).toBe(
      "not_required",
    );
    f.store.releaseLease(run, lease.ownerToken);

    await expect(
      new OrchestratorController(f.store, run, { dispatcher: f.driverFactory([]) }).run(),
    ).rejects.toThrow("readable owner(s) with damaged turn history");

    expect(f.observed).toHaveLength(0);
    expect(journal.agents.instance(run, preparedOwner)).toMatchObject({
      status: "reserved",
      activeTurnId: null,
    });
    expect(journal.agents.instance(run, stoppedOwner)).toMatchObject({
      status: "reserved",
      activeTurnId: null,
    });
    expect(journal.agents.workspace(run, preparedOwner)).toMatchObject({
      status: "quarantined",
      activeTurnId: null,
    });
    expect(journal.agents.workspace(run, stoppedOwner)).toMatchObject({
      status: "quarantined",
      activeTurnId: null,
    });
    expect(journal.agents.workspace(run, unrelated)).toMatchObject({
      status: "ready",
      activeTurnId: null,
    });
    expect(journal.agents.turnForRecovery(run, redirectedPrepared).turn).toMatchObject({
      status: "cancelled",
      resultEligible: false,
    });
    expect(journal.agents.turnForRecovery(run, redirectedStopped).turn).toMatchObject({
      status: "cancelled",
      stopEvidence: JSON.stringify(stop),
      resultEligible: false,
    });
    expect(
      journal.observations(run).filter((entry) => entry.kind === "recovery.owner_uncontained"),
    ).toHaveLength(2);
  });

  it("recovers submitted turns from exact stop proof when owning agent records are malformed", async () => {
    const f = fixture();
    const run = f.state.runId;
    const journal = f.store.orchestration;
    const lease = f.store.acquireLease(run);
    const authority: ControllerAuthority = {
      runId: run,
      ownerToken: lease.ownerToken,
      leaseId: lease.leaseId,
    };
    const settings = { model: "gpt-6-astra", reasoningEffort: "high" as const };
    const contract = SdkAgentSessionContractSchema.parse({
      backend: "codex",
      runtime: "sdk",
      requested: settings,
      effective: settings,
    });
    const reserveAgent = (label: string) => {
      const workspace = journal.agents.reserveWorkspace(
        authority,
        {
          root: join(f.root, "workspaces"),
          purpose: "coordinator",
          sourceMode: "immutable",
          baselineRevision: f.state.epicBaseRevision,
        },
        journal.control(run).controlVersion,
      );
      mkdirSync(workspace.path, { recursive: true, mode: 0o700 });
      writeFileSync(join(workspace.path, `${label}.txt`), "fixture\n");
      journal.agents.markWorkspaceReady(authority, workspace, `${label}-fingerprint`);
      return journal.agents.reserveAgent(
        authority,
        {
          ...workspace,
          role: "orchestrator",
          purpose: "coordination",
          taskId: null,
          candidateId: null,
          instructions: `Recovery fixture ${label}`,
          confinementProfile: "epicd-isolated",
          contract,
        },
        journal.control(run).controlVersion,
      );
    };
    const validAgent = reserveAgent("valid");
    const validPreparedAgent = reserveAgent("valid-prepared");
    const corruptAgent = reserveAgent("corrupt");
    const corruptStoppedAgent = reserveAgent("corrupt-stopped");
    const validTurn = journal.agents.prepareTurn(
      authority,
      validAgent,
      "recovery-valid-turn",
      "Recover the valid submitted turn",
      { type: "object" },
      journal.control(run).controlVersion,
    );
    const launches = new ControlledLaunches({
      root: validAgent.execution.runtimeRoot,
      executable: validAgent.execution.executable,
      turnTimeoutMs: validAgent.execution.turnTimeoutMs,
    });
    launches.reserve(journal, authority, validTurn.identity);
    const validPreparedTurn = journal.agents.prepareTurn(
      authority,
      validPreparedAgent,
      "recovery-valid-prepared-turn",
      "Cancel the valid never-submitted turn through its readable owner",
      { type: "object" },
      journal.control(run).controlVersion,
    );
    const corruptTurn = journal.agents.prepareTurn(
      authority,
      corruptAgent,
      "recovery-corrupt-turn",
      "Preserve the malformed owner turn",
      { type: "object" },
      journal.control(run).controlVersion,
    );
    const corruptStoppedTurn = journal.agents.prepareTurn(
      authority,
      corruptStoppedAgent,
      "recovery-corrupt-stopped-turn",
      "Recover this turn from its exact persisted launch-stop receipt",
      { type: "object" },
      journal.control(run).controlVersion,
    );
    const corruptStoppedLaunch = launches.reserve(
      journal,
      authority,
      corruptStoppedTurn.identity,
    ).manifest;
    const corruptStop = {
      generation: corruptStoppedLaunch.generation,
      stoppedAt: new Date().toISOString(),
      kind: "stopped" as const,
      code: 1,
      signal: null,
      interrupted: true,
      processTreeStopped: true as const,
    };
    journal.agents.recordLaunchStop(authority, corruptStoppedTurn.identity, corruptStop);
    const corruptWorkspace = journal.agents.workspace(run, corruptTurn.identity);
    const corruptStoppedWorkspace = journal.agents.workspace(run, corruptStoppedTurn.identity);
    const persistedCorruptAgent = journal.agents.instance(run, corruptTurn.identity);
    const persistedCorruptStoppedAgent = journal.agents.instance(run, corruptStoppedTurn.identity);
    const corruptRecord = structuredClone(persistedCorruptAgent) as Record<string, unknown>;
    corruptRecord.schemaVersion = 1;
    delete corruptRecord.execution;
    const corruptAgentRecord = JSON.stringify(corruptRecord);
    const corruptStoppedRecord = structuredClone(persistedCorruptStoppedAgent) as Record<
      string,
      unknown
    >;
    corruptStoppedRecord.schemaVersion = 1;
    delete corruptStoppedRecord.execution;
    const corruptStoppedAgentRecord = JSON.stringify(corruptStoppedRecord);
    const corruptWorkspaceRecord = JSON.stringify(corruptWorkspace);
    const database = new Database(f.path);
    database
      .prepare(
        "UPDATE agent_instances SET record_json = ? WHERE run_id = ? AND agent_id = ? AND generation = ?",
      )
      .run(corruptAgentRecord, run, corruptAgent.agentId, corruptAgent.agentGeneration);
    database
      .prepare(
        "UPDATE agent_instances SET record_json = ? WHERE run_id = ? AND agent_id = ? AND generation = ?",
      )
      .run(
        corruptStoppedAgentRecord,
        run,
        corruptStoppedAgent.agentId,
        corruptStoppedAgent.agentGeneration,
      );
    database.close();
    expect(() => journal.agents.turns(run)).toThrow();
    journal.operatorControl(run, journal.control(run).controlVersion, { kind: "pause" });
    f.store.releaseLease(run, authority.ownerToken);

    const reconciled: TurnIdentity[] = [];
    let adapterRuns = 0;
    let adapterReconciles = 0;
    const dispatcher: AgentDispatcher = new ControlledAgentDispatcher(journal, {
      "codex:sdk": (dispatchJournal, execution) => {
        const driver = new ControlledSdkRuntime(dispatchJournal, {
          root: execution.runtimeRoot,
          executable: execution.executable,
          turnTimeoutMs: execution.turnTimeoutMs,
        });
        return {
          backend: driver.backend,
          kind: driver.kind,
          run: async (
            dispatchAuthority: ControllerAuthority,
            dispatchIdentity: TurnIdentity,
            signal?: AbortSignal,
          ) => {
            adapterRuns += 1;
            return driver.run(dispatchAuthority, dispatchIdentity, signal);
          },
          reconcile: async (recoveryAuthority: ControllerAuthority, identity: TurnIdentity) => {
            adapterReconciles += 1;
            reconciled.push(identity);
            return driver.reconcile(recoveryAuthority, identity);
          },
        };
      },
    });
    const status = await new OrchestratorController(f.store, run, {
      dispatcher: () => dispatcher,
    }).run();
    expect(status).toMatchObject({
      control: { status: "paused" },
      agents: { unreadableInstances: 2 },
    });

    expect(reconciled).toEqual([validTurn.identity]);
    expect(adapterReconciles).toBe(1);
    expect(adapterRuns).toBe(0);
    expect(
      journal
        .observations(run)
        .filter(
          (observation) =>
            observation.kind === "recovery.owner_isolated" && observation.identity === null,
        ),
    ).toHaveLength(2);
    const recoveredValid = journal.agents.turn(run, validTurn.identity);
    expect(recoveredValid).toMatchObject({
      status: "cancelled",
      result: null,
      resultEligible: false,
      stopEvidence: expect.any(String),
      launch: {
        stop: {
          kind: "not_started",
          code: null,
          signal: null,
          interrupted: true,
          processTreeStopped: true,
        },
      },
    });
    expect(recoveredValid.stopEvidence).toBe(JSON.stringify(recoveredValid.launch!.stop));
    expect(journal.agents.instance(run, validTurn.identity)).toMatchObject({
      status: "reserved",
      provider: null,
      activeTurnId: null,
    });
    const recoveredWorkspace = journal.agents.workspace(run, validTurn.identity);
    expect(recoveredWorkspace).toMatchObject({ status: "ready", activeTurnId: null });
    expect(journal.agents.activeWorkspaceOperation(run, recoveredWorkspace)).toBeNull();
    expect(journal.agents.turn(run, validPreparedTurn.identity)).toMatchObject({
      status: "cancelled",
      stopEvidence: expect.any(String),
    });
    expect(journal.agents.instance(run, validPreparedTurn.identity)).toMatchObject({
      status: "reserved",
      activeTurnId: null,
    });
    expect(journal.agents.workspace(run, validPreparedTurn.identity)).toMatchObject({
      status: "ready",
      activeTurnId: null,
    });
    const after = new Database(f.path);
    try {
      const agentRow = after
        .prepare(
          "SELECT record_json FROM agent_instances WHERE run_id = ? AND agent_id = ? AND generation = ?",
        )
        .get(run, corruptAgent.agentId, corruptAgent.agentGeneration) as { record_json: string };
      const workspaceRow = after
        .prepare(
          "SELECT record_json FROM workspaces WHERE run_id = ? AND workspace_id = ? AND generation = ?",
        )
        .get(run, corruptWorkspace.workspaceId, corruptWorkspace.workspaceGeneration) as {
        record_json: string;
      };
      expect(JSON.parse(agentRow.record_json)).toMatchObject({
        schemaVersion: 1,
        status: "busy",
        activeTurnId: corruptTurn.identity.turnId,
      });
      expect(JSON.parse(agentRow.record_json)).toEqual(JSON.parse(corruptAgentRecord));
      expect(JSON.parse(workspaceRow.record_json)).toMatchObject({
        status: "quarantined",
        activeTurnId: null,
      });
      expect(JSON.parse(workspaceRow.record_json)).not.toEqual(JSON.parse(corruptWorkspaceRecord));
      const stoppedAgentRow = after
        .prepare(
          "SELECT record_json FROM agent_instances WHERE run_id = ? AND agent_id = ? AND generation = ?",
        )
        .get(run, corruptStoppedAgent.agentId, corruptStoppedAgent.agentGeneration) as {
        record_json: string;
      };
      const stoppedWorkspaceRow = after
        .prepare(
          "SELECT record_json FROM workspaces WHERE run_id = ? AND workspace_id = ? AND generation = ?",
        )
        .get(
          run,
          corruptStoppedWorkspace.workspaceId,
          corruptStoppedWorkspace.workspaceGeneration,
        ) as { record_json: string };
      const stoppedTurnRow = after
        .prepare("SELECT record_json FROM agent_turns WHERE run_id = ? AND turn_id = ?")
        .get(run, corruptStoppedTurn.identity.turnId) as { record_json: string };
      expect(stoppedAgentRow.record_json).toBe(corruptStoppedAgentRecord);
      expect(JSON.parse(stoppedWorkspaceRow.record_json)).toMatchObject({
        status: "quarantined",
        activeTurnId: null,
      });
      expect(JSON.parse(stoppedTurnRow.record_json)).toMatchObject({
        status: "cancelled",
        stopRequested: true,
        stopEvidence: JSON.stringify(corruptStop),
        result: null,
        resultEligible: false,
      });
    } finally {
      after.close();
    }
  });

  it.each(["unbound", "stopped", "missing_receipt"] as const)(
    "recovers a %s orphaned bootstrap inspection after settings select a different coordinator",
    async (phase) => {
      const f = fixture(),
        run = f.state.runId,
        journal = f.store.orchestration;
      const create = WorkspaceManager.prototype.create;
      vi.spyOn(WorkspaceManager.prototype, "create").mockImplementationOnce(async function (
        this: WorkspaceManager,
        ...args
      ) {
        await create.apply(this, args);
        throw new Error("Lost creation acknowledgement");
      });
      vi.spyOn(
        journal.workspaceInspections,
        phase === "missing_receipt" ? "recordStop" : "finish",
      ).mockImplementation(() => {
        throw new Error("Lost inspection settlement");
      });
      const reserve = journal.workspaceInspections.reserve.bind(journal.workspaceInspections);
      vi.spyOn(journal.workspaceInspections, "reserve").mockImplementation((...args) => {
        const record = reserve(...args);
        if (phase === "unbound")
          vi.spyOn(commandLifetime, "prepareCommandLifetime").mockRejectedValue(
            new Error("No worker binding"),
          );
        return record;
      });
      await expect(
        new OrchestratorController(f.store, run, { dispatcher: f.driverFactory([]) }).run(),
      ).rejects.toThrow("Lost inspection settlement");
      vi.restoreAllMocks();
      const pending = journal.workspaceInspections.unsettled(run)[0]!;
      expect(pending).toMatchObject({ outcome: null, target: { kind: "materialization" } });
      expect(pending.execution === null).toBe(phase === "unbound");
      expect(journal.agents.instances(run)).toEqual([]);
      const oldWorkspace = journal.agents.workspace(run, pending);
      expect(journal.workspaceCreations.forWorkspace(run, oldWorkspace)?.actionId).toBeNull();
      const preferences = structuredClone(f.state.agentSettings);
      preferences.orchestrator.reasoningEffort = "xhigh";
      f.store.updateAgentSettings(run, preferences);
      journal.operatorControl(run, journal.control(run).controlVersion, {
        kind: "respond",
        escalationId: journal.pendingEscalation(run)!.escalationId,
        message: "Continue with the new coordinator settings",
      });
      const launches = vi.spyOn(commandLifetime, "startDurableCommand");
      const recoverStop = commandLifetime.recoverCommandStop;
      const receiptFault =
        phase === "missing_receipt"
          ? vi
              .spyOn(commandLifetime, "recoverCommandStop")
              .mockImplementation((intent) =>
                intent.operationId === pending.inspectionId
                  ? Promise.resolve(null)
                  : recoverStop(intent),
              )
          : null;
      await new OrchestratorController(f.store, run, {
        dispatcher: f.driverFactory([question]),
      }).run();
      expect(journal.agents.instances(run)).toHaveLength(1);
      expect(journal.agents.instances(run)[0]!.workspaceId).not.toBe(oldWorkspace.workspaceId);
      if (receiptFault) {
        expect(journal.workspaceInspections.get(run, pending.inspectionId)).toEqual(pending);
        expect(journal.agents.activeWorkspaceOperation(run, oldWorkspace)?.stopEvidence).toBeNull();
        expect(journal.control(run).status).toBe("awaiting_user");
        receiptFault.mockRestore();
        // A later startup recovers orphaned reads even without resuming delivery.
        await new OrchestratorController(f.store, run, { dispatcher: f.driverFactory([]) }).run();
        expect(journal.control(run).status).toBe("awaiting_user");
        expect(journal.agents.instances(run)).toHaveLength(1);
      }
      expect(journal.workspaceInspections.unsettled(run)).toEqual([]);
      expect(journal.workspaceInspections.get(run, pending.inspectionId)).toMatchObject({
        outcome: phase === "unbound" ? "failed" : "observed",
        workerResult: pending.workerResult,
      });
      expect(journal.agents.activeWorkspaceOperation(run, oldWorkspace)).toBeNull();
      expect(
        launches.mock.calls.some(([intent]) => intent.operationId === pending.inspectionId),
      ).toBe(false);
      expect(readFileSync(join(oldWorkspace.path, "app.txt"), "utf8")).toBe("unchanged\n");
    },
  );

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
        new OrchestratorController(f.store, run, { dispatcher: f.driverFactory([question]) }).run(),
      ).resolves.toMatchObject({ control: { status: "awaiting_user" } });
      const copies = coordinatorCreations(f.store, run);
      expect(copies).toHaveLength(2);
      // Workspace listings are UUID-sorted, not chronological. Bind each outcome
      // to its bootstrap attempt identity, never to its position or observed status.
      const first = copies.find((copy) =>
        /^coordinator-[a-f0-9]{40}$/.test(copy.creationOperationId ?? ""),
      );
      expect(first).toBeDefined();
      const second = copies.find(
        (copy) => copy.creationOperationId === `${first!.creationOperationId}-attempt-2`,
      );
      expect(first).toMatchObject({ outcome: "failed", stop: { kind: "stopped", code: 1 } });
      expect(second).toMatchObject({ outcome: "created", stop: { kind: "stopped", code: 0 } });
      expect(second!.workspaceId).not.toBe(first!.workspaceId);
      for (const copy of copies) {
        const workspace = journal.agents.workspace(run, copy);
        expect(readFileSync(join(workspace.path, "app.txt"), "utf8")).toBe("unchanged\n");
        expect(journal.agents.activeWorkspaceOperation(run, copy)).toBeNull();
      }
      expect(journal.agents.instances(run)).toHaveLength(1);
      expect(journal.agents.instances(run)[0]!.workspaceId).toBe(second!.workspaceId);
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
          new OrchestratorController(f.store, run, {
            dispatcher: f.driverFactory([question]),
          }).run(),
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
          new OrchestratorController(reopened, run, {
            dispatcher: f.driverFactory([question]),
          }).run(),
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
      new OrchestratorController(f.store, run, { dispatcher: f.driverFactory([question]) }).run(),
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
      new OrchestratorController(reopened, run, { dispatcher: f.driverFactory([question]) }).run(),
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
        dispatcher: f.driverFactory([question]),
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
          dispatcher: f.driverFactory([question]),
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
      new OrchestratorController(f.store, run, { dispatcher: f.driverFactory([question]) }).run(),
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
      dispatcher: f.driverFactory([
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
    await new OrchestratorController(f.store, run, {
      dispatcher: f.driverFactory([question]),
    }).run();
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
      dispatcher: f.driverFactory([{ kind: "inspect_run" }, question]),
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
      dispatcher: f.driverFactory([question]),
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
      dispatcher: f.driverFactory([{ kind: "inspect_run" }, question]),
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
        dispatcher: f.driverFactory([question]),
      }).run();
      expect(journal.action(f.state.runId, pending.actionId)?.status).toBe("failed");
      expect(journal.fixtures.creations(f.state.runId)).toEqual([]);
      expect(journal.trackerCommits.records(f.state.runId)).toEqual([]);
    },
  );
  it("pauses a live coordinator and waits for its supervised stop before releasing ownership", async () => {
    const f = fixture();
    const controller = new OrchestratorController(f.store, f.state.runId, {
      dispatcher: f.driverFactory([question], true),
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
      dispatcher: f.driverFactory([
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
      dispatcher: f.driverFactory(
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
      dispatcher: f.driverFactory([{ kind: "inspect_run" }, question]),
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
    await new OrchestratorController(f.store, run, {
      dispatcher: f.driverFactory([question]),
    }).run();
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
    await new OrchestratorController(reopened, run, {
      dispatcher: f.driverFactory([question]),
    }).run();
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
      dispatcher: () => {
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
        dispatcher: f.driverFactory([question]),
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
        dispatcher: () => {
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
      dispatcher: (store) => {
        const actual = factory(store);
        return {
          assertSupported: actual.assertSupported.bind(actual),
          assertReady: actual.assertReady.bind(actual),
          reconcile: actual.reconcile.bind(actual),
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
