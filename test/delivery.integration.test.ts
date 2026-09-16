import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as commandLifetime from "../src/adapters/command-lifetime.js";
import { NamespaceStopUnprovenError } from "../src/adapters/pid-namespace.js";
import { StateStore } from "../src/adapters/store.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { registerDeliveryCapabilities } from "../src/kernel/delivery.js";
import {
  RepositoryPolicySchema,
  RequiredCheckSchema,
  type RepositoryPolicy,
  ValidationServiceSchema,
} from "../src/domain/repository-policy.js";
import { SdkAgentSessionContractSchema } from "../src/domain/types.js";
import type {
  ActionResult,
  ControllerAuthority,
  KernelAction,
} from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import { fixtureAccounts } from "./fixtures/accounts.js";
import type { ValidationEvidence } from "../src/domain/delivery.js";
import { journalRecordView } from "../src/adapters/journal-records.js";
import { reconcileValidationIO } from "../src/adapters/validation-io.js";

const roots: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(path: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", path, ...args],
    { encoding: "utf8" },
  ).trim();
}
const check = RequiredCheckSchema.parse({
  id: "app-check",
  command: "/bin/sh",
  args: ["-c", 'test "$(cat app.txt)" = green || { echo expected-green >&2; exit 7; }'],
  cwd: ".",
  timeoutMs: 5000,
});
const actionCheck = ({ stage: _stage, ...item }: typeof check) => item;
async function fixture(policyInput: Partial<RepositoryPolicy> = {}) {
  const root = mkdtempSync(join(tmpdir(), "epicd-delivery-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "--quiet");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "app.txt"), "red\n");
  mkdirSync(join(source, ".beads"));
  writeFileSync(join(source, ".beads", "issues.jsonl"), "tracker\n");
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "baseline");
  const head = git(source, "rev-parse", "HEAD");
  const path = join(root, "state.sqlite3");
  const store = new StateStore(path);
  stores.push(store);
  const initial = initialRun();
  initial.repoPath = source;
  initial.runtimeConfiguration = {
    commonDirectory: { path: join(source, ".git"), device: "1", inode: "1" },
    executable: process.execPath,
    trackerExecutable: process.execPath,
    runtimeRoot: join(root, "runtime"),
    workspaceRoot: join(root, "managed"),
    accounts: fixtureAccounts(root),
    turnTimeoutMs: 15_000,
    herdr: null,
  };
  const state = store.create(
    initial,
    RepositoryPolicySchema.parse({ schemaVersion: 1, requiredChecks: [check], ...policyInput }),
  );
  const fixtureDatabase = new Database(path);
  fixtureDatabase.prepare("DELETE FROM tracker_roots WHERE run_id = ?").run(state.runId);
  fixtureDatabase.close();
  const lease = store.acquireLease(state.runId);
  const authority: ControllerAuthority = {
    runId: state.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const journal = store.orchestration;
  const manager = new WorkspaceManager(journal, join(root, "managed"));
  const workspace = await manager.create(authority, source, head, "implementation");
  const settings = { model: "worker", reasoningEffort: "high" as const };
  const agent = journal.agents.reserveAgent(
    authority,
    {
      ...target(workspace),
      role: "implementation",
      purpose: "implementation",
      taskId: "demo.1",
      candidateId: null,
      instructions: "Implement the specified behavior",
      confinementProfile: "fixture-only",
      contract: SdkAgentSessionContractSchema.parse({
        backend: "codex",
        runtime: "sdk",
        requested: settings,
        effective: settings,
      }),
    },
    journal.control(state.runId).controlVersion,
  );
  const kernel = new ActionKernel(journal);
  registerDeliveryCapabilities(kernel, manager);
  function decision(action: KernelAction) {
    const ticket = journal.beginDecision(
      authority,
      journal.latestObservationCursor(state.runId),
      journal.control(state.runId).controlVersion,
    );
    return {
      explanation: "Choose this capability from the current evidence",
      evidenceIds: [],
      request: {
        schemaVersion: 1 as const,
        decisionId: ticket.decisionId,
        observationCursor: ticket.observationCursor,
        expectedControlVersion: ticket.expectedControlVersion,
        action,
      },
    };
  }
  async function dispatch(action: KernelAction): Promise<ActionResult> {
    const result = await kernel.execute(decision(action), authority);
    if (result.status !== "running") return result;
    const pending = kernel.operation(result.operationId);
    return pending ? await pending : journal.action(state.runId, result.actionId)!.result!;
  }
  async function define(
    checks = [actionCheck(check)],
    acceptanceCriteria = ["The application must report green"],
  ) {
    const result = success(
      await dispatch({
        kind: "define_validation_plan",
        taskId: "demo.1",
        acceptanceCriteria,
        checks,
      }),
    );
    if (result.kind !== "resource") throw new Error("Expected plan resource");
    return result.resourceId;
  }
  async function capture(planId: string) {
    const resource = success(
      await dispatch({
        kind: "capture_candidate",
        taskId: "demo.1",
        ...target(workspace),
        validationPlanId: planId,
      }),
    );
    if (resource.kind !== "resource") throw new Error("Expected candidate resource");
    return { candidateId: resource.resourceId, candidateGeneration: resource.generation };
  }
  async function review(candidate: Awaited<ReturnType<typeof capture>>) {
    const resource = success(
      await dispatch({ kind: "create_review_workspace", ...candidate, revision: null }),
    );
    if (resource.kind !== "resource") throw new Error("Expected workspace resource");
    return journal.agents.workspace(state.runId, {
      workspaceId: resource.resourceId,
      workspaceGeneration: resource.generation,
    });
  }
  return {
    root,
    path,
    source,
    head,
    store,
    authority,
    journal,
    manager,
    workspace,
    agent,
    kernel,
    decision,
    dispatch,
    define,
    capture,
    review,
  };
}
function target(value: { workspaceId: string; workspaceGeneration: number }) {
  return { workspaceId: value.workspaceId, workspaceGeneration: value.workspaceGeneration };
}
function success(result: ActionResult) {
  if (result.status !== "succeeded")
    throw new Error(`Expected successful action, received ${JSON.stringify(result)}`);
  return result.result;
}
function validation(result: ActionResult) {
  const payload = success(result);
  if (payload.kind !== "validation") throw new Error("Expected validation evidence");
  return payload;
}

// Linux is the admitted confinement platform; a missing/broken sandbox fails these tests there.
describe.skipIf(process.platform !== "linux")("candidate and validation capabilities", () => {
  it("keeps validation and workspace exclusion indeterminate when its monitor cannot prove stop", async () => {
    const setup = await fixture();
    writeFileSync(join(setup.workspace.path, "app.txt"), "green\n");
    const planId = await setup.define(),
      candidate = await setup.capture(planId),
      copy = await setup.review(candidate);
    // The real check records success, but the controller cannot read its complete
    // worker's stop receipt. A genuine command result alone cannot release exclusion.
    const launch = vi
      .spyOn(commandLifetime, "recoverCommandStop")
      .mockRejectedValue(
        new NamespaceStopUnprovenError("Fixture monitor stop receipt is unavailable"),
      );
    try {
      const result = await setup.dispatch({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: check.id,
      });
      expect(result.status).toBe("indeterminate");
      expect(launch).toHaveBeenCalledOnce();
      const db = new Database(setup.path, { readonly: true });
      try {
        const rows = db
          .prepare("SELECT record_json FROM validation_evidence WHERE run_id = ?")
          .all(setup.authority.runId) as { record_json: string }[];
        expect(rows).toHaveLength(1);
        const evidence = JSON.parse(rows[0]!.record_json);
        expect(evidence).toMatchObject({
          status: "finished",
          outcome: expect.objectContaining({ status: "succeeded" }),
        });
        expect(
          setup.journal.delivery.satisfiesCheck(setup.authority.runId, evidence.evidenceId),
        ).toBe(false);
        expect(
          setup.journal.agents.activeWorkspaceOperation(setup.authority.runId, copy),
        ).not.toBeNull();
        const reference = { recordKind: "validation" as const, recordId: evidence.evidenceId };
        expect(journalRecordView(setup.journal, setup.authority.runId, reference).settled).toBe(
          false,
        );
        const memory = {
          kind: "fact" as const,
          content: "A real check result was retained",
          scope: "run" as const,
          taskId: null,
          confidence: "observed" as const,
          observationIds: [],
          evidenceIds: [evidence.evidenceId],
          revision: null,
          environmentGeneration: null,
          supersedes: null,
        };
        expect(() => setup.journal.recordMemory(setup.authority, memory)).toThrow("unfinished");
        launch.mockRestore();
        // Same actual check; only recover its original missing stop acknowledgment.
        await reconcileValidationIO(setup.journal, setup.authority, evidence.evidenceId);
        expect(journalRecordView(setup.journal, setup.authority.runId, reference).settled).toBe(
          true,
        );
        expect(setup.journal.recordMemory(setup.authority, memory).memoryId).toBeTruthy();
        expect(
          setup.journal.delivery.satisfiesCheck(setup.authority.runId, evidence.evidenceId),
        ).toBe(true);
        expect(setup.journal.delivery.summaries(setup.authority.runId).validation).toHaveLength(1);
      } finally {
        db.close();
      }
    } finally {
      launch.mockRestore();
    }
  });
  it("binds service runtime metadata once, rolls back failed audit writes, and never treats a lost pre-launch result as a pass", async () => {
    const service = ValidationServiceSchema.parse({
      id: "browser",
      provider: "postgresql",
      lifetime: "check",
      binDirectory: "/usr/lib/postgresql/18/bin",
      database: "browser_test",
      role: "fixture_owner",
      port: 55432,
      connectionVariable: "DATABASE_URL",
    });
    const dependent = { ...check, environmentBindings: [service.id] };
    const setup = await fixture({ requiredChecks: [dependent], validationServices: [service] });
    const planId = await setup.define([actionCheck(dependent)]),
      candidate = await setup.capture(planId),
      copy = await setup.review(candidate);
    let announce!: (value: ValidationEvidence) => void, release!: () => void;
    const ready = new Promise<ValidationEvidence>((resolve) => {
      announce = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const kernel = new ActionKernel(setup.journal);
    kernel.registerExternal("run_validation", async ({ authority, record }) => {
      announce(setup.journal.delivery.beginValidation(authority, record.actionId));
      await gate;
      throw new Error("Lost acknowledgement before any provider launch");
    });
    const pending = await kernel.execute(
      setup.decision({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: dependent.id,
      }),
      setup.authority,
    );
    if (pending.status !== "running") throw new Error("Expected held validation intent");
    const result = kernel.operation(pending.operationId)!;
    const db = new Database(setup.path);
    try {
      const evidence = await ready;
      // Synthetic executable metadata is journal-only input; no provider is invoked in this test.
      const binary = (name: string) => ({
        path: `${service.binDirectory}/${name}`,
        device: "1",
        inode: "1",
        digest: "a".repeat(64),
      });
      const runtime = {
        initdb: binary("initdb"),
        pg_ctl: binary("pg_ctl"),
        postgres: binary("postgres"),
        psql: binary("psql"),
      };
      const before = setup.journal.latestObservationCursor(setup.authority.runId);
      db.exec(
        "CREATE TRIGGER fail_service_binding BEFORE INSERT ON observations WHEN json_extract(NEW.observation_json, '$.kind') = 'validation.services_bound' BEGIN SELECT RAISE(ABORT, 'audit failure'); END",
      );
      expect(() =>
        setup.journal.delivery.bindValidationServices(setup.authority, evidence.evidenceId, [
          runtime,
        ]),
      ).toThrow("audit failure");
      expect(setup.journal.delivery.evidence(setup.authority.runId, evidence.evidenceId)).toEqual(
        evidence,
      );
      expect(setup.journal.latestObservationCursor(setup.authority.runId)).toBe(before);
      db.exec("DROP TRIGGER fail_service_binding");
      const bound = setup.journal.delivery.bindValidationServices(
        setup.authority,
        evidence.evidenceId,
        [runtime],
      );
      expect(bound.environmentGenerations[0]?.runtime).toEqual(runtime);
      expect(() =>
        setup.journal.delivery.bindValidationServices(setup.authority, evidence.evidenceId, [
          runtime,
        ]),
      ).toThrow("one-use");
      expect(
        setup.journal.delivery.satisfiesCheck(setup.authority.runId, evidence.evidenceId),
      ).toBe(false);
      release();
      expect((await result).status).toBe("indeterminate");
      const reopened = new StateStore(setup.path);
      try {
        expect(
          reopened.orchestration.delivery.evidence(setup.authority.runId, evidence.evidenceId),
        ).toEqual(bound);
      } finally {
        reopened.close();
      }
    } finally {
      release();
      await result;
      db.close();
    }
  });
  it.runIf(Boolean(process.env.EPICD_TEST_PG_BINDIR))(
    "executes a declared check-scoped database through the real action/evidence path and never replays its instance",
    async () => {
      const bin = process.env.EPICD_TEST_PG_BINDIR!;
      const service = ValidationServiceSchema.parse({
        id: "browser",
        provider: "postgresql",
        lifetime: "check",
        binDirectory: bin,
        database: "browser_test",
        role: "fixture_owner",
        port: 55432,
        connectionVariable: "DATABASE_URL",
      });
      const sql = RequiredCheckSchema.parse({
        ...check,
        id: "sql",
        environmentBindings: [service.id],
        timeoutMs: 15_000,
        args: [
          "-c",
          `exec ${bin}/psql -X -w -qAt -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'CREATE TABLE proof(value integer); INSERT INTO proof VALUES (42); SELECT value FROM proof;'`,
        ],
      });
      const setup = await fixture({ requiredChecks: [sql], validationServices: [service] });
      const planId = await setup.define(
        [actionCheck(sql)],
        ["The declared fresh database must execute the required SQL"],
      );
      const candidate = await setup.capture(planId),
        copy = await setup.review(candidate);
      const action: KernelAction = {
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: sql.id,
      };
      const request = setup.decision(action);
      const pending = await setup.kernel.execute(request, setup.authority);
      if (pending.status !== "running") throw new Error("Expected asynchronous validation");
      const first = validation(await setup.kernel.operation(pending.operationId)!);
      expect(first).toMatchObject({ outcome: "succeeded", satisfiesCheck: true });
      const evidence = setup.journal.delivery.evidence(setup.authority.runId, first.evidenceId);
      expect(evidence).toMatchObject({
        environmentVerified: true,
        sourceUnchanged: true,
        outcome: { stdout: "42\n", processTreeStopped: true },
        environmentGenerations: [
          {
            bindingId: service.id,
            generation: 1,
            runtime: { postgres: { path: `${bin}/postgres`, digest: expect.any(String) } },
          },
        ],
      });
      expect(validation(await setup.kernel.execute(request, setup.authority))).toEqual(first);
      const reopened = new StateStore(setup.path);
      try {
        expect(
          reopened.orchestration.delivery.evidence(setup.authority.runId, first.evidenceId),
        ).toEqual(evidence);
      } finally {
        reopened.close();
      }
      const next = validation(await setup.dispatch(action));
      expect(next.satisfiesCheck).toBe(true);
      const latest = setup.journal.delivery.evidence(setup.authority.runId, next.evidenceId);
      expect(latest.environmentGenerations[0]?.instanceId).not.toBe(
        evidence.environmentGenerations[0]?.instanceId,
      );
      expect(setup.journal.delivery.satisfiesCheck(setup.authority.runId, first.evidenceId)).toBe(
        false,
      );
      expect(readFileSync(join(setup.source, "app.txt"), "utf8")).toBe("red\n");
    },
    40_000,
  );

  it("records failed service setup without starting the check or accepting empty environment evidence", async () => {
    const service = ValidationServiceSchema.parse({
      id: "browser",
      provider: "postgresql",
      lifetime: "check",
      binDirectory: "/usr/epicd-missing-postgresql-binaries",
      database: "browser_test",
      role: "fixture_owner",
      port: 55432,
      connectionVariable: "DATABASE_URL",
    });
    const dependent = {
      ...check,
      environmentBindings: [service.id],
      args: ["-c", "touch scratch/check-started"],
    };
    const setup = await fixture({
      requiredChecks: [dependent],
      validationServices: [service],
      writableScratch: ["scratch"],
    });
    const planId = await setup.define([actionCheck(dependent)]),
      candidate = await setup.capture(planId),
      copy = await setup.review(candidate);
    const result = validation(
      await setup.dispatch({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: dependent.id,
      }),
    );
    expect(result).toMatchObject({ outcome: "not_started", satisfiesCheck: false });
    const evidence = setup.journal.delivery.evidence(setup.authority.runId, result.evidenceId);
    expect(evidence).toMatchObject({
      environmentVerified: false,
      environmentGenerations: [{ bindingId: service.id, runtime: null }],
    });
    expect(existsSync(join(copy.path, "scratch/check-started"))).toBe(false);
    expect(setup.journal.agents.activeWorkspaceOperation(setup.authority.runId, copy)).toBeNull();
    expect(() =>
      setup.journal.delivery.bindValidationServices(setup.authority, evidence.evidenceId, []),
    ).toThrow("one-use");
  });
  it("retains truncated output without accepting it as a pass or overflowing inspection", async () => {
    const noisy = {
      ...check,
      args: ["-c", "head -c 100000 /dev/zero; head -c 100000 /dev/zero >&2"],
    };
    const setup = await fixture({ requiredChecks: [noisy] });
    const planId = await setup.define([actionCheck(noisy)]);
    const candidate = await setup.capture(planId);
    const copy = await setup.review(candidate);
    const result = validation(
      await setup.dispatch({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: noisy.id,
      }),
    );
    expect(result).toMatchObject({ outcome: "succeeded", satisfiesCheck: false });
    expect(
      setup.journal.delivery.evidence(setup.authority.runId, result.evidenceId).outcome,
    ).toMatchObject({ exitCode: 0, outputTruncated: true });
    expect(setup.journal.agents.activeWorkspaceOperation(setup.authority.runId, copy)).toBeNull();
    const inspected = success(
      await setup.dispatch({ kind: "inspect_evidence", evidenceId: result.evidenceId }),
    );
    if (inspected.kind !== "inspection") throw new Error("Expected inspection");
    expect(Buffer.byteLength(inspected.text)).toBeLessThanOrEqual(65536);
    expect(JSON.parse(inspected.text).outcome.inspectionTruncated).toBe(true);
  });

  it("interrupts a real running check before releasing its workspace", async () => {
    const waiting = {
      ...check,
      args: [
        "-c",
        "echo started > scratch/started; while :; do echo alive >> scratch/heartbeat; sleep .05; done",
      ],
    };
    const setup = await fixture({ requiredChecks: [waiting], writableScratch: ["scratch"] });
    const planId = await setup.define([actionCheck(waiting)]);
    const candidate = await setup.capture(planId);
    const copy = await setup.review(candidate);
    const running = await setup.kernel.execute(
      setup.decision({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: waiting.id,
      }),
      setup.authority,
    );
    if (running.status !== "running") throw new Error("Expected asynchronous validation");
    const pending = setup.kernel.operation(running.operationId)!;
    await waitForFile(join(copy.path, "scratch", "heartbeat"));
    expect(setup.journal.agents.activeWorkspaceOperation(setup.authority.runId, copy)?.kind).toBe(
      "validation",
    );
    setup.kernel.interruptAll();
    expect(await pending).toMatchObject({ status: "cancelled" });
    const evidence = setup.journal.delivery.summaries(setup.authority.runId).validation[0]!;
    expect(evidence).toMatchObject({ status: "interrupted", satisfiesCheck: false });
    expect(
      setup.journal.delivery.evidence(setup.authority.runId, evidence.evidenceId).outcome,
    ).toBeNull();
    expect(setup.journal.agents.activeWorkspaceOperation(setup.authority.runId, copy)).toBeNull();
    const stoppedBytes = readFileSync(join(copy.path, "scratch", "heartbeat"));
    await delay(150);
    expect(readFileSync(join(copy.path, "scratch", "heartbeat"))).toEqual(stoppedBytes);
  });

  it("interrupts one real validation through the model capability while another check keeps running", async () => {
    const waiting = {
      ...check,
      timeoutMs: 10000,
      args: ["-c", "while :; do echo alive >> scratch/heartbeat; sleep .05; done"],
    };
    const setup = await fixture({ requiredChecks: [waiting], writableScratch: ["scratch"] });
    const planId = await setup.define([actionCheck(waiting)]);
    const candidate = await setup.capture(planId);
    const first = await setup.review(candidate),
      second = await setup.review(candidate);
    const pendingChecks: Promise<ActionResult>[] = [];
    const start = async (copy: typeof first) => {
      const result = await setup.kernel.execute(
        setup.decision({
          kind: "run_validation",
          ...candidate,
          ...target(copy),
          validationPlanId: planId,
          checkId: waiting.id,
        }),
        setup.authority,
      );
      if (result.status !== "running") throw new Error("Expected asynchronous validation");
      const pending = setup.kernel.operation(result.operationId)!;
      pendingChecks.push(pending);
      await waitForFile(join(copy.path, "scratch", "heartbeat"));
      return { ...result, pending };
    };
    let b: Awaited<ReturnType<typeof start>> | undefined;
    try {
      const a = await start(first);
      b = await start(second);
      const request = setup.decision({
        kind: "interrupt_action",
        actionId: a.actionId,
        reason: "Stop this obsolete diagnostic hypothesis",
      });
      const result = await setup.kernel.execute(request, setup.authority);
      const acknowledgment =
        result.status === "running"
          ? ((await setup.kernel.operation(result.operationId)) ??
            setup.journal.action(setup.authority.runId, result.actionId)!.result!)
          : result;
      const payload = success(acknowledgment);
      if (payload.kind !== "inspection") throw new Error("Expected interruption acknowledgment");
      expect(JSON.parse(payload.text)).toMatchObject({
        actionId: a.actionId,
        interruption: "requested",
      });
      expect(await a.pending).toMatchObject({ status: "cancelled" });
      expect(setup.journal.action(setup.authority.runId, b.actionId)?.status).toBe("running");
      expect(
        setup.journal.agents.activeWorkspaceOperation(setup.authority.runId, first),
      ).toBeNull();
      expect(
        setup.journal.agents.activeWorkspaceOperation(setup.authority.runId, second)?.kind,
      ).toBe("validation");
      const stoppedBytes = readFileSync(join(first.path, "scratch/heartbeat"));
      const runningBytes = readFileSync(join(second.path, "scratch/heartbeat"));
      await delay(180);
      expect(readFileSync(join(first.path, "scratch/heartbeat"))).toEqual(stoppedBytes);
      expect(readFileSync(join(second.path, "scratch/heartbeat")).length).toBeGreaterThan(
        runningBytes.length,
      );
      expect(setup.journal.delivery.summaries(setup.authority.runId).validation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "interrupted", satisfiesCheck: false }),
        ]),
      );
      expect(setup.journal.control(setup.authority.runId).status).toBe("active");
    } finally {
      setup.kernel.interruptAll();
      await Promise.allSettled(pendingChecks);
    }
    expect(await b!.pending).toMatchObject({ status: "cancelled" });
  });

  it("stops on lease loss but does not accept late evidence or release an old exclusion", async () => {
    const waiting = {
      ...check,
      args: ["-c", "while :; do echo alive >> scratch/heartbeat; sleep .05; done"],
    };
    const setup = await fixture({ requiredChecks: [waiting], writableScratch: ["scratch"] });
    const planId = await setup.define([actionCheck(waiting)]);
    const candidate = await setup.capture(planId);
    const copy = await setup.review(candidate);
    const running = await setup.kernel.execute(
      setup.decision({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: waiting.id,
      }),
      setup.authority,
    );
    if (running.status !== "running") throw new Error("Expected asynchronous validation");
    const settled = setup.kernel.operation(running.operationId)!.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitForFile(join(copy.path, "scratch", "heartbeat"));
    setup.store.releaseLease(setup.authority.runId, setup.authority.ownerToken);
    setup.store.acquireLease(setup.authority.runId);
    expect(await settled).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining("lease") }),
    });
    expect(
      setup.journal.agents.activeWorkspaceOperation(setup.authority.runId, copy)?.controllerLeaseId,
    ).toBe(setup.authority.leaseId);
    expect(setup.journal.delivery.summaries(setup.authority.runId).validation[0]).toMatchObject({
      status: "running",
      satisfiesCheck: false,
    });
    const stoppedBytes = readFileSync(join(copy.path, "scratch", "heartbeat"));
    await delay(150);
    expect(readFileSync(join(copy.path, "scratch", "heartbeat"))).toEqual(stoppedBytes);
  });

  it("invalidates a prior pass as soon as another implementation turn is prepared", async () => {
    const setup = await fixture();
    writeFileSync(join(setup.workspace.path, "app.txt"), "green\n");
    const planId = await setup.define();
    const candidate = await setup.capture(planId);
    const copy = await setup.review(candidate);
    const result = validation(
      await setup.dispatch({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: check.id,
      }),
    );
    expect(result.satisfiesCheck).toBe(true);
    const turn = setup.journal.agents.prepareTurn(
      setup.authority,
      setup.agent,
      randomUUID(),
      "Continue implementation",
      {},
      setup.journal.control(setup.authority.runId).controlVersion,
    );
    expect(setup.journal.delivery.satisfiesCheck(setup.authority.runId, result.evidenceId)).toBe(
      false,
    );
    setup.journal.agents.requestStop(setup.authority, turn.identity);
    expect(setup.journal.delivery.satisfiesCheck(setup.authority.runId, result.evidenceId)).toBe(
      false,
    );
  });

  it("tracks replacement writers for the task, not only the original source agent", async () => {
    const setup = await fixture();
    writeFileSync(join(setup.workspace.path, "app.txt"), "green\n");
    const planId = await setup.define();
    const candidate = await setup.capture(planId);
    const copy = await setup.review(candidate);
    const result = validation(
      await setup.dispatch({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: check.id,
      }),
    );
    expect(result.satisfiesCheck).toBe(true);
    const otherWorkspace = await setup.manager.create(
      setup.authority,
      setup.source,
      setup.head,
      "implementation",
    );
    const writer = setup.journal.agents.reserveAgent(
      setup.authority,
      {
        ...target(otherWorkspace),
        role: "implementation",
        purpose: "implementation",
        taskId: "demo.1",
        candidateId: null,
        instructions: "Continue this task in a separate assignment",
        confinementProfile: "fixture-only",
        contract: setup.agent.contract,
      },
      setup.journal.control(setup.authority.runId).controlVersion,
    );
    const turn = setup.journal.agents.prepareTurn(
      setup.authority,
      writer,
      randomUUID(),
      "Work",
      {},
      setup.journal.control(setup.authority.runId).controlVersion,
    );
    expect(setup.journal.delivery.candidateCurrent(setup.authority.runId, candidate)).toBe(false);
    expect(
      await setup.dispatch({
        kind: "capture_candidate",
        taskId: "demo.1",
        ...target(setup.workspace),
        validationPlanId: planId,
      }),
    ).toMatchObject({ status: "rejected", code: "task_writer_active" });
    setup.journal.agents.requestStop(setup.authority, turn.identity);
    expect(setup.journal.delivery.satisfiesCheck(setup.authority.runId, result.evidenceId)).toBe(
      false,
    );
  });

  it("lets durable working memory cite actual validation evidence but rejects invented references", async () => {
    const setup = await fixture();
    const planId = await setup.define();
    const candidate = await setup.capture(planId);
    const copy = await setup.review(candidate);
    const result = validation(
      await setup.dispatch({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: check.id,
      }),
    );
    const entry = {
      kind: "fact" as const,
      content: "The check exited with status seven and reported expected-green",
      scope: "run" as const,
      taskId: null,
      confidence: "observed" as const,
      observationIds: [],
      evidenceIds: [result.evidenceId],
      revision: null,
      environmentGeneration: null,
      supersedes: null,
    };
    expect(success(await setup.dispatch({ kind: "record_memory", entry })).kind).toBe("memory");
    expect(setup.journal.memory(setup.authority.runId).at(-1)?.evidenceIds).toEqual([
      result.evidenceId,
    ]);
    expect(
      await setup.dispatch({
        kind: "record_memory",
        entry: { ...entry, evidenceIds: [randomUUID()] },
      }),
    ).toMatchObject({ status: "rejected", code: "invalid_memory_reference" });
  });
  it("records an actual failed check, validates a corrected candidate, and preserves the user checkout", async () => {
    const setup = await fixture();
    writeFileSync(join(setup.source, "app.txt"), "user-owned change\n");
    const userIndex = readFileSync(join(setup.source, ".git", "index"));
    const planId = await setup.define();
    const first = await setup.capture(planId);
    const firstCopy = await setup.review(first);
    const failed = validation(
      await setup.dispatch({
        kind: "run_validation",
        ...first,
        ...target(firstCopy),
        validationPlanId: planId,
        checkId: check.id,
      }),
    );
    expect(failed).toMatchObject({ outcome: "failed", satisfiesCheck: false });
    const failedEvidence = setup.journal.delivery.evidence(
      setup.authority.runId,
      failed.evidenceId,
    );
    expect(failedEvidence.outcome).toMatchObject({
      exitCode: 7,
      processTreeStopped: true,
      stderr: "expected-green\n",
    });
    expect(failedEvidence.sourceUnchanged).toBe(true);
    expect(setup.journal.control(setup.authority.runId).status).toBe("active");
    writeFileSync(join(setup.workspace.path, "app.txt"), "green\n"); // Fixture stands in for implementation; no live agent claim.
    const second = await setup.capture(planId);
    const secondCopy = await setup.review(second);
    const passed = validation(
      await setup.dispatch({
        kind: "run_validation",
        ...second,
        ...target(secondCopy),
        validationPlanId: planId,
        checkId: check.id,
      }),
    );
    expect(passed).toMatchObject({ outcome: "succeeded", satisfiesCheck: true });
    expect(setup.journal.delivery.evidence(setup.authority.runId, passed.evidenceId).phase).toBe(
      "pre_commit",
    );
    expect(setup.journal.delivery.plan(setup.authority.runId, planId).adequacy).toBe("unreviewed");
    expect(
      setup.kernel.capabilities().find((item) => item.kind === "request_commit")?.available,
    ).toBe(false);
    expect(readFileSync(join(setup.source, "app.txt"), "utf8")).toBe("user-owned change\n");
    expect(readFileSync(join(setup.source, ".git", "index"))).toEqual(userIndex);
    expect(git(setup.source, "rev-parse", "HEAD")).toBe(setup.head);
    const inspected = success(
      await setup.dispatch({ kind: "inspect_evidence", evidenceId: failed.evidenceId }),
    );
    expect(inspected.kind === "inspection" && inspected.text).toContain("expected-green");
    expect(inspected.kind === "inspection" && inspected.text).not.toContain(
      setup.authority.leaseId,
    );
  });

  it("retains mandatory commands, rejects substitutions, and invalidates old evidence when the plan changes", async () => {
    const setup = await fixture();
    const denied = await setup.dispatch({
      kind: "define_validation_plan",
      taskId: "demo.1",
      acceptanceCriteria: ["Green"],
      checks: [{ ...actionCheck(check), command: "/bin/true", args: [] }],
    });
    expect(denied).toMatchObject({ status: "rejected", code: "required_check_changed" });
    const planId = await setup.define([
      { ...actionCheck(check), id: "additional", command: "/bin/true", args: [] },
    ]);
    expect(
      setup.journal.delivery.plan(setup.authority.runId, planId).checks.map((item) => item.id),
    ).toEqual(["additional", check.id]);
    writeFileSync(join(setup.workspace.path, "app.txt"), "green\n");
    const candidate = await setup.capture(planId);
    const copy = await setup.review(candidate);
    const result = validation(
      await setup.dispatch({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: check.id,
      }),
    );
    expect(result.satisfiesCheck).toBe(true);
    await setup.define();
    expect(setup.journal.delivery.satisfiesCheck(setup.authority.runId, result.evidenceId)).toBe(
      false,
    );
    expect(
      setup.journal.delivery.evidence(setup.authority.runId, result.evidenceId).outcome?.exitCode,
    ).toBe(0);
  });

  it("prevents receipt writes during validation, retains diagnostics, and permits another tactic", async () => {
    const receiptCheck = { ...check, id: "receipts", args: ["-c", "echo forged >> app.txt"] };
    const setup = await fixture({ requiredChecks: [receiptCheck] });
    const planId = await setup.define([
      actionCheck(receiptCheck),
      { ...actionCheck(check), id: "no-receipts", command: "/bin/cat", args: ["app.txt"] },
    ]);
    const candidate = await setup.capture(planId);
    const copy = await setup.review(candidate);
    const rejectedWrite = validation(
      await setup.dispatch({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: "receipts",
      }),
    );
    expect(rejectedWrite).toMatchObject({ outcome: "failed", satisfiesCheck: false });
    expect(readFileSync(join(copy.path, "app.txt"), "utf8")).toBe("red\n");
    const clean = validation(
      await setup.dispatch({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: "no-receipts",
      }),
    );
    expect(clean.satisfiesCheck).toBe(true);
    expect(
      setup.journal.delivery.satisfiesCheck(setup.authority.runId, rejectedWrite.evidenceId),
    ).toBe(false);
    expect(setup.journal.control(setup.authority.runId).status).toBe("active");
  });

  it("makes later failed retries supersede a pass and does not replay the same action", async () => {
    const retryCheck = {
      ...check,
      args: ["-c", "if test -e scratch/once; then exit 9; fi; touch scratch/once"],
    };
    const setup = await fixture({ requiredChecks: [retryCheck], writableScratch: ["scratch"] });
    const planId = await setup.define([actionCheck(retryCheck)]);
    const candidate = await setup.capture(planId);
    const copy = await setup.review(candidate);
    const action: KernelAction = {
      kind: "run_validation",
      ...candidate,
      ...target(copy),
      validationPlanId: planId,
      checkId: retryCheck.id,
    };
    const request = setup.decision(action);
    const running = await setup.kernel.execute(request, setup.authority);
    if (running.status !== "running") throw new Error("Expected supervised asynchronous work");
    const first = validation(await setup.kernel.operation(running.operationId)!);
    expect(first.satisfiesCheck).toBe(true);
    expect(validation(await setup.kernel.execute(request, setup.authority))).toEqual(first);
    const second = validation(await setup.dispatch(action));
    expect(second).toMatchObject({ outcome: "failed", satisfiesCheck: false });
    expect(setup.journal.delivery.satisfiesCheck(setup.authority.runId, first.evidenceId)).toBe(
      false,
    );
    expect(
      setup.journal.delivery.evidence(setup.authority.runId, second.evidenceId).outcome?.exitCode,
    ).toBe(9);
  });

  it("rejects a mismatched candidate/workspace, exact-commit claims, and unknown bindings", async () => {
    const setup = await fixture();
    const planId = await setup.define();
    const first = await setup.capture(planId);
    const firstCopy = await setup.review(first);
    writeFileSync(join(setup.workspace.path, "app.txt"), "green\n");
    const second = await setup.capture(planId);
    expect(
      await setup.dispatch({
        kind: "run_validation",
        ...second,
        ...target(firstCopy),
        validationPlanId: planId,
        checkId: check.id,
      }),
    ).toMatchObject({ status: "rejected", code: "validation_target" });
    expect(
      await setup.dispatch({ kind: "create_review_workspace", ...first, revision: setup.head }),
    ).toMatchObject({ status: "rejected", code: "commit_not_current" });
    expect(
      await setup.dispatch({
        kind: "define_validation_plan",
        taskId: "demo.1",
        acceptanceCriteria: ["Green"],
        checks: [{ ...actionCheck(check), id: "external", environmentBindings: ["host-database"] }],
      }),
    ).toMatchObject({ status: "rejected", code: "undeclared_binding" });
  });

  it("records contamination as not-started and never turns it into a passing command", async () => {
    const setup = await fixture();
    const planId = await setup.define();
    const candidate = await setup.capture(planId);
    const copy = await setup.review(candidate);
    writeFileSync(join(copy.path, "app.txt"), "green\n");
    const result = validation(
      await setup.dispatch({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: check.id,
      }),
    );
    expect(result).toMatchObject({ outcome: "not_started", satisfiesCheck: false });
    expect(
      setup.journal.delivery.evidence(setup.authority.runId, result.evidenceId).outcome?.exitCode,
    ).toBeNull();
    expect(readFileSync(join(copy.path, "app.txt"), "utf8")).toBe("green\n");
    expect(setup.journal.agents.activeWorkspaceOperation(setup.authority.runId, copy)).toBeNull();
  });

  it("keeps a capture failure recoverable without erasing the protected delta", async () => {
    const setup = await fixture();
    const planId = await setup.define();
    writeFileSync(join(setup.workspace.path, ".beads", "issues.jsonl"), "illegal tracker update\n");
    expect(
      await setup.dispatch({
        kind: "capture_candidate",
        taskId: "demo.1",
        ...target(setup.workspace),
        validationPlanId: planId,
      }),
    ).toMatchObject({ status: "failed" });
    expect(setup.journal.delivery.latestCandidate(setup.authority.runId, "demo.1")?.status).toBe(
      "failed",
    );
    expect(readFileSync(join(setup.workspace.path, ".beads", "issues.jsonl"), "utf8")).toBe(
      "illegal tracker update\n",
    );
    writeFileSync(join(setup.workspace.path, ".beads", "issues.jsonl"), "tracker\n"); // Test fixture explicitly resolves its own mutation.
    const next = await setup.capture(planId);
    expect(next.candidateGeneration).toBe(2);
  });

  it("persists plans, manifests, and results across reopen and preserves them in quarantine", async () => {
    const setup = await fixture();
    writeFileSync(join(setup.workspace.path, "app.txt"), "green\n");
    const planId = await setup.define();
    const candidate = await setup.capture(planId);
    const copy = await setup.review(candidate);
    const result = validation(
      await setup.dispatch({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: planId,
        checkId: check.id,
      }),
    );
    const reopened = new StateStore(setup.path);
    stores.push(reopened);
    expect(
      reopened.orchestration.delivery.satisfiesCheck(setup.authority.runId, result.evidenceId),
    ).toBe(true);
    expect(reopened.orchestration.delivery.candidate(setup.authority.runId, candidate)).toEqual(
      setup.journal.delivery.candidate(setup.authority.runId, candidate),
    );
    setup.store.releaseLease(setup.authority.runId, setup.authority.ownerToken);
    const db = new Database(setup.path);
    try {
      const raw = db
        .prepare("SELECT * FROM validation_evidence WHERE evidence_id = ?")
        .get(result.evidenceId);
      db.prepare("UPDATE runs SET state_json = 'broken' WHERE run_id = ?").run(
        setup.authority.runId,
      );
      setup.store.quarantineInvalidRun(setup.authority.runId);
      const saved = db
        .prepare(
          "SELECT row_json FROM quarantined_orchestration WHERE run_id = ? AND source_table = 'validation_evidence'",
        )
        .get(setup.authority.runId) as { row_json: string };
      expect(JSON.parse(saved.row_json)).toEqual(raw);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("Validation never produced its startup marker");
    await delay(10);
  }
}
