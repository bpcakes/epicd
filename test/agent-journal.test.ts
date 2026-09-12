import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { ControlledLaunches } from "../src/adapters/controlled-launch.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import type { NativeLaunchEndpoint } from "../src/domain/codex-launch.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import {
  SdkAgentSessionContractSchema,
  HerdrAgentSessionContractSchema,
} from "../src/domain/types.js";
import type { AgentIdentity, WorkspaceRecord } from "../src/domain/agents.js";
import type {
  ControllerAuthority,
  KernelAction,
  OrchestratorDecision,
} from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import {
  coordinatorConversationPressure,
  COORDINATOR_CONVERSATION_LIMITS,
} from "../src/orchestrator/conversation.js";
import { classifyProviderFailure, essentialTurnFailure } from "../src/domain/provider-failure.js";

const roots: string[] = [];
const stores: StateStore[] = [];
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(maxWorkers = 4) {
  const root = mkdtempSync(join(tmpdir(), "epicd-agent-journal-"));
  roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new StateStore(path);
  stores.push(store);
  const state = store.create(
    initialRun(),
    RepositoryPolicySchema.parse({ schemaVersion: 1, budgets: { maxWorkers } }),
  );
  const lease = store.acquireLease(state.runId);
  const authority: ControllerAuthority = {
    runId: state.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const journal = store.orchestration;
  const agents = journal.agents;
  const version = () => journal.control(state.runId).controlVersion;
  function workspace(purpose: WorkspaceRecord["purpose"] = "implementation") {
    const record = agents.reserveWorkspace(
      authority,
      {
        root: join(root, "workspaces"),
        purpose,
        sourceMode: ["review", "verification", "coordinator"].includes(purpose)
          ? "immutable"
          : "mutable",
        baselineRevision: "base",
      },
      version(),
    );
    mkdirSync(record.path, { recursive: true });
    return agents.markWorkspaceReady(authority, record, "baseline-fingerprint");
  }
  function reserve(
    purpose: "implementation" | "review" | "specialist" = "implementation",
    replaces?: AgentIdentity,
    runtime: "sdk" | "herdr" = "sdk",
  ) {
    const ws = workspace(purpose === "specialist" ? "diagnostic" : purpose);
    const settings = { model: "worker-model", reasoningEffort: "high" as const };
    return agents.reserveAgent(
      authority,
      {
        ...ws,
        purpose,
        role: purpose === "review" ? "review" : "implementation",
        taskId: "demo.1",
        candidateId: purpose === "review" ? "candidate" : null,
        instructions: "Investigate and report the actual outcome",
        contract: (runtime === "sdk"
          ? SdkAgentSessionContractSchema
          : HerdrAgentSessionContractSchema
        ).parse({
          runtime,
          requested: settings,
          effective: settings,
        }),
        confinementProfile: "test-only-supervisor",
        ...(replaces ? { replaces } : {}),
      },
      version(),
    );
  }
  function ready(
    purpose: "implementation" | "review" | "specialist" = "implementation",
    replaces?: AgentIdentity,
  ) {
    const agent = reserve(purpose, replaces);
    return agents.bindProvider(authority, agent, { runtime: "sdk", sessionId: randomUUID() });
  }
  const prepare = (
    agent: AgentIdentity,
    operationId = randomUUID(),
    instructions = "Run the assigned check",
  ) =>
    agents.prepareTurn(authority, agent, operationId, instructions, { type: "object" }, version());
  const submit = (agent: AgentIdentity) => {
    const turn = prepare(agent);
    agents.markSubmitting(authority, turn.identity);
    return agents.acknowledgePrompt(
      authority,
      turn.identity,
      turn.promptDigest,
      "Fixture observed exact submitted turn",
    );
  };
  const db = new Database(path);
  databases.push(db);
  const launches = new ControlledLaunches({
    root: join(root, "runtime"),
    executable: process.execPath,
    authCachePath: null,
  });
  return {
    root,
    path,
    store,
    journal,
    agents,
    authority,
    version,
    workspace,
    reserve,
    ready,
    prepare,
    submit,
    db,
    launches,
    native: (purpose: "implementation" | "review" = "implementation") =>
      reserve(purpose, undefined, "herdr"),
  };
}

function nativeEndpoint(root: string): NativeLaunchEndpoint {
  return {
    sessionName: "owned",
    socketPath: join(root, "herdr.sock"),
    socketIdentity: "one-server-incarnation",
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    terminalId: randomUUID(),
    name: "owned-agent",
  };
}
function decision(setup: ReturnType<typeof fixture>, action: KernelAction): OrchestratorDecision {
  const ticket = setup.journal.beginDecision(
    setup.authority,
    setup.journal.latestObservationCursor(setup.authority.runId),
    setup.version(),
  );
  return {
    explanation: "Choose a useful agent action",
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

describe("coordinator conversation accounting", () => {
  it.each(["sdk", "herdr"] as const)(
    "bounds %s history without relying on usage or agent prose",
    (runtime) => {
      const f = fixture(),
        agent = f.reserve("specialist", undefined, runtime);
      const turn = f.prepare(agent);
      const turns = Array.from({ length: COORDINATOR_CONVERSATION_LIMITS.turns - 1 }, () =>
        structuredClone(turn),
      );
      const before = coordinatorConversationPressure(agent, turns);
      expect(before.reasons).toEqual([]);
      expect(before.usageTurns).toBe(0);
      turns.push(turn);
      expect(coordinatorConversationPressure(agent, turns).reasons).toEqual(["turn_limit"]);
      expect(
        coordinatorConversationPressure(agent, [{ ...turn, result: { inputTokens: 999999999 } }])
          .reportedInputTokens,
      ).toBe(0);
      expect(coordinatorConversationPressure({ ...agent, agentGeneration: 2 }, turns).turns).toBe(
        0,
      );
      expect(coordinatorConversationPressure({ ...agent, runId: "foreign" }, turns).turns).toBe(0);
    },
  );
  it("uses byte and usage boundaries independently, without summing repeated cached input", () => {
    const f = fixture(),
      agent = f.reserve("specialist"),
      turn = f.prepare(agent);
    const base = coordinatorConversationPressure(agent, [turn]).retainedBytes;
    const padded = structuredClone(turn);
    padded.prompt.instructions += "x".repeat(
      COORDINATOR_CONVERSATION_LIMITS.retainedBytes - base - 1,
    );
    expect(coordinatorConversationPressure(agent, [padded]).reasons).toEqual([]);
    padded.prompt.instructions += "x";
    expect(coordinatorConversationPressure(agent, [padded]).reasons).toEqual(["byte_limit"]);
    turn.sdkUsage = {
      inputTokens: COORDINATOR_CONVERSATION_LIMITS.reportedInputTokens - 1,
      cachedInputTokens: 0,
      outputTokens: 1,
    };
    expect(coordinatorConversationPressure(agent, [turn, turn]).reasons).toEqual([]);
    turn.sdkUsage.inputTokens++;
    expect(coordinatorConversationPressure(agent, [turn]).reasons).toEqual(["usage_pressure"]);
  });
  it("persists exact-launch SDK usage once, survives reopen, and rejects late or conflicting reports", () => {
    const f = fixture(),
      agent = f.reserve("specialist"),
      prepared = f.prepare(agent);
    const { turn, manifest } = f.launches.reserve(f.journal, f.authority, prepared.identity);
    const usage = { inputTokens: 50000, cachedInputTokens: 40000, outputTokens: 800 };
    const report = (generation = manifest.generation, input = usage) =>
      f.agents.recordSdkUsage(f.authority, turn.identity, generation, input);
    expect(report).toThrow("acknowledged");
    f.agents.acknowledgePrompt(
      f.authority,
      turn.identity,
      turn.promptDigest,
      "Fixture acknowledgement",
    );
    expect(() => report(randomUUID())).toThrow("acknowledged");
    expect(() => report(manifest.generation, { ...usage, inputTokens: -1 })).toThrow();
    expect(report().sdkUsage).toEqual(usage);
    expect(report().sdkUsage).toEqual(usage);
    expect(() => report(manifest.generation, { ...usage, outputTokens: 801 })).toThrow("immutable");
    const reopened = new StateStore(f.path);
    stores.push(reopened);
    expect(reopened.orchestration.agents.turn(f.authority.runId, turn.identity).sdkUsage).toEqual(
      usage,
    );
    expect(
      f.journal.observations(f.authority.runId).filter((event) => event.kind === "agent.sdk_usage"),
    ).toHaveLength(1);
    f.agents.recordLaunchStop(f.authority, turn.identity, {
      generation: manifest.generation,
      stoppedAt: new Date().toISOString(),
      kind: "stopped",
      code: 0,
      signal: null,
      interrupted: false,
      processTreeStopped: true,
    });
    expect(report).toThrow("unstopped");
  });
  it("preserves the first exact-launch provider failure without treating it as stop evidence", () => {
    const f = fixture(),
      agent = f.reserve("specialist"),
      prepared = f.prepare(agent);
    const { turn, manifest } = f.launches.reserve(f.journal, f.authority, prepared.identity);
    const sessionId = randomUUID();
    f.agents.bindTurnProvider(f.authority, turn.identity, { runtime: "sdk", sessionId });
    f.agents.acknowledgePrompt(
      f.authority,
      turn.identity,
      turn.promptDigest,
      "Fixture acknowledgement",
    );
    const failure = essentialTurnFailure(
      turn.identity,
      manifest.generation,
      sessionId,
      "2026-09-11T10:00:00.000Z",
      classifyProviderFailure({
        channel: "sdk",
        event: "error",
        message: "Unknown provider failure",
      }),
      { artifactIds: [], omission: "sink_failed" },
    );
    expect(
      f.agents.recordEssentialFailure(f.authority, turn.identity, failure).essentialFailure,
    ).toEqual(failure);
    expect(
      f.agents.recordEssentialFailure(f.authority, turn.identity, failure).essentialFailure,
    ).toEqual(failure);
    expect(() =>
      f.agents.recordEssentialFailure(f.authority, turn.identity, {
        ...failure,
        message: "A later cleanup failure",
      }),
    ).toThrow("first provider failure");
    const indeterminate = f.agents.markIndeterminate(
      f.authority,
      turn.identity,
      "No trusted stop receipt",
    );
    expect(indeterminate).toMatchObject({
      status: "indeterminate",
      stopEvidence: null,
      essentialFailure: failure,
    });
    expect(f.agents.instance(f.authority.runId, agent).activeTurnId).toBe(turn.identity.turnId);
    expect(f.agents.workspace(f.authority.runId, agent).activeTurnId).toBe(turn.identity.turnId);
  });

  it("does not synthesize an essential-failure field when reading old turn records", () => {
    const f = fixture();
    const turn = f.prepare(f.reserve("specialist"));
    expect(Object.hasOwn(turn, "essentialFailure")).toBe(false);
    const reopened = new StateStore(f.path);
    stores.push(reopened);
    expect(
      Object.hasOwn(
        reopened.orchestration.agents.turn(f.authority.runId, turn.identity),
        "essentialFailure",
      ),
    ).toBe(false);
  });
  it("rolls back accounting if its audit cannot be recorded", () => {
    const f = fixture(),
      agent = f.reserve("specialist"),
      prepared = f.prepare(agent);
    const { turn, manifest } = f.launches.reserve(f.journal, f.authority, prepared.identity);
    f.agents.acknowledgePrompt(
      f.authority,
      turn.identity,
      turn.promptDigest,
      "Fixture acknowledgement",
    );
    f.db.exec(`CREATE TRIGGER fail_usage BEFORE INSERT ON observations
      WHEN json_extract(NEW.observation_json, '$.kind') = 'agent.sdk_usage'
      BEGIN SELECT RAISE(ABORT, 'usage audit unavailable'); END`);
    expect(() =>
      f.agents.recordSdkUsage(f.authority, turn.identity, manifest.generation, {
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 10,
      }),
    ).toThrow("usage audit unavailable");
    expect(f.agents.turn(f.authority.runId, turn.identity).sdkUsage).toBeNull();
  });
  it("retirement cannot erase pending messages or treat an unconfirmed launch as stopped", () => {
    const f = fixture(),
      agent = f.reserve("specialist"),
      prepared = f.prepare(agent);
    f.launches.reserve(f.journal, f.authority, prepared.identity);
    expect(() =>
      f.agents.retireStoppedAgent(f.authority, agent, "Bounded context rollover"),
    ).toThrow("every exact turn");
    expect(f.agents.instance(f.authority.runId, agent).status).toBe("busy");
    const idle = f.reserve("specialist");
    const message = f.agents.enqueueAgentMessage(
      f.authority,
      idle,
      randomUUID(),
      "Keep this instruction",
    );
    expect(() =>
      f.agents.retireStoppedAgent(f.authority, idle, "Bounded context rollover"),
    ).toThrow("pending instructions");
    expect(f.agents.messages(f.authority.runId, idle)).toEqual([message]);
    expect(f.agents.instance(f.authority.runId, idle).status).toBe("reserved");
  });
});

describe("durable agent coordination", () => {
  it.each(["active", "paused", "awaiting_user", "blocked"] as const)(
    "admits and settles recovery inspections while %s",
    (status) => {
      const setup = fixture();
      const workspace = setup.workspace();
      if (status !== "active") setup.journal.changeStatus(setup.authority, status);
      const inspection = setup.journal.workspaceInspections.reserve(
        setup.authority,
        join(setup.root, "workspaces"),
        workspace,
        { kind: "materialization" },
      );
      expect(setup.agents.activeWorkspaceOperation(setup.authority.runId, workspace)).toMatchObject(
        {
          operationId: inspection.workspaceOperationId,
          stopEvidence: null,
        },
      );
      // An unbound reservation settles by cancellation without starting a worker.
      expect(
        setup.journal.workspaceInspections.finish(setup.authority, inspection.inspectionId),
      ).toMatchObject({ outcome: "failed", execution: null });
      expect(setup.agents.activeWorkspaceOperation(setup.authority.runId, workspace)).toBeNull();
      expect(setup.journal.control(setup.authority.runId).status).toBe(status);
    },
  );

  it("rejects new inspection reservations after completion while retaining settled recovery", async () => {
    const setup = fixture();
    const workspace = setup.workspace();
    const root = join(setup.root, "workspaces");
    const inspection = setup.journal.workspaceInspections.reserve(
      setup.authority,
      root,
      workspace,
      { kind: "materialization" },
    );
    const settled = setup.journal.workspaceInspections.finish(
      setup.authority,
      inspection.inspectionId,
    );
    // Seed terminal control to isolate admission; this does not simulate delivery proof.
    setup.db
      .prepare("UPDATE orchestration_runs SET status = 'complete' WHERE run_id = ?")
      .run(setup.authority.runId);
    const control = setup.journal.control(setup.authority.runId);
    const inspections = setup.db.prepare("SELECT * FROM workspace_inspections").all();
    const operations = setup.db.prepare("SELECT * FROM workspace_operations").all();
    const observations = setup.db.prepare("SELECT * FROM observations").all();

    expect(() =>
      setup.journal.workspaceInspections.reserve(setup.authority, root, workspace, {
        kind: "materialization",
      }),
    ).toThrowError(expect.objectContaining({ code: "run_not_active", message: "Run is complete" }));
    expect(setup.db.prepare("SELECT * FROM workspace_inspections").all()).toEqual(inspections);
    expect(setup.db.prepare("SELECT * FROM workspace_operations").all()).toEqual(operations);
    expect(setup.db.prepare("SELECT * FROM observations").all()).toEqual(observations);
    expect(setup.agents.activeWorkspaceOperation(setup.authority.runId, workspace)).toBeNull();
    expect(
      setup.journal.workspaceInspections.get(setup.authority.runId, inspection.inspectionId),
    ).toEqual(settled);
    const manager = new WorkspaceManager(setup.journal, root);
    await expect(manager.inspectMaterialization(setup.authority, workspace)).rejects.toMatchObject({
      code: "run_not_active",
    });
    expect(await manager.reconcileInspection(setup.authority, inspection.inspectionId)).toEqual(
      settled,
    );
    expect(setup.journal.control(setup.authority.runId)).toEqual(control);
  });

  it.each(["capture", "validation", "publication"] as const)(
    "keeps a %s operation's custody when readiness inspection is requested",
    async (kind) => {
      const setup = fixture();
      const workspace = setup.workspace();
      const operation = setup.agents.beginWorkspaceOperation(
        setup.authority,
        workspace,
        kind,
        setup.version(),
      );
      const manager = new WorkspaceManager(setup.journal, join(setup.root, "workspaces"));
      await expect(
        manager.inspectMaterialization(setup.authority, workspace),
      ).rejects.toMatchObject({
        code: "workspace_busy",
      });
      expect(setup.journal.workspaceInspections.records(setup.authority.runId)).toEqual([]);
      expect(setup.agents.activeWorkspaceOperation(setup.authority.runId, workspace)).toEqual(
        operation,
      );
    },
  );

  it.each(["missing", "null", "different_path"] as const)(
    "rejects a %s materialized workspace identity without changing its stored record",
    (kind) => {
      const setup = fixture();
      const workspace = setup.workspace();
      expect(workspace.directory?.path).toBe(workspace.path);
      const invalid: Record<string, unknown> = { ...workspace };
      if (kind === "missing") delete invalid.directory;
      else if (kind === "null") invalid.directory = null;
      else
        invalid.directory = { ...workspace.directory, path: join(workspace.path, "replacement") };
      setup.db
        .prepare("UPDATE workspaces SET record_json = ? WHERE workspace_id = ?")
        .run(JSON.stringify(invalid), workspace.workspaceId);
      const raw = () =>
        setup.db
          .prepare("SELECT record_json FROM workspaces WHERE workspace_id = ?")
          .get(workspace.workspaceId);
      const before = raw();
      const control = setup.journal.control(setup.authority.runId);
      expect(() => setup.agents.workspace(setup.authority.runId, workspace)).toThrow();
      expect(() => setup.agents.workspaces(setup.authority.runId)).toThrow();
      expect(raw()).toEqual(before);
      expect(setup.journal.control(setup.authority.runId)).toEqual(control);
    },
  );

  it("rejects a missing workspace creation binding without normalizing persisted data", () => {
    const setup = fixture();
    const workspace = setup.workspace();
    expect(workspace.creationOperationId).toBeNull();
    setup.db
      .prepare(
        "UPDATE workspaces SET record_json = json_remove(record_json, '$.creationOperationId') WHERE workspace_id = ?",
      )
      .run(workspace.workspaceId);
    const raw = () =>
      setup.db
        .prepare("SELECT record_json FROM workspaces WHERE workspace_id = ?")
        .get(workspace.workspaceId);
    const before = raw();
    const control = setup.journal.control(setup.authority.runId);
    expect(() => setup.agents.workspace(setup.authority.runId, workspace)).toThrow();
    expect(() => setup.agents.workspaces(setup.authority.runId)).toThrow();
    expect(raw()).toEqual(before);
    expect(setup.journal.control(setup.authority.runId)).toEqual(control);
  });

  it.each([
    ["sdk", "$.launch"],
    ["sdk", "$.launch.native"],
    ["herdr", "$.launch"],
    ["herdr", "$.launch.native"],
  ] as const)(
    "rejects an incomplete %s turn (%s) without forgetting its launch",
    (runtime, field) => {
      const setup = fixture();
      const agent = runtime === "herdr" ? setup.native() : setup.ready();
      const prepared = setup.prepare(agent);
      const { turn } = setup.launches.reserve(setup.journal, setup.authority, prepared.identity);
      const endpoint = nativeEndpoint(setup.root);
      if (runtime === "herdr")
        setup.agents.bindNativeLaunch(setup.authority, turn.identity, endpoint);
      const complete = setup.agents.turn(setup.authority.runId, turn.identity);
      expect(complete.launch).not.toBeNull();
      if (runtime === "herdr") expect(complete.launch?.native).toEqual(endpoint);
      else expect(complete.launch?.native).toBeNull();
      setup.db
        .prepare(
          "UPDATE agent_turns SET record_json = json_remove(record_json, ?) WHERE turn_id = ?",
        )
        .run(field, turn.identity.turnId);
      const raw = () =>
        setup.db
          .prepare("SELECT record_json FROM agent_turns WHERE turn_id = ?")
          .get(turn.identity.turnId);
      const before = raw();
      const control = setup.journal.control(setup.authority.runId);
      const workspace = setup.agents.workspace(setup.authority.runId, turn.identity);
      expect(() => setup.agents.turn(setup.authority.runId, turn.identity)).toThrow();
      expect(() => setup.agents.turns(setup.authority.runId)).toThrow();
      expect(raw()).toEqual(before);
      expect(setup.journal.control(setup.authority.runId)).toEqual(control);
      expect(setup.agents.workspace(setup.authority.runId, turn.identity)).toEqual(workspace);
    },
  );

  it("binds a native terminal once before accepting provider identity and never reuses it for a later turn", () => {
    const setup = fixture();
    const agent = setup.native();
    const prepared = setup.prepare(agent);
    const { turn, manifest } = setup.launches.reserve(
      setup.journal,
      setup.authority,
      prepared.identity,
    );
    const endpoint = nativeEndpoint(setup.root);
    const provider = {
      runtime: "herdr" as const,
      name: endpoint.name,
      paneId: endpoint.paneId,
      tabId: endpoint.tabId,
      terminalId: endpoint.terminalId,
      sessionId: randomUUID(),
    };
    expect(() => setup.agents.bindTurnProvider(setup.authority, turn.identity, provider)).toThrow(
      "bound launch endpoint",
    );
    expect(
      setup.agents.bindNativeLaunch(setup.authority, turn.identity, endpoint).launch?.native,
    ).toEqual(endpoint);
    expect(
      setup.agents.bindNativeLaunch(setup.authority, turn.identity, endpoint).launch?.native,
    ).toEqual(endpoint);
    expect(() =>
      setup.agents.bindNativeLaunch(setup.authority, turn.identity, {
        ...endpoint,
        terminalId: "replacement",
      }),
    ).toThrow("cannot be replaced");
    expect(() =>
      setup.agents.bindTurnProvider(setup.authority, turn.identity, {
        ...provider,
        paneId: "another-pane",
      }),
    ).toThrow("bound launch endpoint");
    setup.agents.bindTurnProvider(setup.authority, turn.identity, { ...provider, sessionId: null });
    setup.agents.bindTurnProvider(setup.authority, turn.identity, provider);
    setup.agents.acknowledgePrompt(
      setup.authority,
      turn.identity,
      turn.promptDigest,
      "Fixture exact accepted input",
    );
    setup.agents.recordLaunchStop(setup.authority, turn.identity, {
      generation: manifest.generation,
      kind: "stopped",
      code: 0,
      signal: null,
      interrupted: false,
      processTreeStopped: true,
      stoppedAt: new Date().toISOString(),
    });
    setup.agents.finishTurn(setup.authority, turn.identity, {
      status: "completed",
      result: {},
      stopEvidence: "Fixture trusted process stop",
    });

    const next = setup.launches.reserve(
      setup.journal,
      setup.authority,
      setup.prepare(agent).identity,
    ).turn;
    expect(() => setup.agents.bindNativeLaunch(setup.authority, next.identity, endpoint)).toThrow(
      "another launch",
    );
    const nextEndpoint = {
      ...endpoint,
      terminalId: randomUUID(),
      paneId: "w1:p2",
      tabId: "w1:t2",
      name: "next-agent",
    };
    setup.agents.bindNativeLaunch(setup.authority, next.identity, nextEndpoint);
    const nextProvider = {
      ...provider,
      name: nextEndpoint.name,
      terminalId: nextEndpoint.terminalId,
      paneId: nextEndpoint.paneId,
      tabId: nextEndpoint.tabId,
    };
    expect(() =>
      setup.agents.bindTurnProvider(setup.authority, next.identity, {
        ...nextProvider,
        sessionId: randomUUID(),
      }),
    ).toThrow("replaced in place");
    expect(
      setup.agents.bindTurnProvider(setup.authority, next.identity, nextProvider).provider,
    ).toEqual(nextProvider);
    expect(() => setup.agents.bindTurnProvider(setup.authority, turn.identity, provider)).toThrow(
      "exact dispatched turn",
    );
    expect(setup.agents.turn(setup.authority.runId, turn.identity).launch?.native).toEqual(
      endpoint,
    );
  });

  it("excludes another native agent from the same terminal and fences old-controller endpoint binding", () => {
    const setup = fixture();
    const first = setup.launches.reserve(
      setup.journal,
      setup.authority,
      setup.prepare(setup.native()).identity,
    ).turn;
    const second = setup.launches.reserve(
      setup.journal,
      setup.authority,
      setup.prepare(setup.native("review")).identity,
    ).turn;
    const endpoint = nativeEndpoint(setup.root);
    setup.agents.bindNativeLaunch(setup.authority, first.identity, endpoint);
    expect(() => setup.agents.bindNativeLaunch(setup.authority, second.identity, endpoint)).toThrow(
      "another launch",
    );
    setup.store.releaseLease(setup.authority.runId, setup.authority.ownerToken);
    const lease = setup.store.acquireLease(setup.authority.runId);
    const authority = {
      runId: setup.authority.runId,
      ownerToken: lease.ownerToken,
      leaseId: lease.leaseId,
    };
    expect(() =>
      setup.agents.bindNativeLaunch(setup.authority, second.identity, nativeEndpoint(setup.root)),
    ).toThrow();
    expect(() =>
      setup.agents.bindNativeLaunch(authority, second.identity, nativeEndpoint(setup.root)),
    ).toThrow("current controlled Herdr launch");
    expect(setup.agents.turn(authority.runId, second.identity).launch?.native).toBeNull();
  });

  it("requires a materialized directory before a workspace can be marked ready", () => {
    const setup = fixture();
    const workspace = setup.agents.reserveWorkspace(
      setup.authority,
      {
        root: join(setup.root, "workspaces"),
        purpose: "implementation",
        sourceMode: "mutable",
        baselineRevision: "base",
      },
      setup.version(),
    );
    mkdirSync(dirname(workspace.path), { recursive: true });
    writeFileSync(workspace.path, "not a directory");
    expect(() =>
      setup.agents.markWorkspaceReady(setup.authority, workspace, "fingerprint"),
    ).toThrow("canonical directory");
    expect(setup.agents.workspace(setup.authority.runId, workspace).status).toBe("reserved");
  });

  it("exposes the latest failed agent report for diagnosis while labeling it as a claim", async () => {
    const setup = fixture();
    const agent = setup.ready();
    const turn = setup.submit(agent);
    setup.agents.finishTurn(setup.authority, turn.identity, {
      status: "completed",
      stopEvidence: "Stopped descendants",
      result: {
        status: "completed",
        tests: [{ command: "browser test", outcome: "failed", detail: "Database unavailable" }],
      },
    });
    const kernel = new ActionKernel(setup.journal);
    const result = await kernel.execute(
      decision(setup, {
        kind: "inspect_agent",
        agentId: agent.agentId,
        agentGeneration: agent.agentGeneration,
      }),
      setup.authority,
    );
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded" || result.result.kind !== "inspection")
      throw new Error("Expected an agent inspection");
    const inspected = JSON.parse(result.result.text);
    expect(inspected.latestResult.turnId).toBe(turn.identity.turnId);
    expect(JSON.parse(inspected.latestResult.claim).tests).toEqual([
      { command: "browser test", outcome: "failed", detail: "Database unavailable" },
    ]);
    expect(inspected.latestResult.evidenceWarning).toContain("not kernel validation");
    expect(inspected.latestResult.truncated).toBe(false);
  });

  it("binds native identities monotonically without sharing a Codex session across runtimes", () => {
    const setup = fixture();
    const sdk = setup.ready("specialist");
    const ws = setup.workspace("review");
    const settings = { model: "review-model", reasoningEffort: "high" as const };
    const native = setup.agents.reserveAgent(
      setup.authority,
      {
        ...ws,
        role: "review",
        purpose: "review",
        taskId: "demo.1",
        candidateId: "candidate",
        instructions: "Review independently",
        confinementProfile: "test-only",
        contract: HerdrAgentSessionContractSchema.parse({
          runtime: "herdr",
          requested: settings,
          effective: settings,
        }),
      },
      setup.version(),
    );
    const provider = {
      runtime: "herdr" as const,
      name: "reviewer",
      paneId: "w1:p1",
      tabId: "w1:t1",
      terminalId: "terminal",
      sessionId: null,
    };
    setup.agents.bindProvider(setup.authority, native, provider);
    expect(() =>
      setup.agents.bindProvider(setup.authority, native, {
        ...provider,
        sessionId: sdk.provider!.sessionId,
      }),
    ).toThrow("already bound");
    expect(
      setup.agents.bindProvider(setup.authority, native, {
        ...provider,
        sessionId: "native-session",
      }).provider?.sessionId,
    ).toBe("native-session");
    expect(() =>
      setup.agents.bindProvider(setup.authority, native, {
        ...provider,
        sessionId: "other-session",
      }),
    ).toThrow("replaced in place");
    expect(() =>
      setup.agents.bindProvider(setup.authority, native, {
        ...provider,
        terminalId: "other-terminal",
        sessionId: "native-session",
      }),
    ).toThrow("replaced in place");
  });

  it("cannot reserve two turns from different SQLite connections for one conversation", () => {
    const setup = fixture();
    const agent = setup.ready();
    const turn = setup.prepare(agent);
    const second = new StateStore(setup.path);
    stores.push(second);
    expect(() =>
      second.orchestration.agents.prepareTurn(
        setup.authority,
        agent,
        randomUUID(),
        "Another turn",
        {},
        setup.version(),
      ),
    ).toThrow("ready agent");
    expect(second.orchestration.agents.turns(setup.authority.runId)).toEqual([turn]);
  });

  it("records a fresh SDK turn before its provider session exists and binds only its exact start event", () => {
    const setup = fixture();
    const agent = setup.reserve();
    const turn = setup.prepare(agent);
    expect(setup.agents.instance(setup.authority.runId, agent).provider).toBeNull();
    expect(() =>
      setup.agents.bindTurnProvider(setup.authority, turn.identity, {
        runtime: "sdk",
        sessionId: "thread",
      }),
    ).toThrow("exact dispatched turn");
    setup.agents.markSubmitting(setup.authority, turn.identity);
    expect(() =>
      setup.agents.bindTurnProvider(
        setup.authority,
        { ...turn.identity, assignmentId: "wrong" },
        { runtime: "sdk", sessionId: "thread" },
      ),
    ).toThrow("identity");
    expect(
      setup.agents.bindTurnProvider(setup.authority, turn.identity, {
        runtime: "sdk",
        sessionId: "thread",
      }),
    ).toMatchObject({ status: "busy", provider: { runtime: "sdk", sessionId: "thread" } });
    expect(() =>
      setup.agents.bindTurnProvider(setup.authority, turn.identity, {
        runtime: "sdk",
        sessionId: "different-thread",
      }),
    ).toThrow("replaced in place");
  });

  it("redacts structured secrets and does not treat an agent claim as kernel validation", () => {
    const setup = fixture();
    const turn = setup.submit(setup.ready());
    const result = setup.agents.finishTurn(setup.authority, turn.identity, {
      status: "completed",
      stopEvidence: "Fixture supervisor stopped",
      result: {
        status: "completed",
        password: "sensitive-password",
        tests: [{ command: "login --token token-value", outcome: "passed" }],
      },
    });
    expect(JSON.stringify(result.result)).not.toContain("sensitive-password");
    expect(JSON.stringify(result.result)).not.toContain("token-value");
    expect(result.resultEligible).toBe(true);
    expect(setup.journal.actions(setup.authority.runId)).toEqual([]);
    expect(
      new ActionKernel(setup.journal)
        .capabilities()
        .find((capability) => capability.kind === "request_commit")?.available,
    ).toBe(false);
  });

  it("persists assignment, provider, and exact prompt before dispatch and survives reopening", () => {
    const setup = fixture();
    const agent = setup.ready();
    const message = setup.agents.enqueueAgentMessage(
      setup.authority,
      agent,
      randomUUID(),
      "Explain the failed browser check",
    );
    const turn = setup.prepare(agent);
    expect(turn.status).toBe("prepared");
    expect(turn.prompt.messages).toEqual([
      { messageId: message.messageId, content: message.content },
    ]);
    const reopened = new StateStore(setup.path);
    stores.push(reopened);
    expect(reopened.orchestration.agents.turn(setup.authority.runId, turn.identity)).toEqual(turn);
    expect(reopened.orchestration.agents.instance(setup.authority.runId, agent)).toMatchObject({
      status: "busy",
      activeTurnId: turn.identity.turnId,
      provider: agent.provider,
    });
    expect(reopened.orchestration.agents.messages(setup.authority.runId, agent)[0]).toMatchObject({
      status: "reserved",
      deliveryTurnId: turn.identity.turnId,
    });
    expect(setup.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("binds queued messages to one prompt and does not resend acknowledged messages on follow-up", () => {
    const setup = fixture();
    const agent = setup.ready();
    const operationId = randomUUID();
    const message = setup.agents.enqueueAgentMessage(
      setup.authority,
      agent,
      operationId,
      "Use no-receipt validation",
    );
    expect(
      setup.agents.enqueueAgentMessage(setup.authority, agent, operationId, message.content),
    ).toEqual(message);
    expect(() =>
      setup.agents.enqueueAgentMessage(
        setup.authority,
        agent,
        operationId,
        "Different instruction",
      ),
    ).toThrow("reused");
    const turn = setup.prepare(agent);
    setup.agents.markSubmitting(setup.authority, turn.identity);
    expect(() =>
      setup.agents.acknowledgePrompt(setup.authority, turn.identity, "wrong", "ack"),
    ).toThrow("different prompt");
    setup.agents.acknowledgePrompt(
      setup.authority,
      turn.identity,
      turn.promptDigest,
      "Exact prompt accepted",
    );
    expect(setup.agents.messages(setup.authority.runId, agent)[0]?.status).toBe("acknowledged");
    const late = setup.agents.enqueueAgentMessage(
      setup.authority,
      agent,
      randomUUID(),
      "Investigate a second symptom",
    );
    const result = setup.agents.finishTurn(setup.authority, turn.identity, {
      status: "completed",
      result: { status: "completed" },
      stopEvidence: "Supervisor reaped turn descendants",
    });
    expect(result.resultEligible).toBe(true); // Eligible agent claim, not validation/review evidence.
    const next = setup.prepare(agent);
    expect(next.prompt.messages.map((entry) => entry.messageId)).toEqual([late.messageId]);
    expect(next.identity.turnId).not.toBe(turn.identity.turnId);
  });

  it("keeps uncertain submissions busy and never silently redelivers their messages", () => {
    const setup = fixture();
    const agent = setup.ready();
    const message = setup.agents.enqueueAgentMessage(
      setup.authority,
      agent,
      randomUUID(),
      "Do the bounded diagnosis",
    );
    const turn = setup.prepare(agent);
    setup.agents.markSubmitting(setup.authority, turn.identity);
    setup.agents.markIndeterminate(
      setup.authority,
      turn.identity,
      "Controller lost connection after prompt submission",
    );
    expect(() => setup.prepare(agent)).toThrow("ready agent");
    expect(() => setup.agents.markSubmitting(setup.authority, turn.identity)).toThrow();
    expect(() => setup.agents.cancelPreparedTurn(setup.authority, turn.identity)).toThrow(
      "never-dispatched",
    );
    setup.agents.finishTurn(setup.authority, turn.identity, {
      status: "failed",
      result: null,
      stopEvidence: "Supervisor confirmed dead process tree",
    });
    expect(setup.agents.messages(setup.authority.runId, agent)[0]).toMatchObject({
      messageId: message.messageId,
      status: "indeterminate",
      deliveryTurnId: turn.identity.turnId,
    });
    expect(setup.prepare(agent).prompt.messages).toEqual([]);
  });

  it("returns messages to the queue only when cancellation proves the prompt was never submitted", () => {
    const setup = fixture();
    const agent = setup.ready();
    const message = setup.agents.enqueueAgentMessage(
      setup.authority,
      agent,
      randomUUID(),
      "Question",
    );
    const turn = setup.prepare(agent);
    expect(setup.agents.cancelPreparedTurn(setup.authority, turn.identity)).toMatchObject({
      status: "cancelled",
      resultEligible: false,
    });
    expect(setup.agents.messages(setup.authority.runId, agent)[0]).toMatchObject({
      status: "queued",
      deliveryTurnId: null,
    });
    expect(setup.prepare(agent).prompt.messages.map((entry) => entry.messageId)).toEqual([
      message.messageId,
    ]);
  });

  it("keeps cancellation irreversible when restart makes the running outcome uncertain", () => {
    const setup = fixture();
    const agent = setup.ready();
    const turn = setup.submit(agent);
    setup.agents.requestStop(setup.authority, turn.identity);
    setup.agents.markIndeterminate(
      setup.authority,
      turn.identity,
      "Controller restarted before stop acknowledgement",
    );
    expect(
      setup.agents.finishTurn(setup.authority, turn.identity, {
        status: "completed",
        result: { verdict: "approved" },
        stopEvidence: "Confirmed stop",
      }),
    ).toMatchObject({ resultEligible: false, stopRequested: true });
  });

  it("revokes old results, quarantines uncertain work, and rejects a second writer even after replacement", () => {
    const setup = fixture();
    const old = setup.ready();
    const turn = setup.submit(old);
    setup.agents.revokeAgent(setup.authority, old, "Contaminated turn");
    expect(setup.agents.workspace(setup.authority.runId, old).status).toBe("quarantined");
    expect(() => setup.agents.releaseAgent(setup.authority, old)).toThrow("may still be running");
    expect(() =>
      setup.agents.enqueueAgentMessage(setup.authority, old, randomUUID(), "Do more work"),
    ).toThrow("retired");
    const replacement = setup.ready("implementation", old);
    expect(replacement.agentId).toBe(old.agentId);
    expect(replacement.agentGeneration).toBe(2);
    expect(() => setup.prepare(replacement)).toThrow("writer may still be running");
    const finished = setup.agents.finishTurn(setup.authority, turn.identity, {
      status: "completed",
      result: { verdict: "approved" },
      stopEvidence: "Old generation stopped",
    });
    expect(finished.resultEligible).toBe(false);
    expect(() =>
      setup.agents.turn(setup.authority.runId, { ...turn.identity, agentGeneration: 2 }),
    ).toThrow("identity");
    expect(setup.prepare(replacement).identity.workspaceId).not.toBe(turn.identity.workspaceId);
    expect(() => setup.reserve("implementation", old)).toThrow("already has a replacement");
    expect(setup.agents.releaseAgent(setup.authority, old).status).toBe("released");
  });

  it("uses current leases and control versions for every coordination mutation", () => {
    const setup = fixture();
    const agent = setup.ready();
    expect(() =>
      setup.agents.enqueueAgentMessage(
        { ...setup.authority, leaseId: "stale" },
        agent,
        randomUUID(),
        "Question",
      ),
    ).toThrow("lease");
    const turn = setup.prepare(agent);
    setup.journal.changeStatus(setup.authority, "paused");
    expect(() => setup.agents.markSubmitting(setup.authority, turn.identity)).toThrow("paused");
    setup.journal.changeStatus(setup.authority, "active");
    expect(() => setup.agents.markSubmitting(setup.authority, turn.identity)).toThrow(
      "Control facts changed",
    );
    setup.agents.cancelPreparedTurn(setup.authority, turn.identity);
    setup.store.releaseLease(setup.authority.runId, setup.authority.ownerToken);
    const lease = setup.store.acquireLease(setup.authority.runId);
    expect(() => setup.agents.revokeAgent(setup.authority, agent, "Old controller")).toThrow(
      "lease",
    );
    expect(
      setup.agents.revokeAgent(
        { runId: setup.authority.runId, leaseId: lease.leaseId, ownerToken: lease.ownerToken },
        agent,
        "Current controller",
      ).status,
    ).toBe("revoked");
  });

  it("rejects a workspace or provider borrowed from another run or agent", () => {
    const setup = fixture();
    const agent = setup.ready();
    const other = setup.reserve("specialist");
    expect(() => setup.agents.bindProvider(setup.authority, other, agent.provider!)).toThrow(
      "already bound",
    );
    expect(() =>
      setup.agents.bindProvider(setup.authority, other, {
        runtime: "herdr",
        name: "agent",
        paneId: "p",
        tabId: "t",
        terminalId: "x",
        sessionId: null,
      }),
    ).toThrow("pinned runtime");
    expect(() => setup.agents.workspace("another-run", agent)).toThrow("another run");
    expect(() =>
      setup.agents.instance(setup.authority.runId, { ...agent, agentGeneration: 9 }),
    ).toThrow("stale");
  });

  it("does not admit writable review or non-Astra coordinator contracts", () => {
    const setup = fixture();
    const ws = setup.workspace();
    const settings = { model: "wrong-model", reasoningEffort: "high" as const };
    const input = {
      ...ws,
      purpose: "review" as const,
      role: "review" as const,
      taskId: "demo.1",
      candidateId: "candidate",
      instructions: "Review",
      contract: SdkAgentSessionContractSchema.parse({
        runtime: "sdk",
        requested: settings,
        effective: settings,
      }),
      confinementProfile: "fake",
    };
    expect(() => setup.agents.reserveAgent(setup.authority, input, setup.version())).toThrow(
      "immutable candidate",
    );
    const coordinatorWorkspace = setup.workspace("coordinator");
    expect(() =>
      setup.agents.reserveAgent(
        setup.authority,
        { ...input, ...coordinatorWorkspace, purpose: "coordination", role: "orchestrator" },
        setup.version(),
      ),
    ).toThrow("Astra");
    expect(setup.agents.instances(setup.authority.runId)).toEqual([]);
  });

  it("counts uncertain worker operations against the persistent concurrency budget", () => {
    const setup = fixture(1);
    const first = setup.ready("specialist");
    const second = setup.ready("review");
    const turn = setup.submit(first);
    setup.agents.markIndeterminate(setup.authority, turn.identity, "Unknown stop state");
    expect(() => setup.prepare(second)).toThrow("worker limit");
    setup.agents.finishTurn(setup.authority, turn.identity, {
      status: "failed",
      result: null,
      stopEvidence: "Actual stop",
    });
    expect(setup.prepare(second).status).toBe("prepared");
  });

  it("rolls back turn reservation, busy markers, mailbox, and events as one transaction", () => {
    const setup = fixture();
    const agent = setup.ready();
    setup.agents.enqueueAgentMessage(setup.authority, agent, randomUUID(), "Question");
    const cursor = setup.journal.latestObservationCursor(setup.authority.runId);
    setup.db.exec(
      "CREATE TRIGGER fail_turn_event BEFORE INSERT ON observations WHEN json_extract(NEW.observation_json, '$.kind') = 'agent.turn_prepared' BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END",
    );
    expect(() => setup.prepare(agent)).toThrow("injected persistence failure");
    expect(setup.agents.turns(setup.authority.runId)).toEqual([]);
    expect(setup.agents.instance(setup.authority.runId, agent).status).toBe("ready");
    expect(setup.agents.workspace(setup.authority.runId, agent).activeTurnId).toBeNull();
    expect(setup.agents.messages(setup.authority.runId, agent)[0]?.status).toBe("queued");
    expect(setup.journal.latestObservationCursor(setup.authority.runId)).toBe(cursor);
  });

  it("guards turn replay and detects altered persisted prompt contents", () => {
    const setup = fixture();
    const agent = setup.ready();
    const operationId = randomUUID();
    const turn = setup.prepare(agent, operationId);
    expect(setup.prepare(agent, operationId)).toEqual(turn);
    expect(() => setup.prepare(agent, operationId, "Different instruction")).toThrow("reused");
    setup.db
      .prepare(
        "UPDATE agent_turns SET record_json = json_set(record_json, '$.prompt.instructions', 'tampered') WHERE turn_id = ?",
      )
      .run(turn.identity.turnId);
    expect(() => setup.agents.turn(setup.authority.runId, turn.identity)).toThrow("inconsistent");
  });

  it("journals message_agent through the real kernel and rejects revoked targets without stopping the run", async () => {
    const setup = fixture();
    const agent = setup.ready();
    const kernel = new ActionKernel(setup.journal);
    const request = decision(setup, {
      kind: "message_agent",
      agentId: agent.agentId,
      agentGeneration: agent.agentGeneration,
      message: "Explain the failed test",
    });
    const result = await kernel.execute(request, setup.authority);
    expect(result).toMatchObject({
      status: "succeeded",
      result: { kind: "message", delivery: "queued" },
    });
    expect(await kernel.execute(request, setup.authority)).toEqual(result);
    expect(setup.agents.messages(setup.authority.runId, agent)).toHaveLength(1);
    const inspected = await kernel.execute(
      decision(setup, { kind: "inspect_agent", agentId: agent.agentId, agentGeneration: 1 }),
      setup.authority,
    );
    expect(inspected.status).toBe("succeeded");
    setup.agents.revokeAgent(setup.authority, agent, "Replace");
    expect(
      await kernel.execute(decision(setup, request.request.action), setup.authority),
    ).toMatchObject({ status: "rejected", code: "agent_revoked" });
    expect(setup.journal.control(setup.authority.runId).status).toBe("active");
  });

  it("preserves raw agent, turn, assignment, workspace, and mailbox rows during quarantine", () => {
    const setup = fixture();
    const agent = setup.ready();
    setup.agents.enqueueAgentMessage(setup.authority, agent, randomUUID(), "Question");
    setup.submit(agent);
    const originalTurn = setup.db
      .prepare("SELECT * FROM agent_turns WHERE run_id = ?")
      .get(setup.authority.runId);
    const workspaceOperation = setup.agents.beginWorkspaceOperation(
      setup.authority,
      setup.workspace(),
      "capture",
      setup.version(),
    );
    const originalWorkspaceOperation = setup.db
      .prepare("SELECT * FROM workspace_operations WHERE operation_id = ?")
      .get(workspaceOperation.operationId);
    setup.store.releaseLease(setup.authority.runId, setup.authority.ownerToken);
    setup.db
      .prepare("UPDATE runs SET state_json = 'broken' WHERE run_id = ?")
      .run(setup.authority.runId);
    setup.store.quarantineInvalidRun(setup.authority.runId);
    const rows = setup.db
      .prepare("SELECT source_table, row_json FROM quarantined_orchestration WHERE run_id = ?")
      .all(setup.authority.runId) as { source_table: string; row_json: string }[];
    expect(rows.map((row) => row.source_table)).toEqual(
      expect.arrayContaining([
        "agent_instances",
        "agent_assignments",
        "agent_turns",
        "agent_messages",
        "workspaces",
        "workspace_operations",
      ]),
    );
    expect(JSON.parse(rows.find((row) => row.source_table === "agent_turns")!.row_json)).toEqual(
      originalTurn,
    );
    expect(
      JSON.parse(rows.find((row) => row.source_table === "workspace_operations")!.row_json),
    ).toEqual(originalWorkspaceOperation);
    expect(setup.db.pragma("foreign_key_check")).toEqual([]);
    expect(setup.agents.instances(setup.authority.runId)).toEqual([]);
  });
});
