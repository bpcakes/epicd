import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import Database from "better-sqlite3";
import * as lifetime from "../src/adapters/command-lifetime.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { StateStore } from "../src/adapters/store.js";
import {
  WorkspaceInspectionRequestSchema,
  assertWorkspaceInspectionWorker,
  reconcileWorkspaceInspectionIO,
} from "../src/adapters/workspace-inspection-io.js";
import {
  WorkspaceInspectionSchema,
  workspaceInspectionScope,
  workspaceInspectionView,
} from "../src/domain/workspace-inspection.js";
import type { CommandLifetime } from "../src/domain/command-lifetime.js";
import { digestJson } from "../src/domain/repository-policy.js";
import type { KernelAction } from "../src/domain/orchestration.js";
import type { WorkspaceRecord } from "../src/domain/agents.js";
import { reconcileCommit } from "../src/kernel/commits.js";
import { reconcileTrackerCommit } from "../src/kernel/tracker-commits.js";
import { journalRecordView } from "../src/adapters/journal-records.js";
import { ControlledAgentDispatcher } from "../src/adapters/agent-dispatch.js";
import { reconcileDeliveryAction } from "../src/kernel/delivery-recovery.js";
import { reconcileDiagnosticWorkspace } from "../src/kernel/diagnostic-workspaces.js";
import { reconcileActions } from "../src/kernel/reconcile.js";
import { registerInspectionCapabilities } from "../src/kernel/inspection.js";
import { registerWorkspaceDisposalCapabilities } from "../src/kernel/workspace-disposal.js";
import { fixture, git, resource, success, target, waitFor } from "./fixtures/review.js";
import { closureFixture, publishVerified } from "./fixtures/tracker-closure.js";

afterEach(() => vi.restoreAllMocks());

type Kind = "materialization" | "application_commit" | "tracker_commit";
type Prepared = {
  f: Awaited<ReturnType<typeof fixture>>;
  workspace: WorkspaceRecord;
  action: KernelAction | null;
};
async function prepared(kind: Kind): Promise<Prepared> {
  if (kind === "tracker_commit") {
    const f = await closureFixture();
    const application = await publishVerified(f);
    const exported = resource(await f.dispatch({ kind: "export_tracker" }));
    return {
      f,
      workspace: f.journal.agents.workspace(
        f.authority.runId,
        f.journal.publications.repository(f.authority.runId)!.workspace!,
      ),
      action: {
        kind: "request_tracker_commit",
        trackerOperationId: exported.resourceId,
        publicationId: application.publication.publicationId,
      },
    };
  }
  const f = await fixture();
  if (kind === "materialization")
    return {
      f,
      workspace: await f.manager.create(f.authority, f.source, f.head, "coordinator"),
      action: null,
    };
  const candidate = await f.capture(await f.define());
  expect(await f.validate(candidate, await f.copy(candidate))).toMatchObject({
    satisfiesCheck: true,
  });
  expect((await f.review(candidate)).result.status).toBe("succeeded");
  return {
    f,
    workspace: f.workspace,
    action: { kind: "request_commit", ...candidate, subject: "Inspect this exact commit" },
  };
}
function latest(s: Prepared) {
  return s.f.store.orchestration.workspaceInspections
    .forWorkspace(s.f.authority.runId, s.workspace)
    .at(-1)!;
}
function retainObservedMaterialization(
  s: Prepared,
  template: CommandLifetime,
  fingerprint: string,
) {
  const inspection = s.f.journal.workspaceInspections.reserve(
    s.f.authority,
    join(s.f.root, "managed"),
    s.workspace,
    { kind: "materialization" },
  );
  const execution: CommandLifetime = {
    ...template,
    ioId: randomUUID(),
    operationId: inspection.inspectionId,
    controllerLeaseId: s.f.authority.leaseId,
    scopeDigest: workspaceInspectionScope(inspection),
    launchDigest: digestJson(["retained-materialization-history", inspection.inspectionId]),
  };
  s.f.journal.workspaceInspections.bind(s.f.authority, inspection.inspectionId, execution);
  s.f.journal.workspaceInspections.recordResult(s.f.authority, inspection.inspectionId, {
    status: "observed",
    observation: { kind: "materialization", ready: true, fingerprint },
  });
  s.f.journal.workspaceInspections.recordStop(s.f.authority, inspection.inspectionId, {
    ioId: execution.ioId,
    bindingDigest: digestJson(execution),
    kind: "stopped",
    code: 0,
    reason: null,
    error: null,
    stoppedAt: new Date().toISOString(),
  });
  return s.f.journal.workspaceInspections.finish(s.f.authority, inspection.inspectionId);
}
async function invoke(s: Prepared) {
  return s.action
    ? s.f.dispatch(s.action)
    : s.f.manager.inspectMaterialization(s.f.authority, s.workspace);
}
async function recover(s: Prepared, manager: WorkspaceManager) {
  const journal = s.f.store.orchestration,
    target = latest(s).target;
  if (target.kind === "application_commit")
    return reconcileCommit(journal, manager, s.f.authority, target.commitId);
  if (target.kind === "tracker_commit")
    return reconcileTrackerCommit(journal, manager, s.f.authority, target.trackerCommitId);
  const settled = await manager.reconcileInspection(s.f.authority, latest(s).inspectionId);
  if (
    settled.workerResult?.status !== "observed" ||
    settled.workerResult.observation.kind !== "materialization"
  )
    throw new Error("Expected a recovered materialization observation");
  return settled.workerResult.observation.ready ? "ready" : "incomplete";
}

describe.skipIf(process.platform !== "linux")("standalone workspace inspection lifetime", () => {
  it("keeps successful reinspection available beyond 64 reads and bounds only the history preview", async () => {
    const s = await prepared("materialization"),
      { f } = s;
    registerWorkspaceDisposalCapabilities(f.kernel, f.manager);
    expect(await invoke(s)).toBe("ready");
    const first = latest(s);
    if (
      !first.execution ||
      first.workerResult?.status !== "observed" ||
      first.workerResult.observation.kind !== "materialization" ||
      !first.workerResult.observation.ready
    )
      throw new Error("Expected the real inspection to retain a ready materialization");
    const ids = [first.inspectionId];
    for (let i = 1; i < 64; i++) {
      const retained = retainObservedMaterialization(
        s,
        first.execution,
        first.workerResult.observation.fingerprint,
      );
      expect(retained.outcome).toBe("observed");
      ids.push(retained.inspectionId);
    }
    expect(await invoke(s)).toBe("ready");
    ids.push(latest(s).inspectionId);
    expect(new Set(ids).size).toBe(65);
    expect(
      f.journal.workspaceInspections.forWorkspace(f.authority.runId, s.workspace),
    ).toHaveLength(65);
    const result = success(await f.dispatch({ kind: "inspect_workspace", ...target(s.workspace) }));
    if (result.kind !== "inspection") throw new Error("Expected workspace inspection");
    const view = JSON.parse(result.text);
    expect(view.inspections.map((entry: { inspectionId: string }) => entry.inspectionId)).toEqual(
      ids.slice(-10),
    );
    expect(view.omittedInspections).toBe(55);
    expect(f.journal.workspaceInspections.get(f.authority.runId, ids[0]!).outcome).toBe("observed");
    expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toBeNull();
  }, 120000);

  it("settles a tracker commit even after 64 failed inspections in its canonical workspace", async () => {
    const s = await prepared("tracker_commit"),
      { f } = s;
    const failures = [];
    for (let i = 0; i < 64; i++) {
      const reserved = f.journal.workspaceInspections.reserve(
        f.authority,
        join(f.root, "managed"),
        s.workspace,
        { kind: "materialization" },
      );
      failures.push(f.journal.workspaceInspections.finish(f.authority, reserved.inspectionId));
    }
    expect(failures.every((record) => record.outcome === "failed")).toBe(true);
    expect(await invoke(s)).toMatchObject({ status: "succeeded" });
    const commit = f.journal.trackerCommits.records(f.authority.runId).at(-1)!;
    expect(commit).toMatchObject({
      status: "created",
      sourceIntact: true,
    });
    expect(
      await f.dispatch({
        kind: "request_publish_tracker",
        trackerCommitId: commit.trackerCommitId,
        expectedPreviousRevision: commit.parentRevision,
      }),
    ).toMatchObject({ status: "succeeded" });
    expect(() => f.journal.trackerCommits.assertIdle(f.authority.runId)).not.toThrow();
    expect(
      f.journal.workspaceInspections.forWorkspace(f.authority.runId, s.workspace).slice(0, 64),
    ).toEqual(failures);
  });

  it.each(
    (["application_commit", "tracker_commit"] as const).flatMap((kind) =>
      (["paused", "awaiting_user", "blocked"] as const).map((status) => ({ kind, status })),
    ),
  )(
    "recovers a stopped $kind with no inspection yet while $status, without resuming delivery",
    async ({ kind, status }) => {
      const s = await prepared(kind),
        { f } = s;
      const fault = vi
        .spyOn(f.journal.workspaceInspections, "reserve")
        .mockImplementationOnce(() => {
          throw new Error("Controller lost before reserving inspection");
        });
      expect(await invoke(s)).toMatchObject({ status: "indeterminate" });
      fault.mockRestore();
      const record =
        kind === "application_commit"
          ? f.journal.commits.records(f.authority.runId).at(-1)!
          : f.journal.trackerCommits.records(f.authority.runId).at(-1)!;
      expect(record.status).toBe("writing");
      expect(
        f.journal.agents.workspaceOperation(f.authority.runId, record.workspaceOperationId)
          .stopEvidence,
      ).not.toBeNull();
      expect(f.journal.workspaceInspections.forWorkspace(f.authority.runId, s.workspace)).toEqual(
        [],
      );
      const refs = git(s.workspace.path, "for-each-ref");
      f.journal.changeStatus(f.authority, status);
      const staleAuthority = f.authority;
      f.newLease();
      const journal = f.reopen().orchestration;
      const control = journal.control(f.authority.runId);
      const manager = new WorkspaceManager(journal, join(f.root, "managed"));
      const launches = vi.spyOn(lifetime, "startDurableCommand");
      const settled =
        "commitId" in record
          ? await reconcileCommit(journal, manager, f.authority, record.commitId)
          : await reconcileTrackerCommit(journal, manager, f.authority, record.trackerCommitId);
      expect(settled).toMatchObject({ status: "created", sourceIntact: true });
      expect(launches).toHaveBeenCalledOnce();
      expect(
        launches.mock.calls[0]![1].args.some((arg) =>
          arg.endsWith("workspace-inspection-io-cli.js"),
        ),
      ).toBe(true);
      expect(git(s.workspace.path, "for-each-ref")).toBe(refs);
      const currentControl = journal.control(f.authority.runId);
      expect(currentControl).toMatchObject({ status, policyDigest: control.policyDigest });
      expect(() =>
        journal.agents.beginWorkspaceOperation(
          f.authority,
          s.workspace,
          "capture",
          currentControl.controlVersion,
        ),
      ).toThrow(`Run is ${status}`);
      expect(() =>
        journal.workspaceInspections.reserve(staleAuthority, join(f.root, "managed"), s.workspace, {
          kind: "materialization",
        }),
      ).toThrow("lease was lost or replaced");
      expect(journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toBeNull();
    },
  );

  it("shows negative materialization evidence separately from a worker failure", async () => {
    const s = await prepared("materialization"),
      { f } = s;
    registerWorkspaceDisposalCapabilities(f.kernel, f.manager);
    expect(await invoke(s)).toBe("ready");
    writeFileSync(join(s.workspace.path, "app.txt"), "changed after creation\n");
    expect(await invoke(s)).toBe("incomplete");
    const negative = latest(s);
    expect(negative).toMatchObject({
      outcome: "observed",
      workerResult: { status: "observed", observation: { kind: "materialization", ready: false } },
    });
    const fault = vi.spyOn(lifetime, "startDurableCommand").mockImplementationOnce(() => {
      throw new Error("Inspection unavailable");
    });
    await expect(invoke(s)).rejects.toThrow();
    fault.mockRestore();
    const result = success(await f.dispatch({ kind: "inspect_workspace", ...target(s.workspace) }));
    if (result.kind !== "inspection") throw new Error("Expected workspace inspection");
    const view = JSON.parse(result.text);
    expect(view.inspections).toMatchObject([
      {
        outcome: "observed",
        workerResult: { status: "observed", observation: { kind: "materialization", ready: true } },
      },
      {
        outcome: "observed",
        workerResult: {
          status: "observed",
          observation: { kind: "materialization", ready: false },
        },
      },
      { outcome: "failed", workerResult: null },
    ]);
    expect(view.inspections[1].detail).toContain("incomplete");
    expect(result.text).not.toContain(negative.execution!.directory.path);
    expect(result.text).not.toContain(negative.controllerLeaseId);
    expect(view.omittedInspections).toBe(0);
  });

  it.each(
    [true, false].flatMap((previousReady) =>
      (["fresh", "historical"] as const).map((request) => ({ previousReady, request })),
    ),
  )(
    "$request request after a pending ready=$previousReady observation and changed bytes",
    async ({ previousReady, request }) => {
      const s = await prepared("materialization"),
        { f } = s;
      const path = join(s.workspace.path, "app.txt"),
        baseline = readFileSync(path);
      if (!previousReady) writeFileSync(path, "intervention before the first read\n");
      const noReceipt = vi.spyOn(lifetime, "recoverCommandStop").mockResolvedValueOnce(null);
      await expect(invoke(s)).rejects.toThrow("no independent stop receipt");
      noReceipt.mockRestore();
      const pending = latest(s);
      expect(pending.workerResult).toMatchObject({
        status: "observed",
        observation: { ready: previousReady },
      });
      if (previousReady) writeFileSync(path, "intervention after the first read\n");
      else writeFileSync(path, baseline);
      const launches = vi.spyOn(lifetime, "startDurableCommand");
      if (request === "historical") {
        const recovered = await f.manager.reconcileInspection(f.authority, pending.inspectionId);
        expect(recovered).toMatchObject({
          outcome: "observed",
          workerResult: pending.workerResult,
        });
        expect(launches).not.toHaveBeenCalled();
      }
      expect(await invoke(s)).toBe(previousReady ? "incomplete" : "ready");
      expect(launches).toHaveBeenCalledOnce();
      const history = f.journal.workspaceInspections.forWorkspace(f.authority.runId, s.workspace);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        inspectionId: pending.inspectionId,
        outcome: "observed",
        workerResult: pending.workerResult,
      });
      expect(history[1]).toMatchObject({
        outcome: "observed",
        workerResult: { status: "observed", observation: { ready: !previousReady } },
      });
      expect(history[1]!.inspectionId).not.toBe(pending.inspectionId);
      expect(readFileSync(path)).toEqual(
        previousReady ? Buffer.from("intervention after the first read\n") : baseline,
      );
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toBeNull();
    },
  );

  it("does not admit a fresh read when cancelled while recovering the prior receipt", async () => {
    const s = await prepared("materialization"),
      { f } = s;
    const noReceipt = vi.spyOn(lifetime, "recoverCommandStop").mockResolvedValueOnce(null);
    await expect(invoke(s)).rejects.toThrow("no independent stop receipt");
    noReceipt.mockRestore();
    const pending = latest(s),
      controller = new AbortController();
    const recoverStop = lifetime.recoverCommandStop;
    vi.spyOn(lifetime, "recoverCommandStop").mockImplementationOnce(async (intent) => {
      const stop = await recoverStop(intent);
      controller.abort();
      return stop;
    });
    const launches = vi.spyOn(lifetime, "startDurableCommand");
    await expect(
      f.manager.inspectMaterialization(f.authority, s.workspace, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(latest(s)).toMatchObject({
      inspectionId: pending.inspectionId,
      outcome: "observed",
      workerResult: pending.workerResult,
    });
    expect(
      f.journal.workspaceInspections.forWorkspace(f.authority.runId, s.workspace),
    ).toHaveLength(1);
    expect(launches).not.toHaveBeenCalled();
    expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toBeNull();
  });

  it.each(["before_launch", "after_observation"] as const)(
    "propagates the caller's cancellation %s after settling the original inspection",
    async (boundary) => {
      const s = await prepared("materialization"),
        { f } = s;
      const controller = new AbortController();
      const reason = new Error("Caller no longer wants this inspection");
      if (boundary === "before_launch") {
        const prepare = lifetime.prepareCommandLifetime;
        vi.spyOn(lifetime, "prepareCommandLifetime").mockImplementationOnce(async (...args) => {
          const intent = await prepare(...args);
          controller.abort(reason);
          return intent;
        });
      } else {
        const recoverStop = lifetime.recoverCommandStop;
        vi.spyOn(lifetime, "recoverCommandStop").mockImplementationOnce(async (intent) => {
          const stop = await recoverStop(intent);
          expect(latest(s).workerResult?.status).toBe("observed");
          controller.abort(reason);
          return stop;
        });
      }
      const launches = vi.spyOn(lifetime, "startDurableCommand");
      await expect(
        f.manager.inspectMaterialization(f.authority, s.workspace, controller.signal),
      ).rejects.toBe(reason);
      const settled = latest(s);
      expect(settled.outcome).toBe(boundary === "before_launch" ? "failed" : "observed");
      expect(settled.stop?.kind).toBe(boundary === "before_launch" ? "not_started" : "stopped");
      expect(launches).toHaveBeenCalledTimes(boundary === "before_launch" ? 0 : 1);
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toBeNull();
      expect(await f.manager.reconcileInspection(f.authority, settled.inspectionId)).toEqual(
        settled,
      );
      expect(
        f.journal.workspaceInspections.forWorkspace(f.authority.runId, s.workspace),
      ).toHaveLength(1);
    },
  );

  it("keeps stop uncertainty authoritative even when the caller cancels", async () => {
    const s = await prepared("materialization"),
      { f } = s;
    const controller = new AbortController();
    const recoverStop = lifetime.recoverCommandStop;
    const unavailable = vi
      .spyOn(lifetime, "recoverCommandStop")
      .mockImplementationOnce(async (intent) => {
        expect(await recoverStop(intent)).not.toBeNull();
        controller.abort();
        return null;
      });
    await expect(
      f.manager.inspectMaterialization(f.authority, s.workspace, controller.signal),
    ).rejects.toThrow("no independent stop receipt");
    unavailable.mockRestore();
    const pending = latest(s);
    expect(pending.outcome).toBeNull();
    expect(pending.stop).toBeNull();
    expect(
      f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)?.operationId,
    ).toBe(pending.workspaceOperationId);
    expect((await f.manager.reconcileInspection(f.authority, pending.inspectionId)).outcome).toBe(
      "observed",
    );
  });

  it.each(["root", "workspace"] as const)(
    "treats a missing established %s as lost custody, not an incomplete copy",
    async (missing) => {
      const s = await prepared("materialization"),
        { f } = s;
      const path = missing === "root" ? join(f.root, "managed") : s.workspace.path;
      renameSync(path, `${path}.retained`);
      try {
        await expect(invoke(s)).rejects.toMatchObject({ code: "workspace_inspection_failed" });
        expect(latest(s)).toMatchObject({
          outcome: "failed",
          workerResult: { status: "failed", detail: expect.stringContaining("ENOENT") },
          stop: { kind: "stopped", code: 1 },
        });
        expect(
          f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace),
        ).toBeNull();
      } finally {
        renameSync(`${path}.retained`, path);
      }
      const failed = latest(s);
      expect(await invoke(s)).toBe("ready");
      expect(f.journal.workspaceInspections.get(f.authority.runId, failed.inspectionId)).toEqual(
        failed,
      );
    },
  );

  it.each([false, true])(
    "bounds the complete workspace response with escape-heavy diagnostics (long path: %s)",
    async (longPath) => {
      const f = await fixture();
      const db = new Database(f.path);
      const detail = "\u0001".repeat(3990);
      const workspaceRoot = join(
        f.root,
        "managed",
        ...(longPath ? Array<string>(7).fill("\u0001".repeat(200)) : []),
      );
      const manager = new WorkspaceManager(f.journal, workspaceRoot);
      try {
        db.exec(
          `CREATE TRIGGER reject_creation_result BEFORE UPDATE OF record_json ON workspace_creations WHEN json_extract(NEW.record_json, '$.workerResult.status') = 'created' BEGIN SELECT RAISE(ABORT, '${detail}'); END`,
        );
        await expect(
          manager.create(f.authority, f.source, f.head, "coordinator"),
        ).rejects.toThrow();
        db.exec("DROP TRIGGER reject_creation_result");
        const workspace = f.journal.agents
          .workspaces(f.authority.runId)
          .find((item) => item.purpose === "coordinator")!;
        const creation = f.journal.workspaceCreations.forWorkspace(f.authority.runId, workspace)!;
        expect(creation.workerResult).toMatchObject({ status: "failed", detail });
        db.exec(
          `CREATE TRIGGER reject_inspection_result BEFORE UPDATE OF record_json ON workspace_inspections WHEN json_extract(NEW.record_json, '$.workerResult.status') = 'observed' BEGIN SELECT RAISE(ABORT, '${detail}'); END`,
        );
        for (let i = 0; i < 10; i++)
          await expect(manager.inspectMaterialization(f.authority, workspace)).rejects.toThrow();
        db.exec("DROP TRIGGER reject_inspection_result");
        // Recovery may establish readiness while preserving the original failed creation.
        expect(await manager.inspectMaterialization(f.authority, workspace)).toBe("ready");
        registerWorkspaceDisposalCapabilities(f.kernel, f.manager);
        const result = success(
          await f.dispatch({ kind: "inspect_workspace", ...target(workspace) }),
        );
        if (result.kind !== "inspection") throw new Error("Expected workspace inspection");
        expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(64_000);
        const view = JSON.parse(result.text);
        expect(view.workspace.workspaceId).toBe(workspace.workspaceId);
        expect(view.creation.outcome).toBe("failed");
        expect(view.inspections.length + view.omittedInspections).toBe(11);
        expect(view.omittedInspections).toBeGreaterThan(1);
        if (longPath) {
          expect(view.inspections).toHaveLength(1);
          expect(view.creation.detailsTruncated).toBe(true);
          expect(view.creation.detail.length).toBeLessThan(detail.length);
        } else {
          expect(view.inspections.at(-1)).toMatchObject({
            outcome: "observed",
            workerResult: { observation: { ready: true } },
          });
          expect(view.creation.detailsTruncated).toBe(false);
        }
        expect(f.journal.workspaceCreations.get(f.authority.runId, creation.creationId)).toEqual(
          creation,
        );
        expect(
          f.journal.workspaceInspections
            .forWorkspace(f.authority.runId, workspace)
            .slice(0, 10)
            .every((item) => item.detail === detail),
        ).toBe(true);
        expect(view.inspections.at(-1)).toMatchObject({
          inspectionId: f.journal.workspaceInspections
            .forWorkspace(f.authority.runId, workspace)
            .at(-1)!.inspectionId,
        });
      } finally {
        db.close();
      }
    },
  );

  it("retains and redacts an oversized failure from the real inspection worker", async () => {
    const s = await prepared("materialization"),
      { f } = s;
    const db = new Database(f.path);
    const message =
      "Inspection storage rejected: token=private-test-value " + "detail ".repeat(900);
    try {
      db.exec(
        `CREATE TRIGGER reject_inspection_observation BEFORE UPDATE OF record_json ON workspace_inspections WHEN json_extract(NEW.record_json, '$.workerResult.status') = 'observed' BEGIN SELECT RAISE(ABORT, '${message}'); END`,
      );
      await expect(invoke(s)).rejects.toThrow("Inspection storage rejected");
      const failed = latest(s);
      expect(failed).toMatchObject({
        outcome: "failed",
        workerResult: { status: "failed", detail: expect.stringContaining("token=[REDACTED]") },
        stop: { kind: "stopped", code: 1 },
      });
      expect(failed.detail!.length).toBeLessThanOrEqual(4000);
      expect(failed.detail).toContain("detail");
      expect(failed.detail).not.toContain("private-test-value");
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toBeNull();
      const view = journalRecordView(f.journal, f.authority.runId, {
        recordKind: "workspace_inspection",
        recordId: failed.inspectionId,
      });
      expect(view.text).toContain("Inspection storage rejected");
      expect(view.text).not.toContain("private-test-value");
      db.exec("DROP TRIGGER reject_inspection_observation");
      expect(await invoke(s)).toBe("ready");
      expect(f.journal.workspaceInspections.get(f.authority.runId, failed.inspectionId)).toEqual(
        failed,
      );
    } finally {
      db.close();
    }
  });

  it.each(["git", "permission", "custody"] as const)(
    "retains a %s failure as failed inspection without negative materialization evidence",
    async (failure) => {
      const s = await prepared("materialization"),
        { f } = s;
      const path = join(s.workspace.path, failure === "git" ? ".git/index" : "app.txt");
      const bytes = readFileSync(path);
      if (failure === "git") writeFileSync(path, "invalid index");
      else if (failure === "permission") chmodSync(path, 0);
      else {
        renameSync(s.workspace.path, `${s.workspace.path}.retained`);
        symlinkSync(`${s.workspace.path}.retained`, s.workspace.path);
      }
      try {
        await expect(invoke(s)).rejects.toMatchObject({ code: "workspace_inspection_failed" });
        expect(latest(s)).toMatchObject({
          outcome: "failed",
          workerResult: {
            status: "failed",
            detail: expect.stringMatching(
              failure === "git"
                ? /Kernel Git failed.*index/
                : failure === "permission"
                  ? /EACCES/
                  : /Managed workspace path changed/,
            ),
          },
          stop: { kind: "stopped", code: 1 },
        });
        expect(
          f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace),
        ).toBeNull();
      } finally {
        if (failure === "git") writeFileSync(path, bytes);
        else if (failure === "permission") chmodSync(path, 0o644);
        else {
          rmSync(s.workspace.path);
          renameSync(`${s.workspace.path}.retained`, s.workspace.path);
        }
      }
      const failed = latest(s);
      expect(await invoke(s)).toBe("ready");
      expect(f.journal.workspaceInspections.get(f.authority.runId, failed.inspectionId)).toEqual(
        failed,
      );
    },
  );

  it.each(["missing", "mode", "unexpected", "config"] as const)(
    "retains an established %s mismatch as negative materialization evidence",
    async (mismatch) => {
      const s = await prepared("materialization");
      if (mismatch === "missing") rmSync(join(s.workspace.path, "app.txt"));
      if (mismatch === "mode") chmodSync(join(s.workspace.path, "app.txt"), 0o755);
      if (mismatch === "unexpected") writeFileSync(join(s.workspace.path, "extra.txt"), "extra");
      if (mismatch === "config")
        writeFileSync(join(s.workspace.path, ".git/config"), "[core]\n bare = true\n");
      expect(await invoke(s)).toBe("incomplete");
      expect(latest(s)).toMatchObject({
        outcome: "observed",
        workerResult: {
          status: "observed",
          observation: { kind: "materialization", ready: false },
        },
        stop: { kind: "stopped", code: 0 },
      });
    },
  );

  it("preserves a pending inspection when another caller requests a different target", async () => {
    const s = await prepared("application_commit"),
      { f } = s;
    expect(await invoke(s)).toMatchObject({ status: "succeeded" });
    const commit = f.journal.commits.records(f.authority.runId).at(-1)!;
    const pending = f.journal.workspaceInspections.reserve(
      f.authority,
      join(f.root, "managed"),
      s.workspace,
      { kind: "application_commit", commitId: commit.commitId },
    );
    const launches = vi.spyOn(lifetime, "startDurableCommand");
    await expect(f.manager.inspectMaterialization(f.authority, s.workspace)).rejects.toMatchObject({
      code: "workspace_inspection_conflict",
    });
    expect(f.journal.workspaceInspections.pending(f.authority.runId, s.workspace)).toEqual(pending);
    expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toMatchObject(
      {
        operationId: pending.workspaceOperationId,
        stopEvidence: null,
      },
    );
    expect(launches).not.toHaveBeenCalled();
    // Only settlement of the original reservation releases its custody.
    registerInspectionCapabilities(f.kernel, f.manager);
    expect(
      await f.dispatch({ kind: "reconcile_workspace_inspection", inspectionId: randomUUID() }),
    ).toMatchObject({ status: "rejected", code: "unknown_workspace_inspection" });
    expect(f.journal.workspaceInspections.pending(f.authority.runId, s.workspace)).toEqual(pending);
    const recovered = success(
      await f.dispatch({
        kind: "reconcile_workspace_inspection",
        inspectionId: pending.inspectionId,
      }),
    );
    if (recovered.kind !== "inspection") throw new Error("Expected inspection result");
    expect(JSON.parse(recovered.text)).toMatchObject({
      inspectionId: pending.inspectionId,
      outcome: "failed",
      workerResult: null,
    });
    const cancelled = f.journal.workspaceInspections.get(f.authority.runId, pending.inspectionId);
    expect(f.journal.workspaceInspections.unsettled(f.authority.runId)).toEqual([]);
    await expect(
      f.manager.reconcileCandidateCommitInspection(f.authority, commit),
    ).rejects.toMatchObject({ code: "workspace_inspection_failed" });
    expect(launches).not.toHaveBeenCalled();
    expect(f.journal.workspaceInspections.get(f.authority.runId, pending.inspectionId)).toEqual(
      cancelled,
    );
    expect(
      await f.manager.reconcileCandidateCommitInspection(f.authority, commit, undefined, "request"),
    ).toMatchObject({
      created: true,
      sourceIntact: true,
    });
    expect(launches).toHaveBeenCalledOnce();
    expect(f.journal.workspaceInspections.get(f.authority.runId, pending.inspectionId)).toEqual(
      cancelled,
    );
  });

  it("recovers an interrupted explicit reconciliation action using only the original receipt", async () => {
    const s = await prepared("materialization"),
      { f } = s;
    const acknowledgement = vi
      .spyOn(f.journal.workspaceInspections, "recordStop")
      .mockImplementation(() => {
        throw new Error("Lost inspection acknowledgement");
      });
    await expect(invoke(s)).rejects.toThrow("Lost inspection acknowledgement");
    acknowledgement.mockRestore();
    const pending = latest(s);
    expect(await lifetime.readCommandStop(pending.execution!)).toMatchObject({
      kind: "stopped",
      code: 0,
    });
    registerInspectionCapabilities(f.kernel, f.manager);
    const unavailable = vi.spyOn(lifetime, "recoverCommandStop").mockResolvedValueOnce(null);
    const launches = vi.spyOn(lifetime, "startDurableCommand");
    const action = await f.dispatch({
      kind: "reconcile_workspace_inspection",
      inspectionId: pending.inspectionId,
    });
    expect(action.status).toBe("indeterminate");
    expect(latest(s)).toEqual(pending);
    unavailable.mockRestore();
    f.newLease();
    await reconcileActions(f.journal, f.authority, async (record) => {
      const result = await reconcileDeliveryAction(
        f.journal,
        f.manager,
        new ControlledAgentDispatcher(f.journal),
        f.authority,
        record,
      );
      if (!result) throw new Error("Missing inspection action recovery");
      return result;
    });
    expect(f.journal.action(f.authority.runId, action.actionId)?.status).toBe("succeeded");
    expect(latest(s)).toMatchObject({ outcome: "observed", workerResult: pending.workerResult });
    expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toBeNull();
    expect(launches).not.toHaveBeenCalled();
  });

  it.each(["missing", "foreign"] as const)(
    "settles an interrupted reconciliation of a %s inspection without dispatching a read",
    async (kind) => {
      const s = await prepared("materialization"),
        { f } = s;
      let inspectionId: string = randomUUID();
      if (kind === "foreign") {
        const source = join(f.root, "foreign-source");
        git(f.root, "clone", "--quiet", f.source, source);
        const otherRun = f.store.create(
          {
            ...f.store.get(f.authority.runId)!,
            runId: randomUUID(),
            repoPath: source,
            runtimeConfiguration: {
              ...f.store.get(f.authority.runId)!.runtimeConfiguration!,
              commonDirectory: {
                path: join(source, ".git"),
                device: String(statSync(join(source, ".git")).dev),
                inode: String(statSync(join(source, ".git")).ino),
              },
            },
          },
          f.journal.policy(f.authority.runId),
        );
        const lease = f.store.acquireLease(otherRun.runId);
        const authority = {
          runId: otherRun.runId,
          ownerToken: lease.ownerToken,
          leaseId: lease.leaseId,
        };
        const workspace = await f.manager.create(authority, source, f.head, "coordinator");
        const inspection = f.journal.workspaceInspections.reserve(
          authority,
          f.manager.storageRoot(),
          workspace,
          { kind: "materialization" },
        );
        f.journal.workspaceInspections.finish(authority, inspection.inspectionId);
        inspectionId = inspection.inspectionId;
        f.store.releaseLease(otherRun.runId, lease.ownerToken);
      }
      const accepted = f.journal.acceptAction(
        f.authority,
        f.decision({ kind: "reconcile_workspace_inspection", inspectionId }),
      );
      if (accepted.kind !== "accepted") throw new Error("Expected an accepted action");
      // The controller died after durable admission, before the live handler validated the ID.
      f.journal.startAction(f.authority, accepted.action.actionId);
      f.newLease();
      const launches = vi.spyOn(lifetime, "startDurableCommand");
      const recoverActions = () =>
        reconcileActions(f.journal, f.authority, async (record) => {
          const result = await reconcileDeliveryAction(
            f.journal,
            f.manager,
            new ControlledAgentDispatcher(f.journal),
            f.authority,
            record,
          );
          if (!result) throw new Error("Missing inspection action recovery");
          return result;
        });
      await recoverActions();
      expect(f.journal.action(f.authority.runId, accepted.action.actionId)?.status).toBe("failed");
      const observations = f.journal.latestObservationCursor(f.authority.runId);
      await recoverActions();
      expect(f.journal.latestObservationCursor(f.authority.runId)).toBe(observations);
      expect(launches).not.toHaveBeenCalled();
      expect(f.journal.workspaceInspections.records(f.authority.runId)).toEqual([]);
    },
  );

  it.each(
    (["application_commit", "tracker_commit"] as const).flatMap((kind) =>
      [false, true].map((drain) => ({ kind, drain })),
    ),
  )(
    "retains a failed $kind inspection across recovery (startup drain: $drain)",
    async ({ kind, drain }) => {
      const s = await prepared(kind),
        { f } = s;
      const start = lifetime.startDurableCommand;
      const dispatchFault = vi
        .spyOn(lifetime, "startDurableCommand")
        .mockImplementation((intent, launch) => {
          if (launch.args.some((arg) => arg.endsWith("workspace-inspection-io-cli.js")))
            throw new Error("Inspection dispatch failed");
          return start(intent, launch);
        });
      const settlementFault = vi
        .spyOn(f.journal.workspaceInspections, "finish")
        .mockImplementationOnce(() => {
          throw new Error("Controller crashed before inspection settlement");
        });
      const parent = await invoke(s);
      expect(parent).toMatchObject({ status: "indeterminate" });
      dispatchFault.mockRestore();
      settlementFault.mockRestore();
      const pending = latest(s);
      expect(pending.workerResult).toBeNull();
      f.newLease();
      const manager = new WorkspaceManager(f.journal, f.manager.storageRoot());
      const launches = vi.spyOn(lifetime, "startDurableCommand");
      if (drain)
        for (const inspection of f.journal.workspaceInspections.unsettled(f.authority.runId))
          await manager.reconcileInspection(f.authority, inspection.inspectionId);
      await expect(recover(s, manager)).rejects.toThrow("without a retained observation");
      const failed = latest(s);
      expect(failed).toMatchObject({ inspectionId: pending.inspectionId, outcome: "failed" });
      // Repeated cold recovery sees the same failed attempt even after its exclusion was released.
      f.newLease();
      await expect(recover(s, manager)).rejects.toThrow("without a retained observation");
      expect(f.journal.workspaceInspections.forWorkspace(f.authority.runId, s.workspace)).toEqual([
        failed,
      ]);
      expect(launches).not.toHaveBeenCalled();
      const commitment =
        kind === "application_commit"
          ? f.journal.commits.records(f.authority.runId).at(-1)!
          : f.journal.trackerCommits.records(f.authority.runId).at(-1)!;
      expect(commitment.status).toBe("writing");
      // A distinct, explicit model request may inspect again, without repeating the writer.
      if (typeof parent === "string") throw new Error("Expected a commit action");
      const retried = await f.dispatch(
        kind === "application_commit"
          ? { kind: "reconcile_action", actionId: parent.actionId }
          : {
              kind: "reconcile_tracker_commit",
              trackerCommitId: "trackerCommitId" in commitment ? commitment.trackerCommitId : "",
            },
      );
      expect(retried.status).toBe("succeeded");
      expect(launches).toHaveBeenCalledOnce();
      expect(
        launches.mock.calls[0]![1].args.some((arg) =>
          arg.endsWith("workspace-inspection-io-cli.js"),
        ),
      ).toBe(true);
      expect(latest(s).outcome).toBe("observed");
      expect(f.journal.workspaceInspections.get(f.authority.runId, failed.inspectionId)).toEqual(
        failed,
      );
      expect(f.journal.action(f.authority.runId, parent.actionId)?.status).toBe("succeeded");
    },
  );

  it("cannot report a ready copy when its standalone inspection worker never dispatched", async () => {
    const f = await fixture();
    const workspace = await f.manager.create(f.authority, f.source, f.head, "coordinator");
    const start = lifetime.startDurableCommand;
    const fault = vi.spyOn(lifetime, "startDurableCommand").mockImplementation((intent, launch) => {
      if (launch.args.some((arg) => arg.endsWith("workspace-inspection-io-cli.js")))
        throw new Error("Lost standalone inspection dispatch");
      return start(intent, launch);
    });
    await expect(f.manager.inspectMaterialization(f.authority, workspace)).rejects.toThrow();
    expect(fault).toHaveBeenCalledOnce();
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(f.head);
    expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
  });

  it.each(["before_launch", "stopped"] as const)(
    "settles a %s inspection before reporting a diagnostic-write failure",
    async (phase) => {
      const s = await prepared("materialization"),
        { f } = s;
      const db = new Database(f.path);
      try {
        db.exec(`CREATE TRIGGER reject_inspection_diagnostic BEFORE INSERT ON observations
          WHEN json_extract(NEW.observation_json,'$.kind') IN ('workspace.inspection_worker_error', 'workspace.inspection_worker_stopped')
          BEGIN SELECT RAISE(ABORT, 'Diagnostic append failed'); END`);
        if (phase === "before_launch")
          vi.spyOn(lifetime, "startDurableCommand").mockImplementationOnce(() => {
            throw new Error("Inspection launch failed");
          });
        else
          db.exec(`CREATE TRIGGER reject_inspection_observation BEFORE UPDATE ON workspace_inspections
            WHEN json_extract(NEW.record_json,'$.workerResult') IS NOT NULL
            BEGIN SELECT RAISE(ABORT, 'Observation was not retained'); END`);
        await expect(invoke(s)).rejects.toThrow("Diagnostic append failed");
        const inspection = latest(s);
        expect(inspection).toMatchObject({
          outcome: "failed",
          workerResult: null,
          stop: { kind: phase === "before_launch" ? "not_started" : "stopped" },
        });
        expect(
          f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace),
        ).toBeNull();
        expect(await f.manager.reconcileInspection(f.authority, inspection.inspectionId)).toEqual(
          inspection,
        );
      } finally {
        db.close();
      }
    },
  );

  it("retains UTF-8 worker diagnostics when stderr arrives one byte at a time", async () => {
    const s = await prepared("materialization"),
      { f } = s;
    const db = new Database(f.path);
    const message = "Cannot inspect žluťoučký-日本語-🧪";
    try {
      db.exec(`CREATE TRIGGER reject_inspection_observation BEFORE UPDATE ON workspace_inspections
        WHEN json_extract(NEW.record_json,'$.workerResult.status') = 'observed'
        BEGIN SELECT RAISE(ABORT, 'Cannot inspect žluťoučký-日本語-🧪'); END`);
      const start = lifetime.startDurableCommand;
      vi.spyOn(lifetime, "startDurableCommand").mockImplementationOnce((intent, launch) => {
        const handle = start(intent, launch);
        // Preserve the real worker and receipt, but deterministically split every UTF-8 sequence.
        handle.child.stderr = handle.child.stderr!.pipe(
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              for (let i = 0; i < chunk.length; i++) this.push(chunk.subarray(i, i + 1));
              callback();
            },
          }),
        );
        return handle;
      });
      const cursor = f.journal.latestObservationCursor(f.authority.runId);
      await expect(invoke(s)).rejects.toThrow(message);
      const diagnostics = f.journal
        .observations(f.authority.runId, cursor)
        .filter((observation) => observation.kind === "workspace.inspection_worker_stopped");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.summary).toBe(`Inspection worker stopped: exit 1. ${message}\n`);
      expect(latest(s)).toMatchObject({ outcome: "failed", stop: { kind: "stopped", code: 1 } });
    } finally {
      db.close();
    }
  });

  it("preserves unproven stop when both recovery and diagnostic reporting fail", async () => {
    const s = await prepared("materialization"),
      { f } = s;
    const db = new Database(f.path);
    try {
      db.exec(`CREATE TRIGGER reject_inspection_diagnostic BEFORE INSERT ON observations
        WHEN json_extract(NEW.observation_json,'$.kind') = 'workspace.inspection_worker_error'
        BEGIN SELECT RAISE(ABORT, 'Diagnostic append failed'); END`);
      vi.spyOn(lifetime, "startDurableCommand").mockImplementationOnce(() => {
        throw new Error("Inspection launch failed");
      });
      vi.spyOn(lifetime, "recoverCommandStop").mockResolvedValueOnce(null);
      await expect(invoke(s)).rejects.toThrow("no independent stop receipt");
      const pending = latest(s);
      expect(pending).toMatchObject({ outcome: null, stop: null });
      expect(
        f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)?.operationId,
      ).toBe(pending.workspaceOperationId);
      expect((await f.manager.reconcileInspection(f.authority, pending.inspectionId)).outcome).toBe(
        "failed",
      );
    } finally {
      db.close();
    }
  });

  it("runs supervised inspections with non-ASCII state and workspace paths", async () => {
    const f = await fixture();
    const root = join(f.root, "žluťoučký-日本語-🧪");
    mkdirSync(root);
    const store = new StateStore(join(root, "stav.sqlite3"));
    try {
      const state = store.create(
        { ...f.store.get(f.authority.runId)!, runId: randomUUID() },
        f.journal.policy(f.authority.runId),
      );
      const lease = store.acquireLease(state.runId);
      const authority = {
        runId: state.runId,
        ownerToken: lease.ownerToken,
        leaseId: lease.leaseId,
      };
      const manager = new WorkspaceManager(store.orchestration, join(root, "pracovní"));
      const workspace = await manager.create(authority, f.source, f.head, "coordinator");
      expect(await manager.inspectMaterialization(authority, workspace)).toBe("ready");
      const inspection = store.orchestration.workspaceInspections.forWorkspace(
        state.runId,
        workspace,
      )[0]!;
      expect(inspection).toMatchObject({ outcome: "observed", stop: { kind: "stopped", code: 0 } });
      expect(inspection.workspaceRoot).toBe(manager.storageRoot());
      expect(
        store.orchestration.agents.activeWorkspaceOperation(state.runId, workspace),
      ).toBeNull();
    } finally {
      store.close();
    }
  });

  it("settles an expired worker deadline as failed without negative evidence or an automatic retry", async () => {
    const s = await prepared("materialization"),
      { f } = s;
    const db = new Database(f.path);
    try {
      // Keep the actual fixed worker busy until its supervisor kills the namespace.
      db.exec(`CREATE TRIGGER stall_inspection_observation BEFORE UPDATE ON workspace_inspections
        WHEN json_extract(NEW.record_json,'$.workerResult.status') = 'observed'
        BEGIN SELECT sum(value) FROM (
          WITH RECURSIVE work(value) AS (VALUES(0) UNION ALL SELECT value+1 FROM work WHERE value<1000000000)
          SELECT value FROM work
        ); END`);
      const prepare = lifetime.prepareCommandLifetime;
      vi.spyOn(lifetime, "prepareCommandLifetime").mockImplementationOnce((scope, launch) => {
        expect(scope.timeoutMs).toBe(120_000);
        return prepare({ ...scope, timeoutMs: 1_000 }, launch);
      });
      const launches = vi.spyOn(lifetime, "startDurableCommand");
      await expect(invoke(s)).rejects.toThrow("without a retained observation");
      const failed = latest(s);
      expect(failed).toMatchObject({
        outcome: "failed",
        workerResult: null,
        stop: { kind: "stopped", reason: "timed_out" },
      });
      expect(await lifetime.readCommandStop(failed.execution!)).toEqual(failed.stop);
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toBeNull();
      expect(await f.manager.reconcileInspection(f.authority, failed.inspectionId)).toEqual(failed);
      expect(launches).toHaveBeenCalledOnce();
      expect(f.journal.workspaceInspections.forWorkspace(f.authority.runId, s.workspace)).toEqual([
        failed,
      ]);
      expect(readFileSync(join(s.workspace.path, "app.txt"), "utf8")).toBe("red\n");
    } finally {
      db.close();
    }
  });

  it.each(
    (["materialization", "application_commit", "tracker_commit"] as const).flatMap((kind) =>
      (["before_ack", "after_ack"] as const).map((crashPoint) => ({ kind, crashPoint })),
    ),
  )(
    "recovers original $kind observations after caller SIGKILL $crashPoint without another inspection or writer",
    async ({ kind, crashPoint }) => {
      const s = await prepared(kind),
        { f } = s;
      f.preserveArtifacts();
      process.stdout.write(`Retained ${kind} inspection caller crash (${crashPoint}): ${f.root}\n`);
      writeFileSync(join(f.source, "app.txt"), "user staged bytes\n");
      git(f.source, "add", "app.txt");
      const index = readFileSync(join(f.source, ".git/index"));
      writeFileSync(join(f.source, "app.txt"), "user unstaged bytes\n");
      const child = spawn(
        process.execPath,
        [resolve("test/fixtures/workspace-inspection-caller.mjs")],
        {
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        },
      );
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
          authority: f.authority,
          workspaceRoot: join(f.root, "managed"),
          workspace: s.workspace,
          decision: s.action ? f.decision(s.action) : null,
          crashPoint,
        }),
      );
      try {
        expect(await closed, diagnostics).toEqual([null, "SIGKILL"]);
        const pending = latest(s);
        expect(pending).toMatchObject({ outcome: null, workerResult: { status: "observed" } });
        const receipt = await lifetime.readCommandStop(pending.execution!);
        expect(receipt).toMatchObject({ kind: "stopped", code: 0, reason: null, error: null });
        expect(pending.stop).toEqual(crashPoint === "after_ack" ? receipt : null);
        expect(
          f.journal.agents.workspaceOperation(f.authority.runId, pending.workspaceOperationId)
            .stopEvidence,
        ).toBeNull();
        if (pending.target.kind === "application_commit")
          expect(f.journal.commits.record(f.authority.runId, pending.target.commitId).status).toBe(
            "writing",
          );
        if (pending.target.kind === "tracker_commit")
          expect(
            f.journal.trackerCommits.record(f.authority.runId, pending.target.trackerCommitId)
              .status,
          ).toBe("writing");
        const refs = git(s.workspace.path, "for-each-ref");
        const revision =
          pending.target.kind === "application_commit"
            ? f.journal.commits.record(f.authority.runId, pending.target.commitId).revision
            : pending.target.kind === "tracker_commit"
              ? f.journal.trackerCommits.record(f.authority.runId, pending.target.trackerCommitId)
                  .revision
              : null;
        const object = revision ? git(s.workspace.path, "cat-file", "commit", revision) : null;
        const sourceBytes = readFileSync(join(s.workspace.path, "app.txt"));
        f.newLease();
        const journal = f.reopen().orchestration;
        journal.markInterruptedActions(f.authority);
        const manager = new WorkspaceManager(journal, join(f.root, "managed"));
        const launches = vi.spyOn(lifetime, "startDurableCommand");
        const result = await recover(s, manager);
        if (kind === "materialization") expect(result).toBe("ready");
        else expect(result).toMatchObject({ status: "created", sourceIntact: true });
        const settled = latest(s);
        expect(settled).toMatchObject({
          outcome: "observed",
          workerResult: pending.workerResult,
          stop: receipt,
        });
        expect(
          await reconcileWorkspaceInspectionIO(journal, f.authority, pending.inspectionId),
        ).toEqual(settled);
        expect(launches).not.toHaveBeenCalled();
        expect(journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toBeNull();
        if (settled.target.kind === "application_commit")
          expect(
            journal.reviews.approval(
              f.authority.runId,
              journal.commits.record(f.authority.runId, settled.target.commitId),
              "exact_revision",
            ),
          ).toBeNull();
        expect(git(s.workspace.path, "for-each-ref")).toBe(refs);
        if (revision) expect(git(s.workspace.path, "cat-file", "commit", revision)).toBe(object);
        expect(readFileSync(join(s.workspace.path, "app.txt"))).toEqual(sourceBytes);
        expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
        expect(readFileSync(join(f.source, ".git/index"))).toEqual(index);
        expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("user unstaged bytes\n");
        const history = journalRecordView(journal, f.authority.runId, {
          recordKind: "workspace_inspection",
          recordId: settled.inspectionId,
        });
        expect(history.settled).toBe(true);
        expect(history.text).toContain('"workerResult"');
        expect(history.text).not.toContain(pending.execution!.directory.path);
        expect(history.text).not.toContain(pending.controllerLeaseId);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
    },
    60000,
  );

  it("recovers caller SIGKILL while the fixed inspection worker is live without replaying the read", async () => {
    const s = await prepared("materialization"),
      { f } = s;
    const bytes = readFileSync(join(s.workspace.path, "app.txt"));
    const child = spawn(
      process.execPath,
      [resolve("test/fixtures/workspace-inspection-caller.mjs")],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    const closed = once(child, "close");
    void closed.catch(() => {});
    let output = "",
      diagnostics = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + String(chunk)).slice(-4000);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(
      JSON.stringify({
        stateFile: f.store.storageIdentity(),
        authority: f.authority,
        workspaceRoot: join(f.root, "managed"),
        workspace: s.workspace,
        decision: null,
        crashPoint: "during_worker",
      }),
    );
    try {
      expect(await closed, diagnostics).toEqual([null, "SIGKILL"]);
      const boundary = JSON.parse(output) as {
        worker: number;
        start: string;
        inspectionId: string;
      };
      const pending = latest(s);
      expect(pending).toMatchObject({
        inspectionId: boundary.inspectionId,
        outcome: null,
        workerResult: null,
        stop: null,
      });
      expect(
        f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)?.operationId,
      ).toBe(pending.workspaceOperationId);
      await waitFor(() => {
        try {
          const stat = readFileSync(`/proc/${boundary.worker}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          return fields[0] === "Z" || fields[19] !== boundary.start;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
          throw error;
        }
      });
      // Process disappearance alone is not the recovery oracle: require the original receipt.
      const deadline = Date.now() + 15000;
      let receipt = await lifetime.readCommandStop(pending.execution!);
      while (!receipt && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 20));
        receipt = await lifetime.readCommandStop(pending.execution!);
      }
      expect(receipt).toMatchObject({ kind: "stopped" });
      // Killing the caller during request transfer may reset the worker input pipe
      // before the guardian processes cancellation. Both retain real stop proof.
      if (receipt?.reason !== "cancelled") expect(receipt?.error).toMatch(/ECONNRESET|EPIPE/);
      f.newLease();
      const journal = f.reopen().orchestration;
      const manager = new WorkspaceManager(journal, join(f.root, "managed"));
      const launches = vi.spyOn(lifetime, "startDurableCommand");
      const settled = await manager.reconcileInspection(f.authority, pending.inspectionId);
      expect(settled).toMatchObject({ outcome: "failed", workerResult: null, stop: receipt });
      expect(journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toBeNull();
      expect(await manager.reconcileInspection(f.authority, pending.inspectionId)).toEqual(settled);
      expect(launches).not.toHaveBeenCalled();
      expect(readFileSync(join(s.workspace.path, "app.txt"))).toEqual(bytes);
      expect(await manager.inspectMaterialization(f.authority, s.workspace)).toBe("ready");
      expect(journal.workspaceInspections.get(f.authority.runId, pending.inspectionId)).toEqual(
        settled,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  });

  it.each(["materialization", "application_commit", "tracker_commit"] as const)(
    "keeps $kind excluded when its real observations survive but its stop receipt is unavailable",
    async (kind) => {
      const s = await prepared(kind),
        { f } = s;
      const readStop = lifetime.recoverCommandStop;
      const fault = vi
        .spyOn(lifetime, "recoverCommandStop")
        .mockImplementation((intent) =>
          f.journal.workspaceInspections
            .records(f.authority.runId)
            .some((record) => record.inspectionId === intent.operationId)
            ? Promise.resolve(null)
            : readStop(intent),
        );
      try {
        if (s.action) expect(await invoke(s)).toMatchObject({ status: "indeterminate" });
        else await expect(invoke(s)).rejects.toThrow("no independent stop receipt");
        const pending = latest(s);
        expect(pending).toMatchObject({
          outcome: null,
          stop: null,
          workerResult: { status: "observed" },
        });
        expect(await lifetime.readCommandStop(pending.execution!)).toMatchObject({
          kind: "stopped",
          code: 0,
        });
        expect(() =>
          f.journal.agents.finishWorkspaceOperation(
            f.authority,
            pending.workspaceOperationId,
            "succeeded",
            "Observation exists",
          ),
        ).toThrow("complete inspection worker has not stopped");
        await expect(recover(s, f.manager)).rejects.toThrow("no independent stop receipt");
        await expect(
          f.manager.reconcileInspection(f.authority, pending.inspectionId),
        ).rejects.toThrow("no independent stop receipt");
        expect(latest(s)).toEqual(pending);
        fault.mockRestore();
        f.newLease();
        const journal = f.reopen().orchestration;
        const result = await recover(s, new WorkspaceManager(journal, join(f.root, "managed")));
        if (kind === "materialization") expect(result).toBe("ready");
        else expect(result).toMatchObject({ status: "created", sourceIntact: true });
        expect(journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toBeNull();
      } finally {
        fault.mockRestore();
      }
    },
    60000,
  );

  it("requires a new read after confirmed stop without observations, preserving the first failed attempt", async () => {
    const s = await prepared("materialization"),
      { f } = s;
    const db = new Database(f.path);
    try {
      db.exec(
        "CREATE TRIGGER deny_inspection_result BEFORE UPDATE ON workspace_inspections WHEN json_extract(NEW.record_json,'$.workerResult') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Inspection observation not durable'); END",
      );
      await expect(invoke(s)).rejects.toThrow("without a retained observation");
      const failed = latest(s);
      expect(failed).toMatchObject({
        outcome: "failed",
        workerResult: null,
        stop: { kind: "stopped", code: 1 },
      });
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toBeNull();
      expect(WorkspaceInspectionSchema.safeParse({ ...failed, outcome: "observed" }).success).toBe(
        false,
      );
      db.exec("DROP TRIGGER deny_inspection_result");
      expect(await invoke(s)).toBe("ready");
      expect(f.journal.workspaceInspections.get(f.authority.runId, failed.inspectionId)).toEqual(
        failed,
      );
      expect(latest(s).inspectionId).not.toBe(failed.inspectionId);
      expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
    } finally {
      db.close();
    }
  });

  it("does not expose readiness separately from a reserved copy's retained inspection result", async () => {
    const f = await fixture();
    const db = new Database(f.path),
      operationId = randomUUID();
    try {
      db.exec(
        "CREATE TRIGGER deny_copy_completion BEFORE UPDATE ON workspace_creations WHEN json_extract(NEW.record_json,'$.workerResult.status') = 'created' BEGIN SELECT RAISE(ABORT, 'Copy completion not durable'); END",
      );
      await expect(
        f.manager.create(f.authority, f.source, f.head, "coordinator", undefined, operationId),
      ).rejects.toThrow();
      db.exec("DROP TRIGGER deny_copy_completion");
      const workspace = f.journal.agents.workspaceForOperation(f.authority.runId, operationId)!;
      expect(workspace).toMatchObject({
        status: "reserved",
        directory: null,
        baselineFingerprint: null,
      });
      const creation = f.journal.workspaceCreations.forWorkspace(f.authority.runId, workspace)!;
      expect(creation.outcome).toBe("failed");
      db.exec(
        "CREATE TRIGGER deny_readiness_result BEFORE UPDATE ON workspace_inspections WHEN json_extract(NEW.record_json,'$.workerResult.status') = 'observed' BEGIN SELECT RAISE(ABORT, 'Readiness observation not durable'); END",
      );
      await expect(f.manager.inspectMaterialization(f.authority, workspace)).rejects.toThrow(
        "Readiness observation not durable",
      );
      expect(f.journal.agents.workspace(f.authority.runId, workspace)).toEqual(workspace);
      const inspection = f.journal.workspaceInspections
        .forWorkspace(f.authority.runId, workspace)
        .at(-1)!;
      expect(inspection).toMatchObject({
        outcome: "failed",
        workerResult: { status: "failed" },
        stop: { kind: "stopped", code: 1 },
      });
      expect(readFileSync(join(workspace.path, "app.txt"), "utf8")).toBe("red\n");
      db.exec("DROP TRIGGER deny_readiness_result");
      expect(await f.manager.inspectMaterialization(f.authority, workspace)).toBe("ready");
      expect(
        f.journal.agents.workspace(f.authority.runId, workspace).baselineFingerprint,
      ).not.toBeNull();
      expect(f.journal.workspaceCreations.forWorkspace(f.authority.runId, workspace)).toEqual(
        creation,
      );
      expect(
        f.journal.workspaceInspections.get(f.authority.runId, inspection.inspectionId),
      ).toEqual(inspection);
    } finally {
      db.close();
    }
  });

  it("does not fence a live inspection and binds the exact request before any source reads", async () => {
    const s = await prepared("materialization"),
      { f } = s;
    expect(await invoke(s)).toBe("ready");
    const observed = latest(s);
    const unbound = f.journal.workspaceInspections.reserve(
      f.authority,
      f.manager.storageRoot(),
      s.workspace,
      { kind: "materialization" },
    );
    const failed = f.journal.workspaceInspections.finish(f.authority, unbound.inspectionId);
    const prepare = lifetime.prepareCommandLifetime;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const preparation = vi
      .spyOn(lifetime, "prepareCommandLifetime")
      .mockImplementation(async (...args) => {
        const intent = await prepare(...args);
        entered = true;
        await gate;
        return intent;
      });
    const start = lifetime.startDurableCommand;
    const dispatch = vi
      .spyOn(lifetime, "startDurableCommand")
      .mockImplementation((intent, launch) => {
        const request = WorkspaceInspectionRequestSchema.parse(JSON.parse(launch.extraInput!));
        expect(assertWorkspaceInspectionWorker(f.journal, request).inspectionId).toBe(
          latest(s).inspectionId,
        );
        expect(() =>
          assertWorkspaceInspectionWorker(f.journal, {
            ...request,
            stateFile: { ...request.stateFile, inode: "0" },
          }),
        ).toThrow("exact admitted request");
        const record = latest(s);
        expect(
          WorkspaceInspectionSchema.safeParse({ ...record, targetDigest: "0".repeat(64) }).success,
        ).toBe(false);
        return start(intent, launch);
      });
    const running = invoke(s);
    void running.catch(() => {});
    try {
      await waitFor(() => entered);
      const pending = latest(s);
      expect(pending.execution).toBeNull();
      registerInspectionCapabilities(f.kernel, f.manager);
      const operation = f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace);
      for (const historical of [observed, failed]) {
        expect(await f.manager.reconcileInspection(f.authority, historical.inspectionId)).toEqual(
          historical,
        );
        const result = success(
          await f.dispatch({
            kind: "reconcile_workspace_inspection",
            inspectionId: historical.inspectionId,
          }),
        );
        if (result.kind !== "inspection") throw new Error("Expected workspace inspection");
        expect(JSON.parse(result.text)).toMatchObject({
          inspectionId: historical.inspectionId,
          outcome: historical.outcome,
          stopConfirmed: true,
        });
        expect(
          f.journal.workspaceInspections.get(f.authority.runId, historical.inspectionId),
        ).toEqual(historical);
      }
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toEqual(
        operation,
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(
        await f.dispatch({
          kind: "reconcile_workspace_inspection",
          inspectionId: pending.inspectionId,
        }),
      ).toMatchObject({ status: "rejected", code: "workspace_inspection_live" });
      await expect(invoke(s)).rejects.toThrow("live workspace inspection");
      await expect(
        f.manager.reconcileInspection(f.authority, pending.inspectionId),
      ).rejects.toThrow("live workspace inspection");
      expect(latest(s)).toEqual(pending);
      // Pausing between admission and binding must not revoke a recovery read's custody.
      f.journal.changeStatus(f.authority, "paused");
      release();
      expect(await running).toBe("ready");
      expect(f.journal.control(f.authority.runId).status).toBe("paused");
      expect(dispatch).toHaveBeenCalledOnce();
      expect(JSON.stringify(workspaceInspectionView(latest(s)))).not.toContain(".command-io");
    } finally {
      release();
      await running;
      preparation.mockRestore();
      dispatch.mockRestore();
    }
  });

  it("rolls back inspection settlement, source release and commit confirmation together when auditing fails", async () => {
    const s = await prepared("application_commit"),
      { f } = s;
    const db = new Database(f.path);
    try {
      db.exec(
        "CREATE TRIGGER deny_inspection_settlement BEFORE INSERT ON observations WHEN json_extract(NEW.observation_json,'$.kind') = 'workspace.inspection_settled' BEGIN SELECT RAISE(ABORT, 'Inspection settlement not durable'); END",
      );
      expect(await invoke(s)).toMatchObject({ status: "indeterminate" });
      const pending = latest(s);
      expect(pending).toMatchObject({
        outcome: null,
        stop: { kind: "stopped", code: 0 },
        workerResult: { status: "observed" },
      });
      if (pending.target.kind !== "application_commit") throw new Error("Wrong target");
      expect(f.journal.commits.record(f.authority.runId, pending.target.commitId).status).toBe(
        "writing",
      );
      expect(
        f.journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)?.operationId,
      ).toBe(pending.workspaceOperationId);
      db.exec("DROP TRIGGER deny_inspection_settlement");
      f.newLease();
      const journal = f.reopen().orchestration;
      const launches = vi.spyOn(lifetime, "startDurableCommand");
      expect(
        await recover(s, new WorkspaceManager(journal, join(f.root, "managed"))),
      ).toMatchObject({ status: "created", sourceIntact: true });
      expect(launches).not.toHaveBeenCalled();
      expect(journal.agents.activeWorkspaceOperation(f.authority.runId, s.workspace)).toBeNull();
      const raw = db
        .prepare("SELECT * FROM workspace_inspections WHERE run_id=?")
        .all(f.authority.runId);
      f.store.releaseLease(f.authority.runId, f.authority.ownerToken);
      db.prepare(
        "UPDATE runs SET state_json=json_set(state_json, '$.createdAt', 'invalid') WHERE run_id=?",
      ).run(f.authority.runId);
      f.store.quarantineInvalidRun(f.authority.runId);
      const retained = db
        .prepare(
          "SELECT row_json FROM quarantined_orchestration WHERE run_id=? AND source_table='workspace_inspections'",
        )
        .all(f.authority.runId) as { row_json: string }[];
      expect(retained.map((row) => JSON.parse(row.row_json))).toEqual(raw);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(readFileSync(join(s.workspace.path, "app.txt"), "utf8")).toBe("green\n");
    } finally {
      db.close();
    }
  });

  it("atomically cancels an unbound inspection and rejects late binding and fixed-worker execution", async () => {
    const s = await prepared("materialization"),
      { f } = s;
    const prepare = lifetime.prepareCommandLifetime;
    let launch: lifetime.CommandLaunch | undefined;
    vi.spyOn(lifetime, "prepareCommandLifetime").mockImplementation(async (scope, command) => {
      launch = command;
      return prepare(scope, command);
    });
    const bind = vi.spyOn(f.journal.workspaceInspections, "bind").mockImplementation(() => {
      throw new Error("Lost before binding");
    });
    await expect(invoke(s)).rejects.toThrow("without a retained observation");
    expect(bind).toHaveBeenCalledOnce();
    const args = bind.mock.calls[0]!;
    bind.mockRestore();
    const failed = latest(s);
    expect(failed).toMatchObject({
      outcome: "failed",
      execution: null,
      stop: null,
      workerResult: null,
    });
    expect(() => f.journal.workspaceInspections.bind(...args)).toThrow("live admitted target");
    const delayed = lifetime.startDurableCommand(args[2], launch!);
    delayed.child.stdout!.resume();
    delayed.child.stderr!.resume();
    expect((await delayed.result).receipt).toMatchObject({ kind: "stopped", code: 1 });
    expect(latest(s)).toEqual(failed);
    expect(await invoke(s)).toBe("ready");
    expect(f.journal.workspaceInspections.get(f.authority.runId, failed.inspectionId)).toEqual(
      failed,
    );
    expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
  });

  it.each(
    (["delivery", "diagnostic"] as const).flatMap((kind) => [
      { kind, status: "active" as const, pendingInspection: true, changed: false },
      { kind, status: "active" as const, pendingInspection: true, changed: true },
      ...(["paused", "awaiting_user", "blocked"] as const).map((status) => ({
        kind,
        status,
        pendingInspection: false,
        changed: false,
      })),
    ]),
  )(
    "checks current $kind copy bytes while $status (pending: $pendingInspection; changed: $changed)",
    async ({ kind, status, pendingInspection, changed }) => {
      const f = await fixture();
      const create = f.manager.create.bind(f.manager);
      const fault = vi.spyOn(f.manager, "create").mockImplementationOnce(async (...args) => {
        await create(...args);
        throw new Error("Lost stopped copy acknowledgement");
      });
      const action: KernelAction =
        kind === "delivery"
          ? { kind: "create_implementation_workspace", baseCommitId: null }
          : { kind: "create_diagnostic_workspace", candidate: null, revision: null };
      const lost = await f.dispatch(action);
      fault.mockRestore();
      expect(lost.status).toBe("indeterminate");
      const parent = f.journal.action(f.authority.runId, lost.actionId)!;
      const workspace = f.journal.agents.workspaceForOperation(
        f.authority.runId,
        parent.operationId,
      )!;
      if (pendingInspection) {
        const noReceipt = vi.spyOn(lifetime, "recoverCommandStop").mockResolvedValue(null);
        try {
          await expect(f.manager.inspectMaterialization(f.authority, workspace)).rejects.toThrow(
            "no independent stop receipt",
          );
        } finally {
          noReceipt.mockRestore();
        }
      }
      const pending = f.journal.workspaceInspections.pending(f.authority.runId, workspace);
      if (pendingInspection)
        expect(pending?.workerResult).toMatchObject({
          status: "observed",
          observation: { ready: true },
        });
      else expect(pending).toBeNull();
      if (changed)
        writeFileSync(join(workspace.path, "app.txt"), "intervention after observation\n");
      f.journal.changeStatus(f.authority, status);
      f.newLease();
      const journal = f.reopen().orchestration;
      const control = journal.control(f.authority.runId);
      const manager = new WorkspaceManager(journal, join(f.root, "managed"));
      const dispatcher = new ControlledAgentDispatcher(journal);
      const launches = vi.spyOn(lifetime, "startDurableCommand");
      const copies = vi.spyOn(manager, "create");
      await reconcileActions(journal, f.authority, async (record) =>
        kind === "diagnostic"
          ? reconcileDiagnosticWorkspace(journal, manager, f.authority, record)
          : ((await reconcileDeliveryAction(journal, manager, dispatcher, f.authority, record)) ?? {
              status: "unresolved",
              detail: "No matching recovery",
            }),
      );
      expect(journal.action(f.authority.runId, parent.actionId)?.status).toBe(
        changed ? "indeterminate" : "succeeded",
      );
      const inspections = journal.workspaceInspections.forWorkspace(f.authority.runId, workspace);
      expect(inspections).toHaveLength(pending ? 2 : 1);
      expect(inspections.every((record) => record.outcome === "observed")).toBe(true);
      expect(inspections.at(-1)!.workerResult).toMatchObject({
        status: "observed",
        observation: { ready: !changed },
      });
      if (pending)
        expect(inspections[0]).toMatchObject({
          inspectionId: pending.inspectionId,
          workerResult: pending.workerResult,
        });
      expect(journal.agents.activeWorkspaceOperation(f.authority.runId, workspace)).toBeNull();
      expect(launches).toHaveBeenCalledOnce();
      expect(
        launches.mock.calls[0]![1].args.some((arg) =>
          arg.endsWith("workspace-inspection-io-cli.js"),
        ),
      ).toBe(true);
      expect(copies).not.toHaveBeenCalled();
      expect(journal.control(f.authority.runId)).toMatchObject({
        status,
        policyDigest: control.policyDigest,
      });
      expect(readFileSync(join(workspace.path, "app.txt"), "utf8")).toBe(
        changed ? "intervention after observation\n" : "red\n",
      );
    },
  );
});
