import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import * as lifetime from "../src/adapters/command-lifetime.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { reconcileCommit } from "../src/kernel/commits.js";
import { ControlledSdkRuntime } from "../src/adapters/controlled-sdk.js";
import { reconcileDeliveryAction } from "../src/kernel/delivery-recovery.js";
import { reconcileActions } from "../src/kernel/reconcile.js";
import { fixture, git, success, waitFor } from "./fixtures/review.js";

afterEach(() => vi.restoreAllMocks());

async function prepared() {
  const f = await fixture();
  const plan = await f.define();
  const candidate = await f.capture(plan);
  expect(await f.validate(candidate, await f.copy(candidate))).toMatchObject({
    outcome: "succeeded",
    satisfiesCheck: true,
  });
  expect((await f.review(candidate)).result.status).toBe("succeeded");
  return { f, plan, candidate };
}

describe.skipIf(process.platform !== "linux")("unbound application commit recovery", () => {
  it("cancels a never-bound application writer after controller replacement without inspecting or changing source bytes", async () => {
    const { f, candidate } = await prepared();
    writeFileSync(join(f.source, "app.txt"), "user staged bytes\n");
    git(f.source, "add", "app.txt");
    const index = readFileSync(join(f.source, ".git/index"));
    writeFileSync(join(f.source, "app.txt"), "user unstaged bytes\n");
    const fault = vi
      .spyOn(f.manager, "writeCandidateCommit")
      .mockRejectedValueOnce(new Error("Lost controller after reservation, before worker setup"));
    const lost = await f.dispatch({
      kind: "request_commit",
      ...candidate,
      subject: "Never launched",
    });
    fault.mockRestore();
    expect(lost.status).toBe("indeterminate");
    const pending = f.journal.commits.records(f.authority.runId)[0]!;
    expect(pending).toMatchObject({ status: "preparing", revision: null, sourceIntact: false });
    expect(
      f.journal.agents.workspaceOperation(f.authority.runId, pending.workspaceOperationId),
    ).toMatchObject({ execution: null, executionStop: null, stopEvidence: null });
    // A later source edit is not evidence about whether a kernel worker was ever bound.
    writeFileSync(join(f.workspace.path, "app.txt"), "later managed source bytes\n");
    f.newLease();
    const journal = f.reopen().orchestration;
    journal.markInterruptedActions(f.authority);
    const manager = new WorkspaceManager(journal, join(f.root, "managed"));
    const inspections = vi.spyOn(manager, "inspectCandidateCommit");
    const launches = vi.spyOn(lifetime, "startDurableCommand");
    const settled = await reconcileCommit(journal, manager, f.authority, pending.commitId);
    expect(settled).toMatchObject({ status: "failed", revision: null, sourceIntact: false });
    expect(settled.failure).toContain("never bound");
    expect(await reconcileCommit(journal, manager, f.authority, pending.commitId)).toEqual(settled);
    expect(inspections).not.toHaveBeenCalled();
    expect(launches).not.toHaveBeenCalled();
    expect(journal.agents.activeWorkspaceOperation(f.authority.runId, pending)).toBeNull();
    expect(
      journal.agents.workspaceOperation(f.authority.runId, pending.workspaceOperationId),
    ).toMatchObject({ status: "failed", execution: null, executionStop: null });
    expect(journal.reviews.approval(f.authority.runId, candidate, "exact_revision")).toBeNull();
    expect(git(f.workspace.path, "for-each-ref", "refs/epicd/commits/")).toBe("");
    expect(readFileSync(join(f.workspace.path, "app.txt"), "utf8")).toBe(
      "later managed source bytes\n",
    );
    expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
    expect(readFileSync(join(f.source, ".git/index"))).toEqual(index);
    expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("user unstaged bytes\n");
  });

  it("cold-recovers a real caller SIGKILL before worker binding without replay or successful parent acknowledgement", async () => {
    const { f, candidate } = await prepared();
    f.preserveArtifacts();
    process.stdout.write(`Retained unbound commit caller crash fixture: ${f.root}\n`);
    const decision = f.decision({
      kind: "request_commit",
      ...candidate,
      subject: "Killed before binding",
    });
    const child = spawn(process.execPath, [resolve("test/fixtures/commit-kernel-caller.mjs")], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const closed = once(child, "close");
    void closed.catch(() => {});
    let diagnostics = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + String(chunk)).slice(-4000);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(
      JSON.stringify({
        stateFile: f.store.storageIdentity(),
        workspaceRoot: join(f.root, "managed"),
        authority: f.authority,
        decision,
        crashPoint: "before_bind",
      }),
    );
    try {
      expect(await closed, diagnostics).toEqual([null, "SIGKILL"]);
      const pending = f.journal.commits.records(f.authority.runId)[0]!;
      const parent = f.journal
        .actions(f.authority.runId)
        .find((a) => a.operationId === pending.operationId)!;
      expect(parent.status).toBe("running");
      expect(
        f.journal.agents.workspaceOperation(f.authority.runId, pending.workspaceOperationId),
      ).toMatchObject({ execution: null, executionStop: null, stopEvidence: null });
      f.newLease();
      const journal = f.reopen().orchestration;
      const manager = new WorkspaceManager(journal, join(f.root, "managed"));
      const driver = new ControlledSdkRuntime(journal, {
        root: join(f.root, "runtime"),
        executable: join(f.root, "bin/codex"),
        authCachePath: null,
        turnTimeoutMs: 30000,
      });
      const launches = vi.spyOn(lifetime, "startDurableCommand");
      const inspections = vi.spyOn(manager, "inspectCandidateCommit");
      await reconcileActions(
        journal,
        f.authority,
        async (action) =>
          (await reconcileDeliveryAction(journal, manager, driver, f.authority, action)) ?? {
            status: "unresolved",
            detail: "No matching recovery",
          },
      );
      const settled = journal.commits.record(f.authority.runId, pending.commitId);
      expect(settled).toMatchObject({ status: "failed", revision: null, sourceIntact: false });
      expect(journal.action(f.authority.runId, parent.actionId)?.status).toBe("failed");
      expect(journal.agents.activeWorkspaceOperation(f.authority.runId, pending)).toBeNull();
      expect(journal.reviews.approval(f.authority.runId, candidate, "exact_revision")).toBeNull();
      expect(launches).not.toHaveBeenCalled();
      expect(inspections).not.toHaveBeenCalled();
      expect(git(f.workspace.path, "for-each-ref", "refs/epicd/commits/")).toBe("");
      expect(readFileSync(join(f.workspace.path, "app.txt"), "utf8")).toBe("green\n");
      expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  });

  it("rejects delayed binding and execution after atomically cancelling an unbound writer under its original lease", async () => {
    const { f, candidate } = await prepared();
    const prepare = lifetime.prepareCommandLifetime;
    let launch: lifetime.CommandLaunch | undefined;
    vi.spyOn(lifetime, "prepareCommandLifetime").mockImplementation(async (scope, command) => {
      launch = command;
      return prepare(scope, command);
    });
    const bind = vi.spyOn(f.journal.agents, "bindWorkspaceExecution").mockImplementation(() => {
      throw new Error("Lost before binding the prepared lifetime");
    });
    const lost = await f.dispatch({
      kind: "request_commit",
      ...candidate,
      subject: "Cancel unused reservation",
    });
    expect(lost.status).toBe("indeterminate");
    expect(bind).toHaveBeenCalledOnce();
    const args = bind.mock.calls[0]!;
    bind.mockRestore();
    const record = f.journal.commits.records(f.authority.runId)[0]!;
    expect(record).toMatchObject({ status: "failed", revision: null, sourceIntact: false });
    const stopped = f.journal.agents.workspaceOperation(
      f.authority.runId,
      record.workspaceOperationId,
    );
    expect(stopped).toMatchObject({ status: "failed", execution: null, executionStop: null });
    expect(() => f.journal.agents.bindWorkspaceExecution(...args)).toThrow("original unused");
    // Even a stale caller bypassing the rejected bind cannot pass the fixed worker's own admission.
    const delayed = lifetime.startDurableCommand(args[2], launch!);
    delayed.child.stdout!.resume();
    delayed.child.stderr!.resume();
    expect((await delayed.result).receipt).toMatchObject({ kind: "stopped", code: 1 });
    expect(f.journal.commits.record(f.authority.runId, record.commitId)).toEqual(record);
    expect(
      f.journal.agents.workspaceOperation(f.authority.runId, record.workspaceOperationId),
    ).toEqual(stopped);
    expect(git(f.workspace.path, "for-each-ref", "refs/epicd/commits/")).toBe("");
    expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
  });

  it("rejects model reconciliation while a healthy unbound writer is still preparing its lifetime", async () => {
    const { f, candidate } = await prepared();
    const prepare = lifetime.prepareCommandLifetime;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const fault = vi
      .spyOn(lifetime, "prepareCommandLifetime")
      .mockImplementation(async (...args) => {
        const intent = await prepare(...args);
        entered = true;
        await gate;
        return intent;
      });
    const running = await f.kernel.execute(
      f.decision({ kind: "request_commit", ...candidate, subject: "Still preparing" }),
      f.authority,
    );
    if (running.status !== "running") throw new Error("Expected live commit operation");
    const completion = f.kernel.operation(running.operationId)!;
    void completion.catch(() => {});
    try {
      await waitFor(() => entered);
      const before = f.journal.commits.records(f.authority.runId)[0]!;
      expect(
        f.journal.agents.workspaceOperation(f.authority.runId, before.workspaceOperationId)
          .execution,
      ).toBeNull();
      expect(
        await f.dispatch({ kind: "reconcile_action", actionId: running.actionId }),
      ).toMatchObject({ status: "rejected", code: "recovery_action_live" });
      expect(f.journal.commits.record(f.authority.runId, before.commitId)).toEqual(before);
      release();
      expect((await completion).status).toBe("succeeded");
      expect(f.journal.commits.record(f.authority.runId, before.commitId)).toMatchObject({
        status: "created",
        sourceIntact: true,
      });
    } finally {
      release();
      await completion;
      fault.mockRestore();
    }
  });

  it("rolls back both cancellation records when the audit transaction fails, then recovers without source I/O", async () => {
    const { f, candidate } = await prepared();
    const fault = vi
      .spyOn(f.manager, "writeCandidateCommit")
      .mockRejectedValueOnce(new Error("Before setup"));
    expect(
      (await f.dispatch({ kind: "request_commit", ...candidate, subject: "Atomic cancellation" }))
        .status,
    ).toBe("indeterminate");
    fault.mockRestore();
    const originalAuthority = f.authority;
    const record = f.journal.commits.records(f.authority.runId)[0]!;
    const operation = f.journal.agents.workspaceOperation(
      f.authority.runId,
      record.workspaceOperationId,
    );
    f.newLease();
    const db = new Database(f.path);
    try {
      expect(() => f.journal.commits.cancelUnbound(originalAuthority, record.commitId)).toThrow(
        "lease was lost or replaced",
      );
      db.exec(
        "CREATE TRIGGER deny_commit_cancel BEFORE INSERT ON observations WHEN json_extract(NEW.observation_json,'$.kind') = 'commit.failed' BEGIN SELECT RAISE(ABORT, 'Cancellation audit not durable'); END",
      );
      const version = f.journal.control(f.authority.runId).controlVersion;
      const cursor = f.journal.latestObservationCursor(f.authority.runId);
      await expect(
        reconcileCommit(f.journal, f.manager, f.authority, record.commitId),
      ).rejects.toThrow("Cancellation audit not durable");
      expect(f.journal.commits.record(f.authority.runId, record.commitId)).toEqual(record);
      expect(f.journal.agents.workspaceOperation(f.authority.runId, operation.operationId)).toEqual(
        operation,
      );
      expect(f.journal.control(f.authority.runId).controlVersion).toBe(version);
      expect(f.journal.latestObservationCursor(f.authority.runId)).toBe(cursor);
      db.exec("DROP TRIGGER deny_commit_cancel");
      const inspections = vi.spyOn(f.manager, "inspectCandidateCommit");
      expect(
        await reconcileCommit(f.journal, f.manager, f.authority, record.commitId),
      ).toMatchObject({ status: "failed", revision: null });
      expect(inspections).not.toHaveBeenCalled();
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, record)).toBeNull();
      expect(git(f.workspace.path, "for-each-ref", "refs/epicd/commits/")).toBe("");
    } finally {
      db.close();
    }
  });

  it("settles the failed model action and requires a fresh reviewed candidate before a new commit", async () => {
    const { f, candidate, plan } = await prepared();
    const fault = vi
      .spyOn(lifetime, "prepareCommandLifetime")
      .mockRejectedValueOnce(new Error("Worker setup failed"));
    const decision = f.decision({ kind: "request_commit", ...candidate, subject: "Failed setup" });
    const running = await f.kernel.execute(decision, f.authority);
    if (running.status !== "running") throw new Error("Expected commit operation");
    expect((await f.kernel.operation(running.operationId)!).status).toBe("indeterminate");
    fault.mockRestore();
    const failed = f.journal.commits.records(f.authority.runId)[0]!;
    const recovered = success(
      await f.dispatch({ kind: "reconcile_action", actionId: running.actionId }),
    );
    if (recovered.kind !== "inspection") throw new Error("Expected recovery result");
    expect(JSON.parse(recovered.text)).toMatchObject({ status: "failed", result: null });
    expect((await f.kernel.execute(decision, f.authority)).status).toBe("failed");
    expect(
      await f.dispatch({ kind: "request_commit", ...candidate, subject: "Do not repeat" }),
    ).toMatchObject({ status: "rejected", code: "commit_exists" });
    const next = await f.capture(plan);
    expect(await f.validate(next, await f.copy(next))).toMatchObject({ satisfiesCheck: true });
    expect((await f.review(next)).result.status).toBe("succeeded");
    expect(
      (await f.dispatch({ kind: "request_commit", ...next, subject: "Fresh admitted candidate" }))
        .status,
    ).toBe("succeeded");
    const records = f.journal.commits.records(f.authority.runId);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(failed);
    expect(records[1]).toMatchObject({
      status: "created",
      sourceIntact: true,
      parentRevision: f.head,
    });
    expect(
      git(f.workspace.path, "for-each-ref", "--format=%(objectname)", "refs/epicd/commits/"),
    ).toBe(records[1]!.revision);
    expect(f.journal.reviews.approval(f.authority.runId, next, "exact_revision")).toBeNull();
    expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
  });

  it("refuses a never-bound claim when the exact ownership or write intent no longer matches", async () => {
    const { f, candidate } = await prepared();
    const fault = vi
      .spyOn(f.manager, "writeCandidateCommit")
      .mockRejectedValueOnce(new Error("Before setup"));
    expect(
      (await f.dispatch({ kind: "request_commit", ...candidate, subject: "Exact ownership" }))
        .status,
    ).toBe("indeterminate");
    fault.mockRestore();
    const record = f.journal.commits.records(f.authority.runId)[0]!;
    const operation = f.journal.agents.workspaceOperation(
      f.authority.runId,
      record.workspaceOperationId,
    );
    // Synthetic metadata variants test journal rejection; they are not process evidence.
    for (const changed of [
      { ...operation, kind: "capture" as const },
      { ...operation, workspaceId: "different-workspace" },
      { ...operation, workspaceGeneration: operation.workspaceGeneration + 1 },
      { ...operation, controllerLeaseId: "different-controller" },
    ]) {
      const read = vi.spyOn(f.journal.agents, "workspaceOperation").mockReturnValue(changed);
      expect(() => f.journal.commits.cancelUnbound(f.authority, record.commitId)).toThrow(
        "exact never-bound",
      );
      read.mockRestore();
      expect(f.journal.commits.record(f.authority.runId, record.commitId)).toEqual(record);
      expect(f.journal.agents.workspaceOperation(f.authority.runId, operation.operationId)).toEqual(
        operation,
      );
    }
    // An unexpected admitted revision is ambiguous even though no worker binding exists.
    const writing = { ...record, status: "writing" as const, revision: f.head };
    const read = vi.spyOn(f.journal.commits, "record").mockReturnValue(writing);
    expect(() => f.journal.commits.cancelUnbound(f.authority, record.commitId)).toThrow(
      "exact never-bound",
    );
    read.mockRestore();
    expect(f.journal.commits.record(f.authority.runId, record.commitId)).toEqual(record);
    expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, record)).toEqual(operation);
    expect(git(f.workspace.path, "for-each-ref", "refs/epicd/commits/")).toBe("");
  });
});
