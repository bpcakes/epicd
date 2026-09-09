import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import * as lifetime from "../src/adapters/command-lifetime.js";
import {
  reconcileWorkspaceCreationIO,
  assertWorkspaceCreationWorker,
  WorkspaceCreationRequestSchema,
} from "../src/adapters/workspace-creation-io.js";
import { WorkspaceCreationSchema } from "../src/domain/workspace-creation.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { registerWorkspaceDisposalCapabilities } from "../src/kernel/workspace-disposal.js";
import { reconcileDeliveryAction } from "../src/kernel/delivery-recovery.js";
import { fixture, git, target } from "./fixtures/review.js";

describe.skipIf(process.platform !== "linux")("complete workspace creation lifetime", () => {
  it("fences one unused creation worker and releases both copy resources without replaying that creation", async () => {
    const f = await fixture();
    const candidate = await f.capture(await f.define());
    const before = readFileSync(join(f.workspace.path, "app.txt"));
    const start = lifetime.startDurableCommand;
    const fault = vi.spyOn(lifetime, "startDurableCommand").mockImplementation(() => {
      throw new Error("Lost controller before workspace worker dispatch");
    });
    try {
      const result = await f.dispatch({
        kind: "create_review_workspace",
        ...candidate,
        revision: null,
      });
      expect(result.status).toBe("indeterminate");
      expect(fault).toHaveBeenCalledOnce();
      const [intent, launch] = fault.mock.calls[0]!;
      fault.mockRestore();
      const action = f.journal.action(f.authority.runId, result.actionId)!;
      const destination = f.journal.agents.workspaceForOperation(
        f.authority.runId,
        action.operationId,
      )!;
      expect(destination.status).toBe("reserved");
      expect(existsSync(destination.path)).toBe(false);
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, f.workspace)).toBeNull();
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, destination)).toBeNull();
      expect(
        f.journal.delivery.reviewCopyForOperation(f.authority.runId, action.operationId),
      ).toBeNull();
      const delayed = start(intent, launch);
      delayed.child.stdout!.resume();
      delayed.child.stderr!.resume();
      await expect(delayed.result).rejects.toThrow("supervisor failed");
      expect(existsSync(destination.path)).toBe(false);
      expect(readFileSync(join(f.workspace.path, "app.txt"))).toEqual(before);
      expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
      const fresh = await f.copy(candidate);
      expect(fresh.workspaceId).not.toBe(destination.workspaceId);
      expect(fresh.status).toBe("ready");
      expect(readFileSync(join(fresh.path, "app.txt"))).toEqual(before);
      expect(existsSync(destination.path)).toBe(false);
    } finally {
      fault.mockRestore();
    }
  });

  it("withholds both copy resources when a receipt is unavailable despite a ready copy and retained review binding", async () => {
    const f = await fixture();
    f.preserveArtifacts();
    process.stdout.write(`Retained missing-creation-receipt fixture: ${f.root}\n`);
    registerWorkspaceDisposalCapabilities(f.kernel, f.manager);
    const plan = await f.define(),
      candidate = await f.capture(plan);
    const fault = vi.spyOn(lifetime, "recoverCommandStop").mockResolvedValue(null);
    try {
      const result = await f.dispatch({
        kind: "create_review_workspace",
        ...candidate,
        revision: null,
      });
      expect(result.status).toBe("indeterminate");
      const action = f.journal.action(f.authority.runId, result.actionId)!;
      const copy = f.journal.agents.workspaceForOperation(f.authority.runId, action.operationId)!;
      const creation = f.journal.workspaceCreations.forWorkspace(f.authority.runId, copy)!;
      expect(creation).toMatchObject({
        workerResult: { status: "created" },
        outcome: null,
        stop: null,
      });
      expect(copy.status).toBe("ready");
      const binding = f.journal.delivery.reviewCopyForOperation(
        f.authority.runId,
        action.operationId,
      );
      expect(binding?.workspaceId).toBe(copy.workspaceId);
      for (const [workspace, operationId] of [
        [copy, creation.workspaceOperationId],
        [f.workspace, creation.sourceOperationId!],
      ] as const) {
        expect(
          f.journal.agents.activeWorkspaceOperation(f.authority.runId, workspace)?.operationId,
        ).toBe(operationId);
        expect(() =>
          f.journal.agents.finishWorkspaceOperation(
            f.authority,
            operationId,
            "succeeded",
            "The copy looks ready",
          ),
        ).toThrow("complete creation worker");
      }
      await expect(
        reconcileWorkspaceCreationIO(f.journal, f.authority, creation.creationId),
      ).rejects.toThrow("no independent stop receipt");
      expect(
        (
          await f.dispatch({
            kind: "run_validation",
            ...candidate,
            ...target(copy),
            validationPlanId: plan,
            checkId: "app-check",
          })
        ).status,
      ).toBe("rejected");
      const inspected = await f.dispatch({ kind: "inspect_workspace", ...target(copy) });
      if (inspected.status !== "succeeded" || inspected.result.kind !== "inspection")
        throw new Error("Workspace inspection missing");
      expect(JSON.parse(inspected.result.text)).toMatchObject({
        creation: { stopConfirmed: false, outcome: null },
      });
      expect(inspected.result.text).not.toContain(f.authority.ownerToken);
      expect(inspected.result.text).not.toContain(creation.execution!.directory.path);
      fault.mockRestore();
      const launches = vi.spyOn(lifetime, "startDurableCommand");
      try {
        f.newLease();
        const journal = f.reopen().orchestration;
        journal.markInterruptedActions(f.authority);
        const settled = await reconcileWorkspaceCreationIO(
          journal,
          f.authority,
          creation.creationId,
        );
        expect(settled.outcome).toBe("created");
        expect(
          await reconcileWorkspaceCreationIO(journal, f.authority, creation.creationId),
        ).toEqual(settled);
        expect(launches).not.toHaveBeenCalled();
        expect(
          journal.delivery.reviewCopyForOperation(f.authority.runId, action.operationId),
        ).toEqual(binding);
        expect(journal.agents.activeWorkspaceOperation(f.authority.runId, copy)).toBeNull();
        expect(journal.agents.activeWorkspaceOperation(f.authority.runId, f.workspace)).toBeNull();
        expect(journal.reviews.approval(f.authority.runId, candidate)).toBeNull();
        expect(readFileSync(join(copy.path, "app.txt"), "utf8")).toBe("green\n");
      } finally {
        launches.mockRestore();
      }
    } finally {
      fault.mockRestore();
    }
  });

  it.each(["before_ack", "after_ack"])(
    "recovers both creation locks and the original binding after controller SIGKILL %s without copying or approval",
    async (crashPoint) => {
      const f = await fixture();
      f.preserveArtifacts();
      process.stdout.write(`Retained creation caller crash fixture (${crashPoint}): ${f.root}\n`);
      const candidate = await f.capture(await f.define());
      writeFileSync(join(f.source, "app.txt"), "user staged bytes\n");
      git(f.source, "add", "app.txt");
      const index = readFileSync(join(f.source, ".git/index"));
      writeFileSync(join(f.source, "app.txt"), "user unstaged bytes\n");
      const child = spawn(
        process.execPath,
        [resolve("test/fixtures/workspace-creation-kernel-caller.mjs")],
        { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], shell: false },
      );
      const closed = once(child, "close");
      void closed.catch(() => {});
      child.stdout.resume();
      let diagnostics = "";
      child.stderr.on("data", (chunk) => {
        diagnostics = (diagnostics + String(chunk)).slice(-4000);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(
        JSON.stringify({
          stateFile: f.store.storageIdentity(),
          workspaceRoot: join(f.root, "managed"),
          authority: f.authority,
          crashPoint,
          decision: f.decision({ kind: "create_review_workspace", ...candidate, revision: null }),
        }),
      );
      try {
        expect(await closed, diagnostics).toEqual([null, "SIGKILL"]);
        const action = f.journal
          .actions(f.authority.runId)
          .findLast((item) => item.request.action.kind === "create_review_workspace")!;
        const copy = f.journal.agents.workspaceForOperation(f.authority.runId, action.operationId)!;
        const pending = f.journal.workspaceCreations.forWorkspace(f.authority.runId, copy)!;
        expect(pending).toMatchObject({ outcome: null, workerResult: { status: "created" } });
        const receipt = await lifetime.readCommandStop(pending.execution!);
        expect(receipt).toMatchObject({ kind: "stopped", code: 0, reason: null, error: null });
        expect(pending.stop).toEqual(crashPoint === "after_ack" ? receipt : null);
        const binding = f.journal.delivery.reviewCopyForOperation(
          f.authority.runId,
          action.operationId,
        );
        expect(binding?.workspaceId).toBe(copy.workspaceId);
        for (const operationId of [pending.workspaceOperationId, pending.sourceOperationId!])
          expect(
            f.journal.agents.workspaceOperation(f.authority.runId, operationId).stopEvidence,
          ).toBeNull();
        const bytes = readFileSync(join(copy.path, "app.txt"));
        f.newLease();
        const journal = f.reopen().orchestration;
        journal.markInterruptedActions(f.authority);
        const manager = new WorkspaceManager(journal, join(f.root, "managed"));
        const launches = vi.spyOn(lifetime, "startDurableCommand");
        try {
          // This is the same inspector used by cold bootstrap and reconcile_action.
          // The driver is not called for creation recovery.
          const outcome = await reconcileDeliveryAction(
            journal,
            manager,
            f.driver,
            f.authority,
            journal.action(f.authority.runId, action.actionId)!,
          );
          expect(outcome).toMatchObject({
            status: "succeeded",
            result: { kind: "resource", resourceId: copy.workspaceId },
          });
          // Creation is recovered from its original receipt. Current readiness is
          // a separate supervised read, never a replay of the copying worker.
          expect(launches).toHaveBeenCalledTimes(1);
          expect(launches.mock.calls[0]![1].args).toEqual([
            resolve("dist/adapters/workspace-inspection-io-cli.js"),
          ]);
          const inspections = journal.workspaceInspections.forWorkspace(f.authority.runId, copy);
          expect(inspections).toHaveLength(1);
          expect(inspections[0]).toMatchObject({
            target: { kind: "materialization" },
            outcome: "observed",
            workerResult: { status: "observed", observation: { ready: true } },
            stop: { kind: "stopped", code: 0 },
          });
          expect(launches.mock.calls[0]![0]).toEqual(inspections[0]!.execution);
          expect(
            journal.workspaceCreations.get(f.authority.runId, pending.creationId),
          ).toMatchObject({ outcome: "created", stop: receipt });
          expect(
            journal.delivery.reviewCopyForOperation(f.authority.runId, action.operationId),
          ).toEqual(binding);
          expect(journal.agents.activeWorkspaceOperation(f.authority.runId, copy)).toBeNull();
          expect(
            journal.agents.activeWorkspaceOperation(f.authority.runId, f.workspace),
          ).toBeNull();
          expect(journal.reviews.approval(f.authority.runId, candidate)).toBeNull();
          expect(readFileSync(join(copy.path, "app.txt"))).toEqual(bytes);
          expect(git(copy.path, "rev-parse", "HEAD")).toBe(binding!.revision);
          expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
          expect(readFileSync(join(f.source, ".git/index"))).toEqual(index);
          expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("user unstaged bytes\n");
        } finally {
          launches.mockRestore();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
    },
  );

  it("does not fence a live creation when the model asks to reconcile it", async () => {
    const f = await fixture(),
      candidate = await f.capture(await f.define());
    const prepare = lifetime.prepareCommandLifetime;
    let release!: () => void, announce!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const fault = vi
      .spyOn(lifetime, "prepareCommandLifetime")
      .mockImplementation(async (...args) => {
        const intent = await prepare(...args);
        announce();
        await gate;
        return intent;
      });
    const started = await f.kernel.execute(
      f.decision({ kind: "create_review_workspace", ...candidate, revision: null }),
      f.authority,
    );
    if (started.status !== "running") throw new Error("Creation did not start asynchronously");
    const running = f.kernel.operation(started.operationId)!;
    try {
      await admitted;
      const copy = f.journal.agents.workspaceForOperation(f.authority.runId, started.operationId)!;
      expect(
        await f.dispatch({ kind: "reconcile_action", actionId: started.actionId }),
      ).toMatchObject({ status: "rejected", code: "recovery_action_live" });
      expect(f.journal.workspaceCreations.forWorkspace(f.authority.runId, copy)).toMatchObject({
        outcome: null,
        execution: null,
      });
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, copy)).not.toBeNull();
      expect(
        f.journal.agents.activeWorkspaceOperation(f.authority.runId, f.workspace),
      ).not.toBeNull();
      release();
      expect((await running).status).toBe("succeeded");
      expect(f.journal.agents.workspace(f.authority.runId, copy).status).toBe("ready");
    } finally {
      release();
      await running;
      fault.mockRestore();
    }
  });

  it("rolls back readiness and review binding when completion cannot be retained, preserving files without making them usable", async () => {
    const f = await fixture(),
      plan = await f.define(),
      candidate = await f.capture(plan);
    const db = new Database(f.path);
    try {
      db.exec(
        "CREATE TRIGGER deny_creation_result BEFORE UPDATE ON workspace_creations WHEN json_extract(NEW.record_json,'$.workerResult') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Worker result not durable'); END",
      );
      const result = await f.dispatch({
        kind: "create_review_workspace",
        ...candidate,
        revision: null,
      });
      expect(result.status).toBe("indeterminate");
      const action = f.journal.action(f.authority.runId, result.actionId)!;
      const copy = f.journal.agents.workspaceForOperation(f.authority.runId, action.operationId)!;
      const creation = f.journal.workspaceCreations.forWorkspace(f.authority.runId, copy)!;
      expect(creation).toMatchObject({
        outcome: "failed",
        workerResult: null,
        stop: { kind: "stopped", code: 1 },
      });
      expect(copy).toMatchObject({
        status: "reserved",
        directory: null,
        baselineFingerprint: null,
      });
      expect(
        f.journal.delivery.reviewCopyForOperation(f.authority.runId, action.operationId),
      ).toBeNull();
      expect(
        (
          await f.dispatch({
            kind: "run_validation",
            ...candidate,
            ...target(copy),
            validationPlanId: plan,
            checkId: "app-check",
          })
        ).status,
      ).toBe("rejected");
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, copy)).toBeNull();
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, f.workspace)).toBeNull();
      expect(readFileSync(join(copy.path, "app.txt"), "utf8")).toBe("green\n");
      expect(f.journal.reviews.approval(f.authority.runId, candidate)).toBeNull();
      db.exec("DROP TRIGGER deny_creation_result");
      const fresh = await f.copy(candidate);
      expect(fresh.workspaceId).not.toBe(copy.workspaceId);
      expect(fresh.status).toBe("ready");
      expect(readFileSync(join(copy.path, "app.txt"), "utf8")).toBe("green\n");
    } finally {
      db.close();
    }
  });

  it("atomically cancels both resources after lease loss before worker binding", async () => {
    const f = await fixture(),
      candidate = await f.capture(await f.define());
    const prepare = lifetime.prepareCommandLifetime;
    const fault = vi.spyOn(lifetime, "prepareCommandLifetime").mockImplementation(async () => {
      f.newLease();
      throw new Error("Controller lost before creation worker binding");
    });
    try {
      await expect(
        f.dispatch({ kind: "create_review_workspace", ...candidate, revision: null }),
      ).rejects.toThrow("controller lease was lost or replaced");
      const action = f.journal
        .actions(f.authority.runId)
        .findLast((item) => item.request.action.kind === "create_review_workspace")!;
      const copy = f.journal.agents.workspaceForOperation(f.authority.runId, action.operationId)!;
      const pending = f.journal.workspaceCreations.forWorkspace(f.authority.runId, copy)!;
      expect(pending).toMatchObject({
        execution: null,
        stop: null,
        outcome: null,
        workerResult: null,
      });
      const args = fault.mock.calls[0]!;
      fault.mockRestore();
      const journal = f.reopen().orchestration;
      journal.markInterruptedActions(f.authority);
      const settled = await reconcileWorkspaceCreationIO(journal, f.authority, pending.creationId);
      expect(settled).toMatchObject({
        outcome: "failed",
        execution: null,
        stop: null,
        workerResult: null,
      });
      expect(journal.agents.activeWorkspaceOperation(f.authority.runId, copy)).toBeNull();
      expect(journal.agents.activeWorkspaceOperation(f.authority.runId, f.workspace)).toBeNull();
      expect(existsSync(copy.path)).toBe(false);
      const late = await prepare(...args);
      expect(() => journal.workspaceCreations.bind(f.authority, pending.creationId, late)).toThrow(
        "live admitted intent",
      );
      expect(await lifetime.recoverCommandStop(late)).toMatchObject({ kind: "not_started" });
      expect(readFileSync(join(f.workspace.path, "app.txt"), "utf8")).toBe("green\n");
    } finally {
      fault.mockRestore();
    }
  });

  it("rolls back both reservations if the creation intent cannot be recorded", async () => {
    const f = await fixture(),
      candidate = await f.capture(await f.define());
    const db = new Database(f.path),
      launches = vi.spyOn(lifetime, "startDurableCommand");
    const before = db.prepare("SELECT * FROM workspace_operations ORDER BY operation_id").all();
    try {
      db.exec(
        "CREATE TRIGGER deny_creation_intent BEFORE INSERT ON workspace_creations BEGIN SELECT RAISE(ABORT, 'Creation intent not durable'); END",
      );
      const result = await f.dispatch({
        kind: "create_review_workspace",
        ...candidate,
        revision: null,
      });
      expect(result.status).toBe("indeterminate");
      expect(launches).not.toHaveBeenCalled();
      const action = f.journal.action(f.authority.runId, result.actionId)!;
      expect(
        f.journal.agents.workspaceForOperation(f.authority.runId, action.operationId),
      ).toBeNull();
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, f.workspace)).toBeNull();
      expect(db.prepare("SELECT * FROM workspace_operations ORDER BY operation_id").all()).toEqual(
        before,
      );
    } finally {
      launches.mockRestore();
      db.close();
    }
  });

  it("binds the exact request and copy participants, rejecting mismatches before filesystem writes", async () => {
    const f = await fixture(),
      candidate = await f.capture(await f.define());
    const start = lifetime.startDurableCommand;
    let checked = false,
      rejected = 0;
    const fault = vi.spyOn(lifetime, "startDurableCommand").mockImplementation((intent, launch) => {
      const request = WorkspaceCreationRequestSchema.parse(JSON.parse(launch.extraInput!));
      const record = assertWorkspaceCreationWorker(f.journal, request);
      checked = record.source.kind === "snapshot";
      for (const changed of [
        { ...request, creationId: "00000000-0000-4000-8000-000000000001" },
        {
          ...request,
          stateFile: { ...request.stateFile, path: `${request.stateFile.path}-other` },
        },
      ]) {
        try {
          assertWorkspaceCreationWorker(f.journal, changed);
        } catch {
          rejected += 1;
        }
      }
      for (const changed of [
        { ...record, sourceOperationId: record.workspaceOperationId },
        { ...record, workspaceGeneration: record.workspaceGeneration + 1 },
        { ...record, workspaceRoot: `${record.workspaceRoot}-other` },
      ]) {
        if (!WorkspaceCreationSchema.safeParse(changed).success) rejected += 1;
      }
      return start(intent, launch);
    });
    try {
      const copy = await f.copy(candidate);
      expect(fault).toHaveBeenCalledOnce();
      expect(checked).toBe(true);
      expect(rejected).toBe(5);
      expect(copy.status).toBe("ready");
    } finally {
      fault.mockRestore();
    }
  });
});
