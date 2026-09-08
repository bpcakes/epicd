import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import type {
  ActionResult,
  ControllerAuthority,
  KernelAction,
  OrchestratorDecision,
} from "../src/domain/orchestration.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { OperationFailed } from "../src/kernel/guards.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-action-interruption-");
  const path = join(root, "state.sqlite3");
  const store = new StateStore(path);
  const run = store.create(
    initialRun(randomUUID()),
    RepositoryPolicySchema.parse({ schemaVersion: 1 }),
  );
  const lease = store.acquireLease(run.runId);
  const authority: ControllerAuthority = {
    runId: run.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const journal = store.orchestration;
  const kernel = new ActionKernel(journal);
  const db = new Database(path);
  const jobs: { signal: AbortSignal; finish: () => void }[] = [];
  kernel.registerExternal("refresh_tracker", async ({ signal }) => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    jobs.push({ signal, finish });
    await gate;
    if (signal.aborted) throw new OperationFailed("Controlled handler has now stopped");
    return { kind: "inspection", text: "Controlled handler completed", artifactIds: [] };
  });
  cleanups.push(async () => {
    kernel.interruptAll();
    for (const job of jobs) job.finish();
    await kernel.drain();
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  function decision(action: KernelAction, owner = authority): OrchestratorDecision {
    const ticket = journal.beginDecision(
      owner,
      journal.latestObservationCursor(owner.runId),
      journal.control(owner.runId).controlVersion,
    );
    return {
      explanation: "Interrupt only the exact action whose work is no longer useful",
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
  async function settle(request: OrchestratorDecision, executor = kernel, owner = authority) {
    const result = await executor.execute(request, owner);
    return result.status === "running"
      ? ((await executor.operation(result.operationId)) ??
          journal.action(owner.runId, result.actionId)!.result!)
      : result;
  }
  async function start() {
    const result = await kernel.execute(decision({ kind: "refresh_tracker" }), authority);
    if (result.status !== "running") throw new Error("Expected a running controlled handler");
    const job = jobs.at(-1)!;
    return { ...result, ...job, pending: kernel.operation(result.operationId)! };
  }
  const interrupt = (actionId: string): KernelAction => ({
    kind: "interrupt_action",
    actionId,
    reason: "Observed work no longer serves the current hypothesis",
  });
  return { store, journal, kernel, db, authority, decision, settle, start, interrupt };
}

function inspection(result: ActionResult) {
  if (result.status !== "succeeded" || result.result.kind !== "inspection")
    throw new Error(`Expected interruption acknowledgment: ${JSON.stringify(result)}`);
  return JSON.parse(result.result.text);
}

describe("targeted kernel action interruption", () => {
  it("journals the exact target before signalling, keeps unrelated work running and does not invent stop", async () => {
    const s = fixture(),
      target = await s.start(),
      unrelated = await s.start();
    let auditedAtSignal = false;
    target.signal.addEventListener(
      "abort",
      () => {
        auditedAtSignal = s.journal
          .observations(s.authority.runId)
          .some(
            (row) =>
              row.kind === "action.interruption_requested" && row.summary.includes(target.actionId),
          );
      },
      { once: true },
    );
    const request = s.decision(s.interrupt(target.actionId));
    const acknowledged = await s.settle(request);
    expect(inspection(acknowledged)).toMatchObject({
      actionId: target.actionId,
      operationId: target.operationId,
      interruption: "requested",
    });
    expect(auditedAtSignal).toBe(true);
    expect(target.signal.aborted).toBe(true);
    expect(unrelated.signal.aborted).toBe(false);
    expect(s.journal.action(s.authority.runId, target.actionId)).toMatchObject({
      status: "running",
      result: null,
    });
    expect(s.journal.control(s.authority.runId).status).toBe("active");
    const observations = s.journal.observations(s.authority.runId);
    expect(await s.settle(request)).toEqual(acknowledged);
    expect(s.journal.observations(s.authority.runId)).toEqual(observations);
    expect(inspection(await s.settle(s.decision(s.interrupt(target.actionId))))).toMatchObject({
      interruption: "already_requested",
    });
    target.finish();
    expect(await target.pending).toMatchObject({ status: "cancelled" });
    unrelated.finish();
    expect(await unrelated.pending).toMatchObject({ status: "succeeded" });
  });

  it("does not signal when the durable request observation cannot commit", async () => {
    const s = fixture(),
      target = await s.start();
    s.db.exec(`CREATE TRIGGER deny_interruption_audit BEFORE INSERT ON observations
      WHEN json_extract(NEW.observation_json, '$.kind') = 'action.interruption_requested'
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    expect(await s.settle(s.decision(s.interrupt(target.actionId)))).toMatchObject({
      status: "indeterminate",
    });
    expect(target.signal.aborted).toBe(false);
    expect(s.journal.action(s.authority.runId, target.actionId)?.status).toBe("running");
    target.finish();
    expect(await target.pending).toMatchObject({ status: "succeeded" });
  });

  it("leaves a settled result unchanged and sends no late signal", async () => {
    const s = fixture(),
      target = await s.start();
    target.finish();
    await target.pending;
    const original = s.journal.action(s.authority.runId, target.actionId);
    expect(inspection(await s.settle(s.decision(s.interrupt(target.actionId))))).toMatchObject({
      interruption: "already_settled",
    });
    expect(s.journal.action(s.authority.runId, target.actionId)).toEqual(original);
    expect(target.signal.aborted).toBe(false);
  });

  it("rejects unknown and foreign action IDs without signalling a local action", async () => {
    const s = fixture(),
      local = await s.start(),
      other = fixture(),
      foreign = await other.start();
    for (const actionId of [randomUUID(), foreign.actionId])
      expect(await s.settle(s.decision(s.interrupt(actionId)))).toMatchObject({
        status: "rejected",
        code: "unknown_action",
      });
    expect(local.signal.aborted).toBe(false);
    expect(foreign.signal.aborted).toBe(false);
  });

  it("does not reconstruct a missing live handle in another kernel", async () => {
    const s = fixture(),
      target = await s.start(),
      coldKernel = new ActionKernel(s.journal);
    expect(await s.settle(s.decision(s.interrupt(target.actionId)), coldKernel)).toMatchObject({
      status: "rejected",
      code: "action_interruption_unavailable",
    });
    expect(target.signal.aborted).toBe(false);
    expect(s.journal.action(s.authority.runId, target.actionId)?.status).toBe("running");
  });

  it.each(["accepted", "indeterminate"] as const)(
    "does not treat a retained %s action as stopped or replay it",
    async (status) => {
      const s = fixture();
      const admission = s.journal.acceptAction(
        s.authority,
        s.decision({ kind: "refresh_tracker" }),
      );
      if (admission.kind === "rejected") throw new Error("Expected admitted intent");
      const actionId = admission.action.actionId;
      if (status === "indeterminate") {
        s.journal.startAction(s.authority, actionId);
        s.journal.settleAction(s.authority, actionId, "running", {
          status,
          actionId,
          problemId: "unknown-stop",
        });
      }
      const original = s.journal.action(s.authority.runId, actionId);
      expect(await s.settle(s.decision(s.interrupt(actionId)))).toMatchObject({
        status: "rejected",
        code: "action_interruption_unavailable",
      });
      expect(s.journal.action(s.authority.runId, actionId)).toEqual(original);
      expect(s.kernel.operation(admission.action.operationId)).toBeNull();
    },
  );

  it("refuses an old controller's handle even when the caller owns a replacement lease", async () => {
    const s = fixture(),
      target = await s.start();
    s.store.releaseLease(s.authority.runId, s.authority.ownerToken);
    const lease = s.store.acquireLease(s.authority.runId);
    const replacement = {
      runId: s.authority.runId,
      ownerToken: lease.ownerToken,
      leaseId: lease.leaseId,
    };
    expect(
      await s.settle(s.decision(s.interrupt(target.actionId), replacement), s.kernel, replacement),
    ).toMatchObject({
      status: "rejected",
      code: "action_interruption_unavailable",
    });
    expect(target.signal.aborted).toBe(false);
  });

  it("rejects stale control before signalling an otherwise live target", async () => {
    const s = fixture(),
      target = await s.start();
    const request = s.decision(s.interrupt(target.actionId));
    s.journal.setEscalation(s.authority, "Operator judgment is required", "judgment", []);
    expect(await s.settle(request)).toMatchObject({ status: "rejected", code: "run_not_active" });
    expect(target.signal.aborted).toBe(false);
  });

  it("does not target another interruption request", async () => {
    const s = fixture();
    const original = await s.settle(s.decision(s.interrupt(randomUUID())));
    expect(await s.settle(s.decision(s.interrupt(original.actionId)))).toMatchObject({
      status: "rejected",
      code: "invalid_interruption_target",
    });
  });

  it("refuses a self-targeted request without waiting for its own result", async () => {
    const s = fixture(),
      actionId = randomUUID();
    const request = s.decision(s.interrupt(actionId));
    const admitted = s.journal.acceptAction(s.authority, request);
    if (admitted.kind === "rejected") throw new Error("Expected admitted request");
    // Controlled identity collision: the public admission normally chooses an
    // unpredictable ID after the model has submitted its target.
    s.db
      .prepare("UPDATE actions SET action_id = ? WHERE action_id = ?")
      .run(actionId, admitted.action.actionId);
    expect(await s.settle(request)).toMatchObject({
      status: "rejected",
      code: "invalid_interruption_target",
    });
  });

  it("rejects a stale caller lease before it can signal a live target", async () => {
    const s = fixture(),
      target = await s.start();
    const request = s.decision(s.interrupt(target.actionId));
    s.store.releaseLease(s.authority.runId, s.authority.ownerToken);
    s.store.acquireLease(s.authority.runId);
    await expect(s.settle(request)).rejects.toThrow();
    expect(target.signal.aborted).toBe(false);
  });
});
