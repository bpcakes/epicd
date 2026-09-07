import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { reconcileDiagnosticWorkspace } from "../src/kernel/diagnostic-workspaces.js";
import { reconcileActions } from "../src/kernel/reconcile.js";
import type { ActionResult, KernelAction } from "../src/domain/orchestration.js";
import { fixture, git, resource, target } from "./fixtures/review.js";

const baseline = { kind: "create_diagnostic_workspace", candidate: null, revision: null } as const;
const report = {
  status: "completed",
  summary: "Scripted diagnostic experiment, not a review verdict",
  changedFiles: ["app.txt"],
  tests: [],
  blockers: [],
};

describe.runIf(process.platform === "linux")("isolated specialist workspaces", () => {
  it("copies the frozen baseline during a writer turn, excluding concurrent user changes; replay reuses the resource", async () => {
    const f = await fixture();
    writeFileSync(join(f.source, "app.txt"), "user-owned uncommitted work\n");
    const writer = f.journal.agents.prepareTurn(
      f.authority,
      f.writer,
      "writer-operation",
      "Implement",
      { type: "object" },
      f.journal.control(f.authority.runId).controlVersion,
    );
    try {
      const request = f.decision(baseline);
      const initial = await f.kernel.execute(request, f.authority);
      const result =
        initial.status === "running" ? await f.kernel.operation(initial.operationId)! : initial;
      const created = resource(result);
      const ws = f.journal.agents.workspace(f.authority.runId, {
        workspaceId: created.resourceId,
        workspaceGeneration: created.generation,
      });
      expect(ws).toMatchObject({
        purpose: "diagnostic",
        sourceMode: "mutable",
        baselineRevision: f.head,
        status: "ready",
      });
      expect(readFileSync(join(ws.path, "app.txt"), "utf8")).toBe("red\n");
      expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("user-owned uncommitted work\n");
      expect(readFileSync(join(f.workspace.path, "app.txt"), "utf8")).toBe("green\n");
      expect(await f.kernel.execute(request, f.authority)).toEqual(result);
      expect(
        f.journal.agents.workspaceForOperation(
          f.authority.runId,
          f.journal.actions(f.authority.runId).at(-1)!.operationId,
        ),
      ).toEqual(ws);
    } finally {
      f.journal.agents.cancelPreparedTurn(f.authority, writer.identity);
    }
  });

  it.each(["sha1", "sha256"] as const)(
    "runs a real confined SDK specialist on a %s candidate copy without promoting its edits",
    async (format) => {
      const f = await fixture(undefined, format);
      const plan = await f.define();
      const candidate = await f.capture(plan);
      const original = f.journal.delivery.candidate(f.authority.runId, candidate).snapshot!;
      const created = resource(
        await f.dispatch({ kind: "create_diagnostic_workspace", candidate, revision: null }),
      );
      const ws = f.journal.agents.workspace(f.authority.runId, {
        workspaceId: created.resourceId,
        workspaceGeneration: created.generation,
      });
      expect(ws.baselineFingerprint).toBe(original.fingerprint);
      expect(git(ws.path, "rev-parse", "HEAD")).toBe(original.snapshotRevision);
      f.response(report, ["printf 'experiment\\n' > app.txt"]);
      const specialist = resource(
        await f.dispatch({
          kind: "start_specialist",
          specialty: "Failure diagnosis",
          settingsRole: "implementation",
          taskId: f.taskId,
          ...target(ws),
          instructions: "Try an isolated experiment; report only what you observed",
        }),
      );
      const agent = f.journal.agents.instance(f.authority.runId, {
        agentId: specialist.resourceId,
        agentGeneration: specialist.generation,
      });
      expect(f.journal.agents.assignment(f.authority.runId, agent.assignmentId)).toMatchObject({
        purpose: "specialist",
        candidateId: null,
      });
      expect(f.journal.agents.turns(f.authority.runId).at(-1)).toMatchObject({
        status: "completed",
        result: report,
        stopEvidence: expect.any(String),
      });
      expect(readFileSync(join(ws.path, "app.txt"), "utf8")).toBe("experiment\n");
      expect(readFileSync(join(f.workspace.path, "app.txt"), "utf8")).toBe("green\n");
      expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("red\n");
      expect(f.journal.delivery.candidateCurrent(f.authority.runId, candidate)).toBe(true);
      for (const action of [
        { kind: "capture_candidate", taskId: f.taskId, ...target(ws), validationPlanId: plan },
        {
          kind: "run_validation",
          ...candidate,
          ...target(ws),
          validationPlanId: plan,
          checkId: "app-check",
        },
        {
          kind: "run_review",
          ...candidate,
          ...target(ws),
          agent: null,
          instructions: "Approve the experiment",
        },
        { kind: "request_commit", ...candidate, subject: "Diagnostic success is not approval" },
      ] satisfies KernelAction[])
        expect((await f.dispatch(action)).status).toBe("rejected");
      expect(f.journal.reviews.records(f.authority.runId)).toEqual([]);
      expect(f.journal.delivery.preCommitEvidence(f.authority.runId, candidate).evidence).toEqual(
        [],
      );
    },
  );

  it("accepts only a kernel-recorded exact commit for an explicit candidate revision", async () => {
    const f = await fixture();
    const candidate = await f.capture(await f.define());
    await f.validate(candidate, await f.copy(candidate));
    expect((await f.review(candidate)).result.status).toBe("succeeded");
    const commit = resource(
      await f.dispatch({ kind: "request_commit", ...candidate, subject: "Green behavior" }),
    );
    const revision = f.journal.commits.record(f.authority.runId, commit.resourceId).revision!;
    const created = resource(
      await f.dispatch({ kind: "create_diagnostic_workspace", candidate, revision }),
    );
    const ws = f.journal.agents.workspace(f.authority.runId, {
      workspaceId: created.resourceId,
      workspaceGeneration: created.generation,
    });
    expect(ws.baselineRevision).toBe(revision);
    expect(git(ws.path, "rev-parse", "HEAD")).toBe(revision);
    for (const action of [
      { ...baseline, revision },
      { ...baseline, candidate, revision: f.head },
      { ...baseline, candidate: { ...candidate, candidateGeneration: 99 } },
    ])
      expect((await f.dispatch(action)).status).toBe("rejected");
  });

  it("does not copy a candidate while its source turn is unsettled", async () => {
    const f = await fixture();
    const candidate = await f.capture(await f.define());
    const turn = f.journal.agents.prepareTurn(
      f.authority,
      f.writer,
      "writer-operation",
      "Change source",
      { type: "object" },
      f.journal.control(f.authority.runId).controlVersion,
    );
    try {
      expect(await f.dispatch({ ...baseline, candidate })).toMatchObject({
        status: "rejected",
        code: "workspace_busy",
      });
    } finally {
      f.journal.agents.cancelPreparedTurn(f.authority, turn.identity);
    }
  });

  it.each(["intact", "dirty", "uncertain_io"] as const)(
    "cold recovery preserves a lost acknowledgement's %s copy without materializing again",
    async (variant) => {
      const f = await fixture();
      const create = f.manager.create.bind(f.manager);
      const spy = vi.spyOn(f.manager, "create").mockImplementationOnce(async (...args) => {
        await create(...args);
        throw new Error("Simulated lost creation acknowledgement after stopped I/O");
      });
      let result: ActionResult;
      try {
        result = await f.dispatch(baseline);
      } finally {
        spy.mockRestore();
      }
      expect(result.status).toBe("indeterminate");
      const action = f.journal.actions(f.authority.runId).at(-1)!;
      const ws = f.journal.agents.workspaceForOperation(f.authority.runId, action.operationId)!;
      expect(ws.status).toBe("ready");
      if (variant === "dirty") writeFileSync(join(ws.path, "app.txt"), "preserve experiment\n");
      const operation =
        variant === "uncertain_io"
          ? f.journal.agents.beginWorkspaceOperation(
              f.authority,
              ws,
              "capture",
              f.journal.control(f.authority.runId).controlVersion,
            )
          : null;
      f.reopen();
      f.newLease();
      const journal = f.store.orchestration;
      const manager = new WorkspaceManager(journal, join(f.root, "managed"));
      const createAgain = vi.spyOn(manager, "create");
      try {
        await reconcileActions(journal, f.authority, (record) =>
          reconcileDiagnosticWorkspace(journal, manager, f.authority, record),
        );
        expect(journal.action(f.authority.runId, action.actionId)?.status).toBe(
          variant === "intact" ? "succeeded" : "indeterminate",
        );
        expect(createAgain).not.toHaveBeenCalled();
        expect(
          journal.agents.workspaceForOperation(f.authority.runId, action.operationId)?.workspaceId,
        ).toBe(ws.workspaceId);
        expect(readFileSync(join(ws.path, "app.txt"), "utf8")).toBe(
          variant === "dirty" ? "preserve experiment\n" : "red\n",
        );
        if (operation)
          expect(journal.agents.activeWorkspaceOperation(f.authority.runId, ws)).toEqual(operation);
      } finally {
        createAgain.mockRestore();
      }
    },
  );

  it.each(["stopped", "uncertain_source"] as const)(
    "recovers a candidate copy only with %s source I/O",
    async (variant) => {
      const f = await fixture();
      const candidate = await f.capture(await f.define());
      const copy = f.manager.createSnapshotCopy.bind(f.manager);
      const spy = vi
        .spyOn(f.manager, "createSnapshotCopy")
        .mockImplementationOnce(async (...args) => {
          await copy(...args);
          throw new Error("Simulated lost candidate copy acknowledgement");
        });
      try {
        expect((await f.dispatch({ ...baseline, candidate })).status).toBe("indeterminate");
      } finally {
        spy.mockRestore();
      }
      const action = f.journal.actions(f.authority.runId).at(-1)!;
      const ws = f.journal.agents.workspaceForOperation(f.authority.runId, action.operationId)!;
      const sourceOperation =
        variant === "uncertain_source"
          ? f.journal.agents.beginWorkspaceOperation(
              f.authority,
              f.workspace,
              "copy_source",
              f.journal.control(f.authority.runId).controlVersion,
            )
          : null;
      f.reopen();
      f.newLease();
      const journal = f.store.orchestration;
      const manager = new WorkspaceManager(journal, join(f.root, "managed"));
      await reconcileActions(journal, f.authority, (record) =>
        reconcileDiagnosticWorkspace(journal, manager, f.authority, record),
      );
      expect(journal.action(f.authority.runId, action.actionId)?.status).toBe(
        sourceOperation ? "indeterminate" : "succeeded",
      );
      expect(
        journal.agents.workspaceForOperation(f.authority.runId, action.operationId)?.workspaceId,
      ).toBe(ws.workspaceId);
      expect(readFileSync(join(ws.path, "app.txt"), "utf8")).toBe("green\n");
      if (sourceOperation)
        expect(journal.agents.activeWorkspaceOperation(f.authority.runId, f.workspace)).toEqual(
          sourceOperation,
        );
    },
  );
});
