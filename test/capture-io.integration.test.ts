import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import * as lifetime from "../src/adapters/command-lifetime.js";
import {
  CaptureIORequestSchema,
  assertCaptureWorker,
  reconcileCaptureIO,
} from "../src/adapters/capture-io.js";
import { CandidateRecordSchema } from "../src/domain/delivery.js";
import { fixture, git, target } from "./fixtures/review.js";

describe.skipIf(process.platform !== "linux")("candidate capture worker lifetime", () => {
  it("fences a bound but undispatched capture without inventing a snapshot or replaying it", async () => {
    const f = await fixture();
    const plan = await f.define();
    const start = lifetime.startDurableCommand;
    const fault = vi.spyOn(lifetime, "startDurableCommand").mockImplementation(() => {
      throw new Error("Lost caller before capture worker dispatch");
    });
    try {
      const result = await f.dispatch({
        kind: "capture_candidate",
        taskId: f.taskId,
        ...target(f.workspace),
        validationPlanId: plan,
      });
      expect(result.status).toBe("failed");
      expect(fault).toHaveBeenCalledOnce();
      const [intent, launch] = fault.mock.calls[0]!;
      fault.mockRestore();
      const candidate = f.journal.delivery.latestCandidate(f.authority.runId, f.taskId)!;
      expect(candidate).toMatchObject({ status: "failed", snapshot: null });
      expect(
        f.journal.agents.workspaceOperation(f.authority.runId, intent.operationId),
      ).toMatchObject({
        kind: "capture",
        status: "failed",
        execution: intent,
        executionStop: { kind: "not_started", code: null, reason: "cancelled" },
      });
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, f.workspace)).toBeNull();
      const delayed = start(intent, launch);
      delayed.child.stdout!.resume();
      delayed.child.stderr!.resume();
      await expect(delayed.result).rejects.toThrow("supervisor failed");
      expect(f.journal.delivery.latestCandidate(f.authority.runId, f.taskId)).toEqual(candidate);
      expect(git(f.workspace.path, "for-each-ref", "refs/epicd/candidates/")).toBe("");
      expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
    } finally {
      fault.mockRestore();
    }
  });

  it("retains exclusion and withholds captured bytes while the original worker's receipt is unavailable", async () => {
    const f = await fixture();
    const plan = await f.define();
    const fault = vi.spyOn(lifetime, "recoverCommandStop").mockResolvedValue(null);
    try {
      const result = await f.dispatch({
        kind: "capture_candidate",
        taskId: f.taskId,
        ...target(f.workspace),
        validationPlanId: plan,
      });
      expect(result.status).toBe("indeterminate");
      const pending = f.journal.delivery.latestCandidate(f.authority.runId, f.taskId)!;
      expect(pending.status).toBe("capturing");
      expect(pending.snapshot).toBeNull();
      expect(pending.captureIO!.pendingSnapshot).not.toBeNull();
      const revision = pending.captureIO!.pendingSnapshot!.snapshotRevision;
      expect(
        git(f.workspace.path, "rev-parse", `refs/epicd/candidates/${pending.candidateId}`),
      ).toBe(revision);
      await expect(reconcileCaptureIO(f.journal, f.authority, pending)).rejects.toThrow(
        "no independent stop receipt",
      );
      expect(
        f.journal.agents.activeWorkspaceOperation(f.authority.runId, pending)?.operationId,
      ).toBe(pending.captureIO!.workspaceOperationId);
      expect(f.journal.delivery.candidateCurrent(f.authority.runId, pending)).toBe(false);
      expect(
        (
          await f.dispatch({
            kind: "create_review_workspace",
            candidateId: pending.candidateId,
            candidateGeneration: pending.candidateGeneration,
            revision: null,
          })
        ).status,
      ).toBe("rejected");
      const inspected = await f.dispatch({
        kind: "inspect_candidate",
        candidateId: pending.candidateId,
        candidateGeneration: pending.candidateGeneration,
      });
      expect(inspected.status).toBe("succeeded");
      if (inspected.status !== "succeeded" || inspected.result.kind !== "inspection")
        throw new Error("Missing candidate inspection");
      expect(JSON.parse(inspected.result.text)).toMatchObject({
        status: "capturing",
        snapshot: null,
        captureIO: { snapshotRetained: true, settled: false },
      });
      expect(inspected.result.text).not.toContain('"pendingSnapshot"');
      expect(inspected.result.text).not.toContain(f.authority.leaseId);
      fault.mockRestore();
      writeFileSync(join(f.workspace.path, "app.txt"), "concurrent user intervention\n");
      const launches = vi.spyOn(lifetime, "startDurableCommand");
      try {
        f.newLease();
        const journal = f.reopen().orchestration;
        journal.markInterruptedActions(f.authority);
        const settled = await reconcileCaptureIO(journal, f.authority, pending);
        expect(settled).toMatchObject({
          status: "captured",
          snapshot: pending.captureIO!.pendingSnapshot,
          captureIO: { pendingSnapshot: null },
        });
        expect(await reconcileCaptureIO(journal, f.authority, pending)).toEqual(settled);
        expect(launches).not.toHaveBeenCalled();
        expect(readFileSync(join(f.workspace.path, "app.txt"), "utf8")).toBe(
          "concurrent user intervention\n",
        );
        expect(git(f.workspace.path, "show", `${revision}:app.txt`)).toBe("green");
        expect(journal.reviews.approval(f.authority.runId, pending)).toBeNull();
        expect(journal.agents.activeWorkspaceOperation(f.authority.runId, pending)).toBeNull();
      } finally {
        launches.mockRestore();
      }
    } finally {
      fault.mockRestore();
    }
  });

  it.each(["before_ack", "after_ack"])(
    "recovers the retained snapshot after controller SIGKILL %s without recapturing or granting approval",
    async (crashPoint) => {
      const f = await fixture();
      f.preserveArtifacts();
      process.stdout.write(`Retained capture caller crash fixture (${crashPoint}): ${f.root}\n`);
      const plan = await f.define();
      writeFileSync(join(f.source, "app.txt"), "user staged bytes\n");
      git(f.source, "add", "app.txt");
      const index = readFileSync(join(f.source, ".git/index"));
      writeFileSync(join(f.source, "app.txt"), "user unstaged bytes\n");
      const child = spawn(process.execPath, [resolve("test/fixtures/capture-kernel-caller.mjs")], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
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
          decision: f.decision({
            kind: "capture_candidate",
            taskId: f.taskId,
            ...target(f.workspace),
            validationPlanId: plan,
          }),
        }),
      );
      try {
        expect(await closed, diagnostics).toEqual([null, "SIGKILL"]);
        const pending = f.journal.delivery.latestCandidate(f.authority.runId, f.taskId)!;
        expect(pending).toMatchObject({ status: "capturing", snapshot: null });
        const snapshot = pending.captureIO!.pendingSnapshot!;
        expect(snapshot).not.toBeNull();
        const operation = f.journal.agents.workspaceOperation(
          f.authority.runId,
          pending.captureIO!.workspaceOperationId,
        );
        expect(operation.execution).not.toBeNull();
        expect(operation.stopEvidence).toBeNull();
        const receipt = await lifetime.readCommandStop(operation.execution!);
        expect(receipt).toMatchObject({ kind: "stopped", code: 0, reason: null, error: null });
        expect(operation.executionStop).toEqual(crashPoint === "after_ack" ? receipt : null);
        const bytes = git(f.workspace.path, "cat-file", "commit", snapshot.snapshotRevision);
        f.newLease();
        const journal = f.reopen().orchestration;
        journal.markInterruptedActions(f.authority);
        const launches = vi.spyOn(lifetime, "startDurableCommand");
        try {
          const settled = await reconcileCaptureIO(journal, f.authority, pending);
          expect(settled).toMatchObject({
            status: "captured",
            snapshot,
            captureIO: { pendingSnapshot: null },
          });
          expect(await reconcileCaptureIO(journal, f.authority, pending)).toEqual(settled);
          expect(launches).not.toHaveBeenCalled();
        } finally {
          launches.mockRestore();
        }
        expect(
          journal.agents.workspaceOperation(f.authority.runId, operation.operationId).executionStop,
        ).toEqual(receipt);
        expect(journal.agents.activeWorkspaceOperation(f.authority.runId, pending)).toBeNull();
        expect(journal.reviews.approval(f.authority.runId, pending)).toBeNull();
        expect(git(f.workspace.path, "cat-file", "commit", snapshot.snapshotRevision)).toBe(bytes);
        expect(
          git(f.workspace.path, "for-each-ref", "--format=%(objectname)", "refs/epicd/candidates/"),
        ).toBe(snapshot.snapshotRevision);
        expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
        expect(readFileSync(join(f.source, ".git/index"))).toEqual(index);
        expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("user unstaged bytes\n");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
    },
  );

  it("binds the exact worker request and rejects changed identity or premature settlement", async () => {
    const f = await fixture();
    const plan = await f.define();
    const start = lifetime.startDurableCommand;
    let admitted: ReturnType<typeof assertCaptureWorker> | undefined;
    let rejected = 0;
    const fault = vi.spyOn(lifetime, "startDurableCommand").mockImplementation((intent, launch) => {
      const request = CaptureIORequestSchema.parse(JSON.parse(launch.extraInput!));
      admitted = assertCaptureWorker(f.journal, request);
      for (const changed of [
        { ...request, workspaceRoot: `${request.workspaceRoot}-other` },
        {
          ...request,
          candidate: {
            ...request.candidate,
            candidateGeneration: request.candidate.candidateGeneration + 1,
          },
        },
        {
          ...request,
          stateFile: { ...request.stateFile, path: `${request.stateFile.path}-other` },
        },
      ]) {
        try {
          assertCaptureWorker(f.journal, changed);
        } catch {
          rejected += 1;
        }
      }
      try {
        f.journal.delivery.finishCaptureIO(f.authority, admitted);
      } catch {
        rejected += 1;
      }
      return start(intent, launch);
    });
    try {
      const identity = await f.capture(plan);
      expect(fault).toHaveBeenCalledOnce();
      expect(admitted?.captureIO?.pendingSnapshot).toBeNull();
      expect(rejected).toBe(4);
      const captured = f.journal.delivery.candidate(f.authority.runId, identity);
      expect(captured).toMatchObject({ status: "captured", captureIO: { pendingSnapshot: null } });
      const { captureIO: _io, ...obsolete } = captured;
      expect(CandidateRecordSchema.safeParse(obsolete).success).toBe(false);
    } finally {
      fault.mockRestore();
    }
  });

  it("atomically cancels an unbound intent after lease replacement without ever launching it", async () => {
    const f = await fixture();
    const plan = await f.define();
    const fault = vi.spyOn(lifetime, "prepareCommandLifetime").mockImplementation(async () => {
      f.newLease();
      throw new Error("Original controller lost authority before binding capture");
    });
    try {
      await expect(
        f.dispatch({
          kind: "capture_candidate",
          taskId: f.taskId,
          ...target(f.workspace),
          validationPlanId: plan,
        }),
      ).rejects.toThrow("controller lease was lost or replaced");
      const pending = f.journal.delivery.latestCandidate(f.authority.runId, f.taskId)!;
      expect(pending.captureIO).not.toBeNull();
      const operation = f.journal.agents.workspaceOperation(
        f.authority.runId,
        pending.captureIO!.workspaceOperationId,
      );
      expect(operation).toMatchObject({ execution: null, executionStop: null, stopEvidence: null });
      fault.mockRestore();
      const journal = f.reopen().orchestration;
      const settled = await reconcileCaptureIO(journal, f.authority, pending);
      expect(settled).toMatchObject({ status: "failed", snapshot: null });
      expect(
        journal.agents.workspaceOperation(f.authority.runId, operation.operationId),
      ).toMatchObject({ status: "failed", execution: null, executionStop: null });
      expect(journal.agents.activeWorkspaceOperation(f.authority.runId, pending)).toBeNull();
      expect(git(f.workspace.path, "for-each-ref", "refs/epicd/candidates/")).toBe("");
    } finally {
      fault.mockRestore();
    }
  });

  it("rolls back the workspace reservation when the candidate intent cannot be retained", async () => {
    const f = await fixture();
    const plan = await f.define();
    const db = new Database(f.path);
    const before = db.prepare("SELECT * FROM workspace_operations ORDER BY operation_id").all();
    const launches = vi.spyOn(lifetime, "startDurableCommand");
    try {
      db.exec(
        "CREATE TRIGGER deny_capture_intent BEFORE INSERT ON candidates BEGIN SELECT RAISE(ABORT, 'Candidate intent not durable'); END",
      );
      const result = await f.dispatch({
        kind: "capture_candidate",
        taskId: f.taskId,
        ...target(f.workspace),
        validationPlanId: plan,
      });
      expect(result.status).toBe("indeterminate");
      expect(launches).not.toHaveBeenCalled();
      expect(f.journal.delivery.latestCandidate(f.authority.runId, f.taskId)).toBeNull();
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, f.workspace)).toBeNull();
      expect(db.prepare("SELECT * FROM workspace_operations ORDER BY operation_id").all()).toEqual(
        before,
      );
      expect(git(f.workspace.path, "for-each-ref", "refs/epicd/candidates/")).toBe("");
    } finally {
      launches.mockRestore();
      db.close();
    }
  });
});
