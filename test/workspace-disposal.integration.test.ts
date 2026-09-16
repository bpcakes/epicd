import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { ControlledLaunches } from "../src/adapters/controlled-launch.js";
import { ControlledAgentDispatcher } from "../src/adapters/agent-dispatch.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { registerWorkspaceDisposalCapabilities } from "../src/kernel/workspace-disposal.js";
import { registerInspectionCapabilities } from "../src/kernel/inspection.js";
import { registerDeliveryRecoveryCapabilities } from "../src/kernel/delivery-recovery.js";
import { preparePrivateIO } from "../src/adapters/private-io-files.js";
import { disposalRoot, retainedWorkspacePath } from "../src/adapters/workspace-disposal-files.js";
import {
  reconcileWorkspaceDisposal,
  runWorkspaceDisposal,
} from "../src/adapters/workspace-disposal-io.js";
import * as lifetime from "../src/adapters/command-lifetime.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import {
  SdkAgentSessionContractSchema,
  HerdrAgentSessionContractSchema,
} from "../src/domain/types.js";
import type {
  ControllerAuthority,
  KernelAction,
  OrchestratorDecision,
} from "../src/domain/orchestration.js";
import type { WorkspaceRecord } from "../src/domain/agents.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import { fixtureAccounts } from "./fixtures/accounts.js";
import { git, success, target, fixture as reviewFixture } from "./fixtures/review.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});

async function fixture(
  purpose: WorkspaceRecord["purpose"] = "diagnostic",
  runtime: "sdk" | "herdr" = "sdk",
) {
  const root = mkdtempSync("/var/tmp/epicd-disposal-");
  const source = join(root, "source"),
    path = join(root, "state.sqlite3");
  mkdirSync(source);
  git(source, "init", "--quiet");
  git(source, "config", "user.name", "Disposal fixture");
  git(source, "config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "source.txt"), "baseline\n");
  git(source, "add", "source.txt");
  git(source, "commit", "--quiet", "-m", "baseline");
  const revision = git(source, "rev-parse", "HEAD"),
    workspaceRoot = join(root, "workspaces");
  let store = new StateStore(path);
  const run = store.create(
    {
      ...initialRun(),
      repoPath: source,
      epicBaseRevision: revision,
      runtime,
      runtimeConfiguration: {
        commonDirectory: {
          path: join(source, ".git"),
          device: String(statSync(join(source, ".git")).dev),
          inode: String(statSync(join(source, ".git")).ino),
        },
        executable: process.execPath,
        trackerExecutable: process.execPath,
        runtimeRoot: join(root, "runtime"),
        workspaceRoot,
        accounts: fixtureAccounts(root),
        turnTimeoutMs: 30_000,
        herdr:
          runtime === "herdr"
            ? { executable: process.execPath, sessionName: "fixture-only", workspaceId: "w1" }
            : null,
      },
    },
    RepositoryPolicySchema.parse({ schemaVersion: 1 }),
  );
  const lease = store.acquireLease(run.runId);
  let authority: ControllerAuthority = {
    runId: run.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  let journal = store.orchestration,
    manager = new WorkspaceManager(journal, workspaceRoot),
    kernel = new ActionKernel(journal);
  const install = () => {
    registerWorkspaceDisposalCapabilities(kernel, manager);
    registerInspectionCapabilities(kernel, manager);
    registerDeliveryRecoveryCapabilities(
      kernel,
      manager,
      new ControlledAgentDispatcher(journal, {
        "codex:sdk": () => ({
          backend: "codex",
          kind: "sdk",
          run: async () => {
            throw new Error("No model transport in disposal fixture");
          },
          reconcile: async () => {
            throw new Error("No model transport in disposal fixture");
          },
        }),
      }),
    );
  };
  install();
  const workspace = await manager.create(authority, source, revision, purpose);
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  function decision(action: KernelAction): OrchestratorDecision {
    const ticket = journal.beginDecision(
      authority,
      journal.latestObservationCursor(run.runId),
      journal.control(run.runId).controlVersion,
    );
    return {
      explanation: "Dispose only the selected stopped copy",
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
  async function dispatch(action: KernelAction) {
    const result = await kernel.execute(decision(action), authority);
    return result.status === "running" ? await kernel.operation(result.operationId)! : result;
  }
  const reserveAgent = (runtime: "sdk" | "herdr" = "sdk") => {
    const settings = { model: "worker-model", reasoningEffort: "high" as const };
    return journal.agents.reserveAgent(
      authority,
      {
        ...target(workspace),
        purpose: "specialist",
        role: "implementation",
        taskId: null,
        candidateId: null,
        instructions: "Inspect this diagnostic copy",
        confinementProfile: "epicd-isolated",
        contract: (runtime === "sdk"
          ? SdkAgentSessionContractSchema
          : HerdrAgentSessionContractSchema
        ).parse({
          backend: "codex",
          runtime,
          requested: settings,
          effective: settings,
        }),
      },
      journal.control(run.runId).controlVersion,
    );
  };
  return {
    root,
    source,
    path,
    revision,
    workspace,
    workspaceRoot,
    decision,
    dispatch,
    reserveAgent,
    get journal() {
      return journal;
    },
    get store() {
      return store;
    },
    get kernel() {
      return kernel;
    },
    get manager() {
      return manager;
    },
    get authority() {
      return authority;
    },
    restart() {
      store.releaseLease(run.runId, authority.ownerToken);
      store.close();
      store = new StateStore(path);
      const next = store.acquireLease(run.runId);
      authority = { runId: run.runId, ownerToken: next.ownerToken, leaseId: next.leaseId };
      journal = store.orchestration;
      manager = new WorkspaceManager(journal, workspaceRoot);
      kernel = new ActionKernel(journal);
      install();
      // Bootstrap performs this transition before accepting model-directed reconciliation.
      journal.markInterruptedActions(authority);
    },
    async reserve() {
      const admitted = journal.acceptAction(
        authority,
        decision({ kind: "dispose_workspace", ...target(workspace) }),
      );
      if (admitted.kind === "rejected") throw new Error("Disposal fixture admission failed");
      journal.startAction(authority, admitted.action.actionId);
      const archive = await preparePrivateIO(disposalRoot(workspace.path));
      return journal.workspaceDisposals.reserve(authority, admitted.action.actionId, archive);
    },
  };
}

describe.runIf(process.platform === "linux")("recoverable workspace disposal", () => {
  it("replays the acknowledgement without a second disposal or physical move", async () => {
    const f = await fixture();
    const decision = f.decision({ kind: "dispose_workspace", ...target(f.workspace) });
    const running = await f.kernel.execute(decision, f.authority);
    const settled =
      running.status === "running" ? await f.kernel.operation(running.operationId)! : running;
    success(settled);
    expect(await f.kernel.execute(decision, f.authority)).toEqual(settled);
    expect(f.journal.workspaceDisposals.records(f.authority.runId)).toHaveLength(1);
    expect(readdirSync(disposalRoot(f.workspace.path))).toHaveLength(1);
  });

  it("preserves complete raw disposal records and retained bytes during invalid-run quarantine", async () => {
    const f = await fixture();
    success(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) }));
    const retained = f.journal.workspaceDisposals.records(f.authority.runId)[0]!;
    const db = new Database(f.path);
    try {
      const raw = db
        .prepare("SELECT * FROM workspace_disposals WHERE run_id=?")
        .all(f.authority.runId);
      f.store.releaseLease(f.authority.runId, f.authority.ownerToken);
      db.prepare(
        "UPDATE runs SET state_json=json_set(state_json, '$.createdAt', 'invalid') WHERE run_id=?",
      ).run(f.authority.runId);
      f.store.quarantineInvalidRun(f.authority.runId);
      const quarantined = db
        .prepare(
          "SELECT row_json FROM quarantined_orchestration WHERE run_id=? AND source_table='workspace_disposals'",
        )
        .all(f.authority.runId) as { row_json: string }[];
      expect(quarantined.map((entry) => JSON.parse(entry.row_json))).toEqual(raw);
      expect(readFileSync(join(retainedWorkspacePath(retained), "source.txt"), "utf8")).toBe(
        "baseline\n",
      );
    } finally {
      db.close();
    }
  });
  it.each(["stopped", "not_started"] as const)(
    "preserves native endpoint history and treats %s as distinct from host-shell stop",
    async (kind) => {
      const f = await fixture("diagnostic", "herdr"),
        agent = f.reserveAgent("herdr");
      const prepared = f.journal.agents.prepareTurn(
        f.authority,
        agent,
        randomUUID(),
        "Diagnostic fixture",
        { type: "object" },
        f.journal.control(f.authority.runId).controlVersion,
      );
      const launches = new ControlledLaunches({
        root: join(f.root, "runtime"),
        executable: process.execPath,
      });
      const { turn, manifest } = launches.reserve(f.journal, f.authority, prepared.identity);
      const endpoint = {
        sessionName: "fixture-only",
        socketPath: join(f.root, "fixture.sock"),
        socketIdentity: "fixture-server",
        workspaceId: "w1",
        tabId: "w1:t1",
        paneId: "w1:p1",
        terminalId: randomUUID(),
        name: "fixture-agent",
      };
      f.journal.agents.bindNativeLaunch(f.authority, turn.identity, endpoint);
      expect(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) })).toMatchObject(
        {
          status: "rejected",
          code: "workspace_busy",
        },
      );
      // A journal contract fixture, not an actual native process or live-stop claim.
      f.journal.agents.recordLaunchStop(f.authority, turn.identity, {
        generation: manifest.generation,
        kind,
        code: kind === "stopped" ? 0 : null,
        signal: null,
        interrupted: true,
        processTreeStopped: true,
        stoppedAt: new Date().toISOString(),
      });
      f.journal.agents.finishTurn(f.authority, turn.identity, {
        status: "cancelled",
        result: null,
        stopEvidence:
          "Scripted journal stop contract; no real native process was dispatched by this test",
      });
      f.journal.agents.revokeAgent(f.authority, agent, "Quarantined diagnostic copy");
      writeFileSync(join(f.workspace.path, "receipt"), "retain the diagnostic receipt\n");
      const before = f.journal.agents.turn(f.authority.runId, turn.identity);
      if (kind === "not_started") {
        expect(
          await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) }),
        ).toMatchObject({ status: "rejected", code: "native_shell_unsettled" });
        expect(existsSync(f.workspace.path)).toBe(true);
        expect(f.journal.agents.turn(f.authority.runId, turn.identity)).toEqual(before);
        return;
      }
      success(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) }));
      expect(f.journal.agents.turn(f.authority.runId, turn.identity)).toEqual(before);
      expect(before.launch?.native).toEqual(endpoint);
      expect(before.resultEligible).toBe(false);
      const retained = f.journal.workspaceDisposals.forWorkspace(
        f.authority.runId,
        f.workspace,
      )[0]!;
      expect(readFileSync(join(retainedWorkspacePath(retained), "receipt"), "utf8")).toBe(
        "retain the diagnostic receipt\n",
      );
    },
  );
  it("moves all diagnostic bytes, retains symlinks and receipts, and reads the retained copy without touching user work", async () => {
    const f = await fixture();
    const agent = f.reserveAgent();
    writeFileSync(join(f.workspace.path, "source.txt"), "diagnostic change\n");
    mkdirSync(join(f.workspace.path, "ignored"));
    writeFileSync(join(f.workspace.path, "ignored/receipt"), Buffer.from([0, 255, 7, 10]));
    const outside = join(f.root, "user-file");
    writeFileSync(outside, "user-owned\n");
    symlinkSync(outside, join(f.workspace.path, "external-link"));
    writeFileSync(join(f.source, "source.txt"), "user's concurrent dirty source\n");
    const status = git(f.source, "status", "--porcelain=v1"),
      inode = lstatSync(f.workspace.path, { bigint: true }).ino;
    success(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) }));
    const disposal = f.journal.workspaceDisposals.forWorkspace(f.authority.runId, f.workspace)[0]!;
    const retained = retainedWorkspacePath(disposal);
    expect(disposal.outcome).toBe("retained");
    expect(disposal.stop?.kind).toBe("stopped");
    expect(existsSync(f.workspace.path)).toBe(false);
    expect(lstatSync(retained, { bigint: true }).ino).toBe(inode);
    expect(readFileSync(join(retained, "source.txt"), "utf8")).toBe("diagnostic change\n");
    expect(readFileSync(join(retained, "ignored/receipt"))).toEqual(Buffer.from([0, 255, 7, 10]));
    expect(readlinkSync(join(retained, "external-link"))).toBe(outside);
    expect(readFileSync(outside, "utf8")).toBe("user-owned\n");
    expect(f.journal.agents.workspace(f.authority.runId, f.workspace).status).toBe("disposed");
    expect(f.journal.agents.instance(f.authority.runId, agent).status).toBe("released");
    const inspection = success(
      await f.dispatch({
        kind: "inspect_repo",
        ...target(f.workspace),
        operation: "read",
        path: "source.txt",
        query: null,
        offset: 0,
        limit: 100,
      }),
    );
    expect(inspection.kind).toBe("inspection");
    if (inspection.kind === "inspection") expect(inspection.text).toContain("diagnostic change");
    await expect(f.manager.capture(f.authority, f.workspace, randomUUID())).rejects.toThrow();
    const fresh = await f.manager.create(f.authority, f.source, f.revision, "diagnostic");
    expect(fresh.workspaceId).not.toBe(f.workspace.workspaceId);
    expect(readFileSync(join(fresh.path, "source.txt"), "utf8")).toBe("baseline\n");
    expect(git(f.source, "rev-parse", "HEAD")).toBe(f.revision);
    expect(git(f.source, "status", "--porcelain=v1")).toBe(status);
    expect(readFileSync(join(f.source, "source.txt"), "utf8")).toBe(
      "user's concurrent dirty source\n",
    );
  });

  it.each(["review", "verification", "coordinator"] as const)(
    "can retire an unused independent %s copy",
    async (purpose) => {
      const f = await fixture(purpose);
      success(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) }));
      expect(existsSync(f.workspace.path)).toBe(false);
      const view = success(await f.dispatch({ kind: "inspect_workspace", ...target(f.workspace) }));
      expect(view.kind).toBe("inspection");
      if (view.kind === "inspection")
        expect(JSON.parse(view.text)).toMatchObject({
          workspace: { status: "disposed" },
          disposals: [{ outcome: "retained", stopConfirmed: true }],
        });
    },
  );

  it.each(["implementation", "delivery"] as const)(
    "preserves the %s object source",
    async (purpose) => {
      const f = await fixture(purpose);
      expect(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) })).toMatchObject(
        { status: "rejected", code: "workspace_dependency" },
      );
      expect(existsSync(f.workspace.path)).toBe(true);
      expect(f.journal.agents.workspace(f.authority.runId, f.workspace).status).toBe("ready");
    },
  );

  it("recovers a pending inspection explicitly after revocation before allowing disposal", async () => {
    const f = await fixture();
    const agent = f.reserveAgent();
    const noReceipt = vi.spyOn(lifetime, "recoverCommandStop").mockResolvedValueOnce(null);
    await expect(f.manager.inspectMaterialization(f.authority, f.workspace)).rejects.toThrow(
      "no independent stop receipt",
    );
    noReceipt.mockRestore();
    const pending = f.journal.workspaceInspections.pending(f.authority.runId, f.workspace)!;
    expect(pending.workerResult).toMatchObject({
      status: "observed",
      observation: { ready: true },
    });
    f.journal.agents.revokeAgent(
      f.authority,
      agent,
      "Revoke authority while preserving inspection custody",
    );
    const launches = vi.spyOn(lifetime, "startDurableCommand");
    expect(await f.manager.inspectMaterialization(f.authority, f.workspace)).toBe("incomplete");
    expect(f.journal.workspaceInspections.get(f.authority.runId, pending.inspectionId)).toEqual(
      pending,
    );
    expect(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) })).toMatchObject({
      status: "rejected",
      code: "workspace_busy",
    });
    const result = success(
      await f.dispatch({
        kind: "reconcile_workspace_inspection",
        inspectionId: pending.inspectionId,
      }),
    );
    if (result.kind !== "inspection") throw new Error("Expected retained inspection");
    expect(JSON.parse(result.text)).toMatchObject({ outcome: "observed", stopConfirmed: true });
    expect(launches).not.toHaveBeenCalled();
    expect(f.journal.agents.workspace(f.authority.runId, f.workspace).status).toBe("quarantined");
    expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, f.workspace)).toBeNull();
    success(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) }));
    expect(f.journal.agents.workspace(f.authority.runId, f.workspace).status).toBe("disposed");
  });

  it.each(["directory", "symlink"] as const)(
    "rejects a replaced source %s without moving either owner",
    async (kind) => {
      const f = await fixture(),
        original = `${f.workspace.path}-original`;
      renameSync(f.workspace.path, original);
      if (kind === "symlink") symlinkSync(original, f.workspace.path);
      else {
        mkdirSync(f.workspace.path);
        writeFileSync(join(f.workspace.path, "user"), "preserve me");
      }
      expect(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) })).toMatchObject(
        { status: "rejected" },
      );
      expect(readFileSync(join(original, "source.txt"), "utf8")).toBe("baseline\n");
      if (kind === "directory")
        expect(readFileSync(join(f.workspace.path, "user"), "utf8")).toBe("preserve me");
      else expect(readlinkSync(f.workspace.path)).toBe(original);
      expect(f.journal.workspaceDisposals.records(f.authority.runId)).toEqual([]);
    },
  );

  it("refuses a live turn and pending instructions without retiring their agent", async () => {
    const f = await fixture(),
      agent = f.reserveAgent();
    const turn = f.journal.agents.prepareTurn(
      f.authority,
      agent,
      randomUUID(),
      "Inspect",
      { type: "object" },
      f.journal.control(f.authority.runId).controlVersion,
    );
    expect(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) })).toMatchObject({
      status: "rejected",
      code: "workspace_busy",
    });
    f.journal.agents.cancelPreparedTurn(f.authority, turn.identity);
    f.journal.agents.enqueueAgentMessage(f.authority, agent, randomUUID(), "Keep this instruction");
    const before = f.journal.agents.instance(f.authority.runId, agent);
    expect(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) })).toMatchObject({
      status: "rejected",
      code: "mailbox_pending",
    });
    expect(f.journal.agents.instance(f.authority.runId, agent)).toEqual(before);
    expect(existsSync(f.workspace.path)).toBe(true);
  });

  it("refuses unsettled workspace I/O even without an active agent", async () => {
    const f = await fixture();
    const operation = f.journal.agents.beginWorkspaceOperation(
      f.authority,
      f.workspace,
      "capture",
      f.journal.control(f.authority.runId).controlVersion,
    );
    expect(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) })).toMatchObject({
      status: "rejected",
      code: "workspace_busy",
    });
    expect(
      f.journal.agents.workspaceOperation(f.authority.runId, operation.operationId).stopEvidence,
    ).toBeNull();
    expect(existsSync(f.workspace.path)).toBe(true);
  });

  it("atomically fences an unbound old intent and allows only a new explicit disposal", async () => {
    const f = await fixture(),
      pending = await f.reserve(),
      old = f.authority;
    f.restart();
    const settled = await reconcileWorkspaceDisposal(f.journal, f.authority, pending.disposalId);
    expect(settled.outcome).toBe("not_moved");
    expect(settled.execution).toBeNull();
    await expect(
      runWorkspaceDisposal(f.journal, old, pending, new AbortController().signal),
    ).rejects.toThrow();
    expect(existsSync(f.workspace.path)).toBe(true);
    const parent = f.journal.actionForOperation(f.authority.runId, pending.operationId)!;
    success(await f.dispatch({ kind: "reconcile_action", actionId: parent.actionId }));
    success(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) }));
    expect(
      f.journal.workspaceDisposals
        .forWorkspace(f.authority.runId, f.workspace)
        .map((item) => item.outcome),
    ).toEqual(["not_moved", "retained"]);
  });

  it("recovers a lost acknowledgement without replay and preserves a new occupant at the old path", async () => {
    const f = await fixture();
    vi.spyOn(f.journal.workspaceDisposals, "finish").mockImplementationOnce(() => {
      throw new Error("injected lost settlement");
    });
    const result = await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) });
    expect(result.status).toBe("indeterminate");
    const prior = f.journal.workspaceDisposals.forWorkspace(f.authority.runId, f.workspace)[0]!;
    expect(prior.stop).not.toBeNull();
    expect(existsSync(f.workspace.path)).toBe(false);
    mkdirSync(f.workspace.path);
    writeFileSync(join(f.workspace.path, "source.txt"), "new user occupant\n");
    f.restart();
    success(await f.dispatch({ kind: "reconcile_action", actionId: result.actionId }));
    const retained = f.journal.workspaceDisposals.get(f.authority.runId, prior.disposalId);
    expect(retained).toMatchObject({ outcome: "retained", sourcePathOccupied: true });
    expect(readFileSync(join(f.workspace.path, "source.txt"), "utf8")).toBe("new user occupant\n");
    expect(readFileSync(join(retainedWorkspacePath(retained), "source.txt"), "utf8")).toBe(
      "baseline\n",
    );
    success(await f.dispatch({ kind: "reconcile_action", actionId: result.actionId }));
    expect(f.journal.workspaceDisposals.records(f.authority.runId)).toHaveLength(1);
    expect(readdirSync(disposalRoot(f.workspace.path))).toHaveLength(1);
  });

  it("cannot release or inspect an uncertain move without its independent stop receipt", async () => {
    const f = await fixture();
    const reader = vi.spyOn(lifetime, "recoverCommandStop").mockResolvedValue(null);
    const result = await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) });
    expect(result.status).toBe("indeterminate");
    expect(f.journal.agents.workspace(f.authority.runId, f.workspace).status).toBe("retired");
    expect(
      await f.dispatch({
        kind: "inspect_repo",
        ...target(f.workspace),
        operation: "read",
        path: "source.txt",
        query: null,
        offset: 0,
        limit: 100,
      }),
    ).toMatchObject({ status: "rejected", code: "disposal_unsettled" });
    reader.mockRestore();
    f.restart();
    success(await f.dispatch({ kind: "reconcile_action", actionId: result.actionId }));
    expect(f.journal.agents.workspace(f.authority.runId, f.workspace).status).toBe("disposed");
  });

  it("does not overwrite an occupied retention destination", async () => {
    const f = await fixture(),
      reserve = f.journal.workspaceDisposals.reserve.bind(f.journal.workspaceDisposals);
    vi.spyOn(f.journal.workspaceDisposals, "reserve").mockImplementationOnce((...args) => {
      const record = reserve(...args);
      mkdirSync(retainedWorkspacePath(record));
      writeFileSync(join(retainedWorkspacePath(record), "foreign"), "preserve foreign destination");
      return record;
    });
    expect(await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) })).toMatchObject({
      status: "failed",
    });
    const record = f.journal.workspaceDisposals.forWorkspace(f.authority.runId, f.workspace)[0]!;
    expect(record.outcome).toBe("conflict");
    expect(readFileSync(join(retainedWorkspacePath(record), "foreign"), "utf8")).toBe(
      "preserve foreign destination",
    );
    expect(readFileSync(join(f.workspace.path, "source.txt"), "utf8")).toBe("baseline\n");
  });

  it("rolls back retirement when disposal intent cannot be journaled", async () => {
    const f = await fixture(),
      agent = f.reserveAgent(),
      db = new Database(f.path);
    try {
      db.exec(
        "CREATE TRIGGER reject_disposal BEFORE INSERT ON workspace_disposals BEGIN SELECT RAISE(ABORT, 'injected disposal audit failure'); END;",
      );
      const before = f.journal.agents.instance(f.authority.runId, agent);
      const result = await f.dispatch({ kind: "dispose_workspace", ...target(f.workspace) });
      expect(result.status).toBe("indeterminate");
      expect(f.journal.workspaceDisposals.records(f.authority.runId)).toEqual([]);
      expect(f.journal.agents.instance(f.authority.runId, agent)).toEqual(before);
      expect(f.journal.agents.workspace(f.authority.runId, f.workspace).status).toBe("ready");
      expect(existsSync(f.workspace.path)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("preserves independent approval and required validation after retiring the review copy", async () => {
    const f = await reviewFixture();
    registerWorkspaceDisposalCapabilities(f.kernel, f.manager);
    const plan = await f.define(),
      candidate = await f.capture(plan),
      copy = await f.copy(candidate);
    await f.validate(candidate, copy);
    const reviewed = await f.review(candidate);
    success(reviewed.result);
    const approval = f.journal.reviews.assessApproval(f.authority.runId, candidate, "pre_commit");
    expect(approval.evidenceId).toBe(reviewed.evidence.evidenceId);
    success(await f.dispatch({ kind: "dispose_workspace", ...target(reviewed.reviewCopy) }));
    expect(f.journal.reviews.assessApproval(f.authority.runId, candidate, "pre_commit")).toEqual(
      approval,
    );
    expect(f.journal.reviews.evidence(f.authority.runId, reviewed.evidence.evidenceId)).toEqual(
      reviewed.evidence,
    );
  });

  it("later evidence revocation cannot resurrect retired or disposed workspace authority", async () => {
    const f = await fixture(),
      agent = f.reserveAgent(),
      pending = await f.reserve();
    f.journal.agents.revokeAgent(f.authority, agent, "Later evidence contamination");
    expect(f.journal.agents.workspace(f.authority.runId, f.workspace).status).toBe("retired");
    const result = await runWorkspaceDisposal(
      f.journal,
      f.authority,
      pending,
      new AbortController().signal,
    );
    expect(result.outcome).toBe("retained");
    expect(f.journal.agents.instance(f.authority.runId, agent).revokedReason).toBe(
      "Later evidence contamination",
    );
    expect(f.journal.agents.workspace(f.authority.runId, f.workspace).status).toBe("disposed");
  });
});
