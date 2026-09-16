import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlledAgentDispatcher } from "../src/adapters/agent-dispatch.js";
import type {
  ControlledAgentDispatcherOptions,
  ControlledAgentDriverFactory,
} from "../src/adapters/agent-dispatch.js";
import { ControlledHerdrRuntime } from "../src/adapters/controlled-herdr.js";
import { ControlledLaunches } from "../src/adapters/controlled-launch.js";
import { ControlledSdkRuntime } from "../src/adapters/controlled-sdk.js";
import { controlCodexLaunch, readCodexLaunchStop } from "../src/adapters/codex-launch.js";
import { StateStore } from "../src/adapters/store.js";
import { fixtureAccounts } from "./fixtures/accounts.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { digestJson } from "../src/domain/repository-policy.js";
import type { AgentExecution } from "../src/domain/agent-execution.js";
import type { NativeLaunchEndpoint } from "../src/domain/codex-launch.js";
import {
  HerdrAgentSessionContractSchema,
  SdkAgentSessionContractSchema,
  type RuntimeKind,
} from "../src/domain/types.js";
import { TurnRecordSchema } from "../src/domain/agents.js";
import type { AgentIdentity, AgentInstance, TurnRecord } from "../src/domain/agents.js";
import { ActionKernel } from "../src/kernel/actions.js";
import type {
  ControllerAuthority,
  KernelAction,
  OrchestratorDecision,
  TurnIdentity,
} from "../src/domain/orchestration.js";
import { registerAgentCapabilities, type ControlledAgentDriver } from "../src/kernel/agents.js";

const fixtures: DispatchFixture[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const fixture of fixtures.splice(0).reverse()) fixture.close();
});

type FactoryCalls = {
  construct: number;
  run: number;
  reconcile: number;
  agents: AgentInstance[];
  executions: AgentExecution[];
};

type DispatchFixture = {
  root: string;
  path: string;
  runId: string;
  store: StateStore;
  authority: ControllerAuthority;
  agent: AgentInstance;
  workspacePath: string;
  close: () => void;
  rotateLease: () => ControllerAuthority;
  reopen: () => ControllerAuthority;
};

type FixtureOptions = {
  fakeExecutable?: boolean;
  role?: "orchestrator" | "implementation" | "review";
};

function makeCalls(): Record<RuntimeKind, FactoryCalls> {
  return {
    sdk: { construct: 0, run: 0, reconcile: 0, agents: [], executions: [] },
    herdr: { construct: 0, run: 0, reconcile: 0, agents: [], executions: [] },
  };
}

function contract(runtime: RuntimeKind) {
  const settings = { model: "gpt-6-astra", reasoningEffort: "high" as const };
  return (
    runtime === "sdk" ? SdkAgentSessionContractSchema : HerdrAgentSessionContractSchema
  ).parse({
    backend: "codex",
    runtime,
    requested: settings,
    effective: settings,
  });
}

function makeFixture(runtime: RuntimeKind, options: FixtureOptions = {}): DispatchFixture {
  const root = mkdtempSync(join(tmpdir(), "epicd-agent-dispatch-"));
  const path = join(root, "state.sqlite3");
  const runtimeRoot = join(root, "runtime");
  const workspaceRoot = join(root, "workspaces");
  const role = options.role ?? "orchestrator";
  let fakeExecutableRoot: string | null = null;
  const executable = options.fakeExecutable
    ? (() => {
        fakeExecutableRoot = mkdtempSync("/var/tmp/epicd-agent-dispatch-bin-");
        const bin = fakeExecutableRoot;
        const target = join(bin, "codex");
        const host = join(bin, "codex-code-mode-host");
        writeFileSync(
          target,
          '#!/bin/sh\nprintf started > "$CODEX_HOME/fake-codex-started"\nexec /bin/sleep 60\n',
          { mode: 0o700 },
        );
        writeFileSync(host, "#!/bin/sh\nexec /bin/sleep 60\n", { mode: 0o700 });
        chmodSync(target, 0o700);
        chmodSync(host, 0o700);
        return target;
      })()
    : process.execPath;
  const herdr =
    runtime === "herdr"
      ? {
          executable: join(root, "missing-herdr"),
          sessionName: "dispatch-test",
          workspaceId: "dispatch-workspace",
        }
      : null;
  let store = new StateStore(path);
  const runId = `dispatch-${randomUUID()}`;
  const state = store.create(
    {
      ...initialRun(runId),
      repoPath: join(root, "repo"),
      runtime,
      runtimeConfiguration: {
        commonDirectory: { path: join(root, "repo", ".git"), device: "1", inode: "1" },
        executable,
        trackerExecutable: "/bin/false",
        runtimeRoot,
        workspaceRoot,
        accounts: fixtureAccounts(root),
        turnTimeoutMs: 12_345,
        herdr,
      },
    },
    RepositoryPolicySchema.parse({ schemaVersion: 1 }),
  );
  const fixtureDatabase = new Database(path);
  fixtureDatabase.prepare("DELETE FROM tracker_roots WHERE run_id = ?").run(state.runId);
  fixtureDatabase.close();
  let authorityLease = store.acquireLease(state.runId);
  let authority: ControllerAuthority = {
    runId: state.runId,
    ownerToken: authorityLease.ownerToken,
    leaseId: authorityLease.leaseId,
  };
  const journal = store.orchestration;
  const workspace = journal.agents.reserveWorkspace(
    authority,
    {
      root: workspaceRoot,
      purpose:
        role === "orchestrator"
          ? "coordinator"
          : role === "implementation"
            ? "implementation"
            : "review",
      sourceMode: role === "implementation" ? "mutable" : "immutable",
      baselineRevision: "dispatch-baseline",
    },
    journal.control(state.runId).controlVersion,
  );
  mkdirSync(workspace.path, { recursive: true, mode: 0o700 });
  const readyWorkspace = journal.agents.markWorkspaceReady(
    authority,
    workspace,
    "dispatch-fingerprint",
  );
  const agent = journal.agents.reserveAgent(
    authority,
    {
      ...readyWorkspace,
      role,
      purpose:
        role === "orchestrator"
          ? "coordination"
          : role === "implementation"
            ? "implementation"
            : "review",
      taskId: role === "orchestrator" ? null : "dispatch-task",
      candidateId: role === "review" ? "dispatch-candidate" : null,
      instructions: "Dispatch this bounded acceptance fixture",
      confinementProfile: "epicd-isolated",
      contract: contract(runtime),
    },
    journal.control(state.runId).controlVersion,
  );

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (store.controllerLease(state.runId)?.leaseId === authority.leaseId)
      store.releaseLease(state.runId, authority.ownerToken);
    store.close();
    rmSync(root, { recursive: true, force: true });
    if (fakeExecutableRoot) rmSync(fakeExecutableRoot, { recursive: true, force: true });
  };
  const rotateLease = () => {
    store.releaseLease(state.runId, authority.ownerToken);
    authorityLease = store.acquireLease(state.runId);
    authority = {
      runId: state.runId,
      ownerToken: authorityLease.ownerToken,
      leaseId: authorityLease.leaseId,
    };
    return authority;
  };
  const reopen = () => {
    store.releaseLease(state.runId, authority.ownerToken);
    store.close();
    store = new StateStore(path);
    authorityLease = store.acquireLease(state.runId);
    authority = {
      runId: state.runId,
      ownerToken: authorityLease.ownerToken,
      leaseId: authorityLease.leaseId,
    };
    return authority;
  };
  const fixture: DispatchFixture = {
    root,
    path,
    runId: state.runId,
    get store() {
      return store;
    },
    get authority() {
      return authority;
    },
    agent,
    workspacePath: readyWorkspace.path,
    close,
    rotateLease,
    reopen,
  };
  fixtures.push(fixture);
  return fixture;
}

function recordingFactory(runtime: RuntimeKind, calls: Record<RuntimeKind, FactoryCalls>) {
  const factory: ControlledAgentDriverFactory = (journal, execution, agent) => {
    const log = calls[runtime];
    log.construct += 1;
    log.agents.push(agent);
    log.executions.push(execution);
    const driver: ControlledAgentDriver = {
      backend: "codex",
      kind: runtime,
      async run(authority, identity) {
        log.run += 1;
        return journal.agents.turn(authority.runId, identity);
      },
      async reconcile(authority, identity) {
        log.reconcile += 1;
        return journal.agents.turn(authority.runId, identity);
      },
    };
    return driver;
  };
  return factory;
}

function dispatcher(
  fixture: DispatchFixture,
  calls: Record<RuntimeKind, FactoryCalls>,
  overrides: ControlledAgentDispatcherOptions = {},
) {
  return new ControlledAgentDispatcher(fixture.store.orchestration, {
    "codex:sdk": recordingFactory("sdk", calls),
    "codex:herdr": recordingFactory("herdr", calls),
    ...overrides,
  });
}

function prepare(fixture: DispatchFixture): TurnRecord {
  return fixture.store.orchestration.agents.prepareTurn(
    fixture.authority,
    fixture.agent,
    randomUUID(),
    "Return the persisted dispatch identity",
    { type: "object" },
    fixture.store.orchestration.control(fixture.runId).controlVersion,
  );
}

function decision(fixture: DispatchFixture, action: KernelAction): OrchestratorDecision {
  const journal = fixture.store.orchestration;
  const ticket = journal.beginDecision(
    fixture.authority,
    journal.latestObservationCursor(fixture.runId),
    journal.control(fixture.runId).controlVersion,
  );
  return {
    explanation: "Inspect the persisted agent binding",
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

function nativeEndpoint(
  fixture: DispatchFixture,
  overrides: Partial<NativeLaunchEndpoint> = {},
): NativeLaunchEndpoint {
  const agent = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
  const execution = agent.execution.herdr;
  if (!execution) throw new Error("Native acceptance fixture has no persisted Herdr endpoint");
  return {
    sessionName: execution.sessionName,
    socketPath: join(fixture.root, "herdr.sock"),
    socketIdentity: "dispatch-test-server",
    workspaceId: execution.workspaceId,
    tabId: "dispatch-tab",
    paneId: "dispatch-pane",
    terminalId: `dispatch-terminal-${randomUUID()}`,
    name: "dispatch-agent",
    ...overrides,
  };
}

function mismatchedRuntime(fixture: DispatchFixture, runtime: RuntimeKind) {
  const agent = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
  const root = join(fixture.root, "different-runtime");
  if (runtime === "sdk")
    return new ControlledSdkRuntime(fixture.store.orchestration, {
      root,
      executable: agent.execution.executable,
      turnTimeoutMs: agent.execution.turnTimeoutMs,
    });
  const execution = agent.execution.herdr;
  if (!execution) throw new Error("Native acceptance fixture has no persisted Herdr endpoint");
  return new ControlledHerdrRuntime(fixture.store.orchestration, {
    root,
    executable: agent.execution.executable,
    turnTimeoutMs: agent.execution.turnTimeoutMs,
    herdrPath: execution.executable,
    sessionName: execution.sessionName,
    workspaceId: execution.workspaceId,
  });
}

function bindSubmitted(fixture: DispatchFixture, turn: TurnRecord) {
  const agent = fixture.store.orchestration.agents.instance(fixture.runId, turn.identity);
  const launches = new ControlledLaunches({
    root: agent.execution.runtimeRoot,
    executable: agent.execution.executable,
    turnTimeoutMs: agent.execution.turnTimeoutMs,
  });
  return launches.reserve(fixture.store.orchestration, fixture.authority, turn.identity);
}

describe("persisted agent dispatcher acceptance", () => {
  it("rejects unavailable production Herdr before reserving a worker turn", async () => {
    const fixture = makeFixture("herdr", { role: "implementation" });
    vi.stubEnv("HERDR_ENV", "0");
    const dispatch = new ControlledAgentDispatcher(fixture.store.orchestration);
    expect(() => dispatch.assertReady(fixture.agent.contract)).toThrow(
      "Controlled Herdr requires HERDR_ENV=1",
    );

    const kernel = new ActionKernel(fixture.store.orchestration);
    registerAgentCapabilities(kernel, dispatch, () => contract("herdr"));
    const started = await kernel.execute(
      decision(fixture, {
        kind: "continue_agent",
        agentId: fixture.agent.agentId,
        agentGeneration: fixture.agent.agentGeneration,
        instructions: "Continue only if the persisted runtime can launch",
      }),
      fixture.authority,
    );
    const settled =
      started.status === "running" ? await kernel.operation(started.operationId)! : started;

    expect(settled).toMatchObject({
      status: "rejected",
      code: "agent_runtime_unavailable",
      detail: "Controlled Herdr requires HERDR_ENV=1",
    });
    expect(fixture.store.orchestration.agents.turns(fixture.runId)).toEqual([]);
    expect(fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent)).toMatchObject(
      { status: "reserved", activeTurnId: null },
    );
  });

  it("keeps recovery available when Herdr can no longer launch new work", async () => {
    const fixture = makeFixture("herdr");
    const turn = prepare(fixture);
    vi.stubEnv("HERDR_ENV", "0");
    const dispatch = new ControlledAgentDispatcher(fixture.store.orchestration);

    await expect(dispatch.reconcile(fixture.authority, turn.identity)).resolves.toMatchObject({
      status: "cancelled",
      stopEvidence: expect.any(String),
    });
  });

  it.each(["sdk", "herdr"] as const)(
    "selects the %s factory from the reopened persisted generation",
    async (runtime) => {
      const fixture = makeFixture(runtime);
      const calls = makeCalls();
      const turn = prepare(fixture);
      const expected = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
      const oldAuthority = fixture.authority;

      fixture.reopen();
      const dispatch = dispatcher(fixture, calls);
      const selected = await dispatch.run(fixture.authority, turn.identity);

      expect(selected.identity).toEqual(turn.identity);
      expect(calls[runtime].construct).toBe(1);
      expect(calls[runtime].run).toBe(1);
      expect(calls[runtime === "sdk" ? "herdr" : "sdk"].construct).toBe(0);
      expect(calls[runtime === "sdk" ? "herdr" : "sdk"].run).toBe(0);
      expect(calls[runtime].agents[0]).toMatchObject({
        agentId: expected.agentId,
        agentGeneration: expected.agentGeneration,
        contract: expected.contract,
        execution: expected.execution,
        accountBinding: expected.accountBinding,
      });
      expect(calls[runtime].executions[0]).toEqual(expected.execution);
      expect(
        fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent),
      ).toMatchObject({
        contract: expected.contract,
        execution: expected.execution,
        accountBinding: expected.accountBinding,
      });
      expect(oldAuthority.leaseId).not.toBe(fixture.authority.leaseId);
    },
  );

  it.each(["orchestrator", "implementation", "review"] as const)(
    "routes a persisted %s generation through its selected SDK adapter",
    async (role) => {
      const fixture = makeFixture("sdk", { role });
      const calls = makeCalls();
      const turn = prepare(fixture);
      fixture.reopen();

      await dispatcher(fixture, calls).run(fixture.authority, turn.identity);
      expect(calls.sdk.agents).toHaveLength(1);
      expect(calls.sdk.agents[0]).toMatchObject({
        role,
        contract: { backend: "codex", runtime: "sdk" },
      });
      expect(calls.herdr.construct).toBe(0);
    },
  );

  it("asserts authority before settled recovery and bypasses unavailable adapters", async () => {
    const fixture = makeFixture("sdk");
    const calls = makeCalls();
    const turn = prepare(fixture);
    const unavailable = () => {
      calls.sdk.construct += 1;
      throw new Error("SDK adapter unavailable");
    };
    const dispatch = dispatcher(fixture, calls, {
      "codex:sdk": unavailable,
    });

    const prepared = await dispatch.reconcile(fixture.authority, turn.identity);
    expect(prepared).toMatchObject({ status: "cancelled", stopEvidence: expect.any(String) });
    expect(calls.sdk.construct).toBe(0);
    expect(calls.sdk.reconcile).toBe(0);

    const settledAuthority = fixture.rotateLease();
    await expect(dispatch.reconcile(settledAuthority, turn.identity)).resolves.toEqual(prepared);
    expect(calls.sdk.construct).toBe(0);

    fixture.rotateLease();
    await expect(
      Promise.resolve().then(() => dispatch.reconcile(settledAuthority, turn.identity)),
    ).rejects.toThrow("lease was lost");
    await expect(
      Promise.resolve().then(() => dispatch.run(settledAuthority, turn.identity)),
    ).rejects.toThrow("lease was lost");
    expect(calls.sdk.construct).toBe(0);
  });

  it("returns intrinsically settled history without decoding an isolated owner", async () => {
    const fixture = makeFixture("sdk");
    const calls = makeCalls();
    const turn = prepare(fixture);
    const dispatch = dispatcher(fixture, calls);
    const settled = await dispatch.reconcile(fixture.authority, turn.identity);
    const database = new Database(fixture.path);
    try {
      const owner = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
      database
        .prepare(
          "UPDATE agent_instances SET record_json = ? WHERE run_id = ? AND agent_id = ? AND generation = ?",
        )
        .run(
          JSON.stringify({ ...owner, schemaVersion: 1 }),
          fixture.runId,
          owner.agentId,
          owner.agentGeneration,
        );

      await expect(dispatch.reconcile(fixture.authority, turn.identity)).resolves.toEqual(settled);
      expect(calls.sdk.construct).toBe(0);
      expect(calls.sdk.reconcile).toBe(0);
    } finally {
      database.close();
    }
  });

  it("maps an unreadable submitted owner to the recoverable containment boundary", async () => {
    const fixture = makeFixture("sdk");
    const calls = makeCalls();
    const turn = prepare(fixture);
    bindSubmitted(fixture, turn);
    const database = new Database(fixture.path);
    try {
      const owner = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
      database
        .prepare(
          "UPDATE agent_instances SET record_json = ? WHERE run_id = ? AND agent_id = ? AND generation = ?",
        )
        .run(
          JSON.stringify({ ...owner, schemaVersion: 1 }),
          fixture.runId,
          owner.agentId,
          owner.agentGeneration,
        );

      await expect(
        Promise.resolve().then(() =>
          dispatcher(fixture, calls).reconcile(fixture.authority, turn.identity),
        ),
      ).rejects.toMatchObject({ code: "agent_integrity_uncontained" });
      expect(calls.sdk.construct).toBe(0);
    } finally {
      database.close();
    }
  });

  it("keeps an uncertain submitted turn when its selected adapter is unavailable", async () => {
    const fixture = makeFixture("sdk");
    const calls = makeCalls();
    const turn = prepare(fixture);
    bindSubmitted(fixture, turn);
    const dispatch = dispatcher(fixture, calls, {
      "codex:sdk": () => {
        calls.sdk.construct += 1;
        throw new Error("SDK adapter unavailable");
      },
    });

    await expect(
      Promise.resolve().then(() => dispatch.reconcile(fixture.authority, turn.identity)),
    ).rejects.toThrow("adapter unavailable");
    const current = fixture.store.orchestration.agents.turn(fixture.runId, turn.identity);
    expect(current).toMatchObject({
      status: "submitting",
      stopEvidence: null,
      launch: { stop: null },
    });
    expect(
      fixture.store.orchestration.agents.workspace(fixture.runId, turn.identity).activeTurnId,
    ).toBe(turn.identity.turnId);
    expect(calls.sdk.construct).toBe(1);
    expect(calls.herdr.construct).toBe(0);
    expect(calls.herdr.reconcile).toBe(0);
  });

  it.each(["agent", "turn"] as const)(
    "rejects a malformed backend in a persisted %s row",
    async (row) => {
      const fixture = makeFixture("sdk");
      const calls = makeCalls();
      const turn = prepare(fixture);
      const database = new Database(fixture.path);
      try {
        if (row === "agent") {
          const agent = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
          database
            .prepare(
              "UPDATE agent_instances SET record_json = ? WHERE run_id = ? AND agent_id = ? AND generation = ?",
            )
            .run(
              JSON.stringify({ ...agent, contract: { ...agent.contract, backend: "claude" } }),
              fixture.runId,
              agent.agentId,
              agent.agentGeneration,
            );
        } else {
          const reserved = bindSubmitted(fixture, turn);
          database
            .prepare("UPDATE agent_turns SET record_json = ? WHERE run_id = ? AND turn_id = ?")
            .run(
              JSON.stringify({
                ...reserved.turn,
                launch: { ...reserved.turn.launch, backend: "claude" },
              }),
              fixture.runId,
              turn.identity.turnId,
            );
        }
        const dispatch = dispatcher(fixture, calls);
        await expect(
          Promise.resolve().then(() => dispatch.run(fixture.authority, turn.identity)),
        ).rejects.toThrow();
        expect(calls.sdk.construct).toBe(0);
        expect(calls.herdr.construct).toBe(0);
      } finally {
        database.close();
      }
    },
  );

  it.each(["runtime", "executable", "root"] as const)(
    "rejects a schema-valid submitted launch with a persisted %s cross-record mismatch after reopen",
    async (mismatch) => {
      const fixture = makeFixture("sdk");
      const calls = makeCalls();
      const prepared = prepare(fixture);
      const reserved = bindSubmitted(fixture, prepared);
      fixture.reopen();
      const database = new Database(fixture.path);
      try {
        const launch = reserved.turn.launch!;
        const manifest =
          mismatch === "executable"
            ? {
                ...launch.manifest,
                confinement: {
                  ...launch.manifest.confinement,
                  executable: join(fixture.root, "different-codex"),
                },
              }
            : mismatch === "root"
              ? {
                  ...launch.manifest,
                  confinement: {
                    ...launch.manifest.confinement,
                    providerHome: join(fixture.root, "different-runtime", "provider"),
                  },
                }
              : launch.manifest;
        const tampered = TurnRecordSchema.parse({
          ...reserved.turn,
          launch: {
            ...launch,
            ...(mismatch === "runtime" ? { runtime: "herdr" as const } : {}),
            manifest,
            manifestDigest: digestJson(manifest),
          },
        });
        const tamperedJson = JSON.stringify(tampered);
        expect(tampered.launch!.manifestDigest).toBe(digestJson(tampered.launch!.manifest));
        const workspaceBefore = database
          .prepare(
            "SELECT record_json FROM workspaces WHERE run_id = ? AND workspace_id = ? AND generation = ?",
          )
          .get(fixture.runId, fixture.agent.workspaceId, fixture.agent.workspaceGeneration);
        database
          .prepare("UPDATE agent_turns SET record_json = ? WHERE run_id = ? AND turn_id = ?")
          .run(tamperedJson, fixture.runId, prepared.identity.turnId);

        await expect(
          Promise.resolve().then(() =>
            dispatcher(fixture, calls).reconcile(fixture.authority, prepared.identity),
          ),
        ).rejects.toThrow();
        expect(calls.sdk.construct).toBe(0);
        expect(calls.sdk.reconcile).toBe(0);
        expect(calls.herdr.construct).toBe(0);
        expect(
          database
            .prepare("SELECT record_json FROM agent_turns WHERE run_id = ? AND turn_id = ?")
            .get(fixture.runId, prepared.identity.turnId),
        ).toEqual({ record_json: tamperedJson });
        expect(
          database
            .prepare(
              "SELECT record_json FROM workspaces WHERE run_id = ? AND workspace_id = ? AND generation = ?",
            )
            .get(fixture.runId, fixture.agent.workspaceId, fixture.agent.workspaceGeneration),
        ).toEqual(workspaceBefore);
      } finally {
        database.close();
      }
    },
  );

  it.each(["backend", "runtime"] as const)(
    "fails closed when an injected %s-mismatched driver is returned",
    async (mismatch) => {
      const fixture = makeFixture("sdk");
      const calls = makeCalls();
      const prepared = prepare(fixture);
      bindSubmitted(fixture, prepared);
      let factoryCalls = 0;
      let driverCalls = 0;
      const wrongDriver = {
        backend: mismatch === "backend" ? "claude" : "codex",
        kind: mismatch === "runtime" ? "herdr" : "sdk",
        async run() {
          driverCalls += 1;
          throw new Error("wrong driver was invoked");
        },
        async reconcile() {
          driverCalls += 1;
          throw new Error("wrong driver was invoked");
        },
      } as unknown as ControlledAgentDriver;
      const dispatch = dispatcher(fixture, calls, {
        "codex:sdk": () => {
          factoryCalls += 1;
          return wrongDriver;
        },
      });

      await expect(
        Promise.resolve().then(() => dispatch.reconcile(fixture.authority, prepared.identity)),
      ).rejects.toThrow(/backend|runtime|match|adapter/i);
      expect(factoryCalls).toBe(1);
      expect(driverCalls).toBe(0);
      expect(calls.herdr.construct).toBe(0);
      expect(
        fixture.store.orchestration.agents.turn(fixture.runId, prepared.identity),
      ).toMatchObject({
        status: "submitting",
        stopEvidence: null,
        launch: { stop: null },
      });
    },
  );

  it("keeps model-facing agent inspection useful without exposing execution binding paths", async () => {
    const fixture = makeFixture("herdr");
    const original = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
    const privateProviderHome = join(fixture.root, "private-provider-home");
    const transferId = randomUUID();
    const sessionId = randomUUID();
    const changed = {
      ...original,
      conversationContinuation: {
        transferId,
        sourceAgentId: original.agentId,
        sourceAgentGeneration: original.agentGeneration,
        sessionId,
        providerHome: privateProviderHome,
      },
    };
    const database = new Database(fixture.path);
    const at = new Date().toISOString();
    const transfer = {
      transferId,
      runId: fixture.runId,
      sourceAgentId: original.agentId,
      sourceAgentGeneration: original.agentGeneration,
      targetRuntime: "herdr",
      sessionId,
      providerHome: privateProviderHome,
      workspaceId: original.workspaceId,
      workspaceGeneration: original.workspaceGeneration,
      status: "consumed",
      targetAgentId: original.agentId,
      targetAgentGeneration: original.agentGeneration,
      sourceDigest: "0".repeat(64),
      createdAt: at,
      claimedAt: at,
      consumedAt: at,
      abandonment: null,
    };
    database
      .prepare(
        "INSERT INTO agent_conversation_transfers(transfer_id, run_id, source_agent_id, source_agent_generation, target_agent_id, target_agent_generation, session_id, target_runtime, status, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        transferId,
        fixture.runId,
        original.agentId,
        original.agentGeneration,
        original.agentId,
        original.agentGeneration,
        sessionId,
        "herdr",
        "consumed",
        JSON.stringify(transfer),
      );
    database
      .prepare(
        "UPDATE agent_instances SET record_json = ?, conversation_transfer_id = ? WHERE run_id = ? AND agent_id = ? AND generation = ?",
      )
      .run(
        JSON.stringify(changed),
        transferId,
        fixture.runId,
        original.agentId,
        original.agentGeneration,
      );
    database.close();
    const agent = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
    const result = await new ActionKernel(fixture.store.orchestration).execute(
      decision(fixture, {
        kind: "inspect_agent",
        agentId: agent.agentId,
        agentGeneration: agent.agentGeneration,
      }),
      fixture.authority,
    );
    expect(result).toMatchObject({ status: "succeeded", result: { kind: "inspection" } });
    if (result.status !== "succeeded" || result.result.kind !== "inspection")
      throw new Error("Expected a model-facing agent inspection");
    const inspected = JSON.parse(result.result.text);
    expect(inspected.agent).toMatchObject({
      agentId: agent.agentId,
      agentGeneration: agent.agentGeneration,
      role: agent.role,
      contract: agent.contract,
      status: agent.status,
      account: {
        accountClass: agent.accountBinding?.accountClass,
        label: agent.accountBinding?.source.label,
      },
    });
    expect(inspected.agent).not.toHaveProperty("accountBinding");
    expect(inspected.agent).not.toHaveProperty("execution");
    expect(inspected.agent.conversationContinuation).not.toHaveProperty("providerHome");
    const serialized = JSON.stringify(inspected);
    expect(serialized).not.toContain(agent.execution.runtimeRoot);
    expect(serialized).not.toContain(agent.execution.executable);
    expect(serialized).not.toContain(agent.execution.herdr!.executable);
    expect(serialized).not.toContain(privateProviderHome);
    expect(inspected.assignment.assignmentId).toBe(agent.assignmentId);
  });

  it("refuses the prior orchestration marker and old agent schema without rewriting records", () => {
    const fixture = makeFixture("sdk");
    const agent = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
    const database = new Database(fixture.path);
    try {
      const before = {
        run: database
          .prepare("SELECT run_id, state_json, updated_at FROM runs WHERE run_id = ?")
          .get(fixture.runId),
        agent: database
          .prepare(
            "SELECT agent_id, generation, run_id, workspace_id, workspace_generation, assignment_id, record_json FROM agent_instances WHERE run_id = ?",
          )
          .all(fixture.runId),
      };
      database.prepare("UPDATE orchestration_schema SET version = 43").run();
      expect(() => new StateStore(fixture.path)).toThrow("Use a fresh state path");
      expect(
        database
          .prepare("SELECT run_id, state_json, updated_at FROM runs WHERE run_id = ?")
          .get(fixture.runId),
      ).toEqual(before.run);
      expect(
        database
          .prepare(
            "SELECT agent_id, generation, run_id, workspace_id, workspace_generation, assignment_id, record_json FROM agent_instances WHERE run_id = ?",
          )
          .all(fixture.runId),
      ).toEqual(before.agent);

      database.prepare("UPDATE orchestration_schema SET version = 44").run();
      const oldAgent = { ...agent, schemaVersion: 1 };
      const oldAgentJson = JSON.stringify(oldAgent);
      database
        .prepare(
          "UPDATE agent_instances SET record_json = ? WHERE run_id = ? AND agent_id = ? AND generation = ?",
        )
        .run(oldAgentJson, fixture.runId, agent.agentId, agent.agentGeneration);
      expect(() =>
        fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent),
      ).toThrow();
      expect(
        database
          .prepare(
            "SELECT record_json FROM agent_instances WHERE run_id = ? AND agent_id = ? AND generation = ?",
          )
          .get(fixture.runId, agent.agentId, agent.agentGeneration),
      ).toEqual({ record_json: oldAgentJson });
    } finally {
      database.close();
    }
  });

  it("keeps settings changes future-facing and excludes private bindings from summaries", () => {
    const fixture = makeFixture("sdk");
    const before = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
    const nextSettings = structuredClone(fixture.store.get(fixture.runId)!.agentSettings);
    nextSettings.implementation.reasoningEffort = "low";
    fixture.store.updateAgentSettingsWithLease(
      fixture.runId,
      fixture.authority.ownerToken,
      nextSettings,
    );
    const after = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
    expect(after.contract).toEqual(before.contract);

    const summary = fixture.store.orchestration.agents.summaries(fixture.runId);
    expect(summary.instances).toContainEqual(
      expect.objectContaining({
        agentId: before.agentId,
        agentGeneration: before.agentGeneration,
        backend: "codex",
        runtime: "sdk",
      }),
    );
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(before.execution.runtimeRoot);
    expect(serialized).not.toContain(before.accountBinding?.source.codexHome ?? "never");
    expect(serialized).not.toContain(before.accountBinding?.source.authCachePath ?? "never");
  });

  it.each(["sessionName", "workspaceId"] as const)(
    "rejects a native launch whose persisted %s differs from the frozen Herdr tuple before mutation",
    (field) => {
      const fixture = makeFixture("herdr");
      const turn = prepare(fixture);
      bindSubmitted(fixture, turn);
      const before = fixture.store.orchestration.agents.turn(fixture.runId, turn.identity);
      const endpoint = nativeEndpoint(fixture, {
        ...(field === "sessionName" ? { sessionName: "different-session" } : {}),
        ...(field === "workspaceId" ? { workspaceId: "different-workspace" } : {}),
      });

      expect(() =>
        fixture.store.orchestration.agents.bindNativeLaunch(
          fixture.authority,
          turn.identity,
          endpoint,
        ),
      ).toThrow(/native|execution|endpoint/i);
      expect(fixture.store.orchestration.agents.turn(fixture.runId, turn.identity)).toEqual(before);
      expect(
        fixture.store.orchestration.agents.turn(fixture.runId, turn.identity).launch?.native,
      ).toBeNull();
    },
  );

  it("rejects a schema-valid tampered native endpoint during recovery before selecting an adapter", async () => {
    const fixture = makeFixture("herdr");
    const turn = prepare(fixture);
    const reserved = bindSubmitted(fixture, turn);
    const bound = fixture.store.orchestration.agents.bindNativeLaunch(
      fixture.authority,
      turn.identity,
      nativeEndpoint(fixture),
    );
    const launch = bound.launch!;
    const tampered = TurnRecordSchema.parse({
      ...bound,
      launch: {
        ...launch,
        native: { ...launch.native!, sessionName: "different-session" },
        manifestDigest: digestJson(launch.manifest),
      },
    });
    const tamperedJson = JSON.stringify(tampered);
    expect(tampered.launch?.manifestDigest).toBe(digestJson(tampered.launch!.manifest));
    const database = new Database(fixture.path);
    try {
      database
        .prepare("UPDATE agent_turns SET record_json = ? WHERE run_id = ? AND turn_id = ?")
        .run(tamperedJson, fixture.runId, turn.identity.turnId);
    } finally {
      database.close();
    }
    fixture.reopen();
    const calls = makeCalls();

    await expect(
      Promise.resolve().then(() =>
        dispatcher(fixture, calls).reconcile(fixture.authority, turn.identity),
      ),
    ).rejects.toThrow(/native|execution|endpoint|binding/i);
    expect(calls.herdr.construct).toBe(0);
    expect(calls.herdr.reconcile).toBe(0);
    expect(calls.sdk.construct).toBe(0);
    expect(fixture.store.orchestration.agents.turn(fixture.runId, turn.identity)).toMatchObject({
      status: "submitting",
      stopEvidence: null,
      launch: { stop: null, native: { sessionName: "different-session" } },
    });
    expect(reserved.turn.launch?.manifestDigest).toBe(digestJson(reserved.turn.launch!.manifest));
  });

  it("rejects a direct SDK adapter whose frozen execution tuple differs before reservation", async () => {
    const fixture = makeFixture("sdk");
    const turn = prepare(fixture);
    const agent = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
    const runtime = new ControlledSdkRuntime(fixture.store.orchestration, {
      root: agent.execution.runtimeRoot,
      executable: join(fixture.root, "different-codex"),
      turnTimeoutMs: agent.execution.turnTimeoutMs,
    });

    await expect(runtime.run(fixture.authority, turn.identity)).rejects.toThrow(
      "recorded agent execution",
    );
    expect(fixture.store.orchestration.agents.turn(fixture.runId, turn.identity)).toMatchObject({
      status: "prepared",
      launch: null,
    });
  });

  it.each(["sdk", "herdr"] as const)(
    "preserves the %s direct adapter prepared and settled recovery fast paths without a runnable configuration",
    async (runtime) => {
      const fixture = makeFixture(runtime);
      const turn = prepare(fixture);
      const mismatched = mismatchedRuntime(fixture, runtime);

      const cancelled = await mismatched.reconcile(fixture.authority, turn.identity);
      expect(cancelled).toMatchObject({ status: "cancelled", stopEvidence: expect.any(String) });
      await expect(mismatched.reconcile(fixture.authority, turn.identity)).resolves.toEqual(
        cancelled,
      );
    },
  );

  it.each(["sdk", "herdr"] as const)(
    "rejects a direct %s adapter with a mismatched frozen execution tuple before stop request",
    async (runtime) => {
      const fixture = makeFixture(runtime);
      const turn = prepare(fixture);
      bindSubmitted(fixture, turn);
      const before = fixture.store.orchestration.agents.turn(fixture.runId, turn.identity);
      const mismatched = mismatchedRuntime(fixture, runtime);

      await expect(mismatched.reconcile(fixture.authority, turn.identity)).rejects.toThrow(
        /recorded agent execution|configuration|endpoint|frozen/i,
      );
      expect(fixture.store.orchestration.agents.turn(fixture.runId, turn.identity)).toEqual(before);
    },
  );

  const supervisorEntrypoint = join(process.cwd(), "dist/adapters/codex-launch-cli.js");
  it.runIf(process.platform === "linux" && existsSync(supervisorEntrypoint))(
    "stops a real persisted native supervisor after Herdr, executable, and auth discovery disappear",
    async () => {
      const fixture = makeFixture("herdr", { fakeExecutable: true });
      vi.stubEnv("HERDR_ENV", "0");
      const turn = prepare(fixture);
      const reserved = bindSubmitted(fixture, turn);
      const agent = fixture.store.orchestration.agents.instance(fixture.runId, turn.identity);
      const launches = new ControlledLaunches({
        root: agent.execution.runtimeRoot,
        executable: agent.execution.executable,
        turnTimeoutMs: agent.execution.turnTimeoutMs,
        launcherEntrypoint: supervisorEntrypoint,
      });
      const launcher = await launches.materialize(reserved.manifest, reserved.packet);
      let supervisorDiagnostics = "";
      const supervisor = spawn(process.execPath, [supervisorEntrypoint, launcher.manifestPath], {
        cwd: fixture.workspacePath,
        env: { ...process.env, HERDR_ENV: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      supervisor.stdout?.resume();
      supervisor.stderr?.setEncoding("utf8");
      supervisor.stderr?.on("data", (chunk: string) => {
        supervisorDiagnostics = (supervisorDiagnostics + chunk).slice(-4_000);
      });
      try {
        let running = false;
        const startedMarker = join(
          agent.execution.runtimeRoot,
          fixture.runId,
          `${agent.agentId}-${agent.agentGeneration}`,
          "provider",
          "fake-codex-started",
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (supervisor.exitCode !== null || supervisor.signalCode !== null) break;
          try {
            const observation = await controlCodexLaunch(reserved.manifest, "inspect");
            if (observation.state === "running" && existsSync(startedMarker)) {
              running = true;
              break;
            }
          } catch {
            // The supervisor's private control socket is not ready yet.
          }
          await delay(50);
        }
        expect(running, supervisorDiagnostics).toBe(true);

        rmSync(agent.execution.executable, { force: true });
        rmSync(join(dirname(agent.execution.executable), "codex-code-mode-host"), { force: true });
        rmSync(agent.accountBinding!.source.authCachePath, { force: true });
        fixture.reopen();

        const rebound = fixture.store.orchestration.agents.instance(fixture.runId, turn.identity);
        expect(rebound.execution).toEqual(agent.execution);
        expect(rebound.accountBinding).toEqual(agent.accountBinding);
        const recovered = await new ControlledAgentDispatcher(
          fixture.store.orchestration,
        ).reconcile(fixture.authority, turn.identity);
        expect(recovered).toMatchObject({
          status: "cancelled",
          stopEvidence: expect.any(String),
          launch: { stop: { kind: "stopped", interrupted: true, processTreeStopped: true } },
        });
        expect(
          fixture.store.orchestration.agents.workspace(fixture.runId, turn.identity),
        ).toMatchObject({
          activeTurnId: null,
        });
        if (supervisor.exitCode === null && supervisor.signalCode === null)
          await Promise.race([
            new Promise<void>((resolve) => supervisor.once("close", () => resolve())),
            delay(2_000).then(() => {
              throw new Error("The real launch supervisor did not exit after recovery stop");
            }),
          ]);
        expect(await readCodexLaunchStop(reserved.manifest)).toEqual(recovered.launch!.stop);
      } finally {
        if (supervisor.exitCode === null && supervisor.signalCode === null)
          supervisor.kill("SIGKILL");
      }
    },
    15_000,
  );

  it("refuses native launch before reservation when Herdr prerequisites are absent", async () => {
    const fixture = makeFixture("herdr");
    const turn = prepare(fixture);
    const agent = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
    const endpoint = agent.execution.herdr!;
    vi.stubEnv("HERDR_ENV", "0");
    const runtime = new ControlledHerdrRuntime(fixture.store.orchestration, {
      root: agent.execution.runtimeRoot,
      executable: agent.execution.executable,
      turnTimeoutMs: agent.execution.turnTimeoutMs,
      herdrPath: endpoint.executable,
      sessionName: endpoint.sessionName,
      workspaceId: endpoint.workspaceId,
    });

    await expect(runtime.run(fixture.authority, turn.identity)).rejects.toThrow("HERDR_ENV");
    expect(fixture.store.orchestration.agents.turn(fixture.runId, turn.identity)).toMatchObject({
      status: "prepared",
      launch: null,
    });
  });

  it("rejects a direct Herdr adapter whose endpoint differs before reservation", async () => {
    const fixture = makeFixture("herdr");
    const turn = prepare(fixture);
    const agent = fixture.store.orchestration.agents.instance(fixture.runId, fixture.agent);
    const endpoint = agent.execution.herdr!;
    vi.stubEnv("HERDR_ENV", "1");
    const runtime = new ControlledHerdrRuntime(fixture.store.orchestration, {
      root: agent.execution.runtimeRoot,
      executable: agent.execution.executable,
      turnTimeoutMs: agent.execution.turnTimeoutMs,
      herdrPath: join(fixture.root, "different-herdr"),
      sessionName: endpoint.sessionName,
      workspaceId: endpoint.workspaceId,
    });

    await expect(runtime.run(fixture.authority, turn.identity)).rejects.toThrow(
      "recorded agent execution",
    );
    expect(fixture.store.orchestration.agents.turn(fixture.runId, turn.identity)).toMatchObject({
      status: "prepared",
      launch: null,
    });
  });
});
