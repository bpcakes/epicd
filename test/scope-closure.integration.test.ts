import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  closureFixture,
  publishVerified,
  publishTracker,
  trackerAction,
} from "./fixtures/tracker-closure.js";
import { check, resource, git } from "./fixtures/review.js";
import { runStatusView } from "../src/status.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { registerTrackerCapabilities, reconcileTracker } from "../src/kernel/tracker.js";
import { OrchestratorLoop, type DecisionSource } from "../src/orchestrator/loop.js";
import { reconcileActions } from "../src/kernel/reconcile.js";
import { RepositoryAdmission } from "../src/kernel/repository-admission.js";
import { runRepositoryIO } from "../dist/adapters/repository-io.js";
import { PublicationGit, RUN_OWNERSHIP_REF } from "../src/adapters/publication-git.js";
import { OrchestratorController } from "../src/controller.js";

type Setup = Awaited<ReturnType<typeof closureFixture>>;
async function deliverTask(s: Setup) {
  const delivery = await publishVerified(s);
  resource(
    await s.dispatch({
      kind: "request_beads_transition",
      taskId: "demo.1",
      transition: "close_task",
      revision: delivery.commit.revision!,
    }),
  );
  return delivery.commit.revision!;
}
async function approveEpic(s: Setup, revision: string) {
  const { stage: _stage, ...command } = check;
  const plan = resource(
    await s.dispatch({
      kind: "define_validation_plan",
      taskId: "demo",
      acceptanceCriteria: ["All epic requirements are delivered"],
      checks: [command],
    }),
  );
  const prepared = resource(
    await s.dispatch({
      kind: "prepare_epic_delivery",
      publicationId: s.journal.publications.repository(s.authority.runId)!.lastPublishedId!,
      trackerSnapshotId: s.journal.tracker.snapshot(s.authority.runId).snapshotId,
      validationPlanId: plan.resourceId,
    }),
  );
  const candidate = { candidateId: prepared.resourceId, candidateGeneration: prepared.generation };
  await s.validate(candidate, await s.copy(candidate, revision));
  await s.review(candidate, {}, [], revision);
  expect(s.journal.reviews.approval(s.authority.runId, candidate, "exact_revision")).not.toBeNull();
  return candidate;
}
function closeRoot(s: Setup, revision: string) {
  return s.dispatch({
    kind: "request_beads_transition",
    transition: "close_epic",
    taskId: "demo",
    revision,
  });
}
function reserveCompletion(s: Setup) {
  const ticket = s.journal.beginDecision(
    s.authority,
    s.journal.latestObservationCursor(s.authority.runId),
    s.journal.control(s.authority.runId).controlVersion,
  );
  const admitted = s.journal.acceptAction(s.authority, {
    explanation: "Complete the proven delivery",
    evidenceIds: [],
    request: {
      schemaVersion: 1,
      decisionId: ticket.decisionId,
      observationCursor: ticket.observationCursor,
      expectedControlVersion: ticket.expectedControlVersion,
      action: { kind: "complete_run" },
    },
  });
  if (admitted.kind !== "accepted") throw new Error("Expected a fresh completion admission");
  s.journal.startAction(s.authority, admitted.action.actionId);
  return s.journal.tracker.reserve(s.authority, admitted.action.actionId);
}

describe.skipIf(process.platform !== "linux")("guarded scope closure and completion", () => {
  it("closes the independently verified root and completes with a proven tracker-only descendant without changing the user checkout", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const admission = new RepositoryAdmission(
      s.store,
      s.authority,
      await new PublicationGit().bind(s.source),
      undefined,
      runRepositoryIO,
    );
    await admission.enter();
    await deliverTask(s);
    const revision = (await publishTracker(s)).revision;
    expect((await closeRoot(s, revision)).status).toBe("rejected");
    await approveEpic(s, revision);
    expect((await s.dispatch({ kind: "complete_run" })).status).toBe("rejected");
    writeFileSync(join(s.source, "app.txt"), "user-owned work\n");
    const index = readFileSync(join(s.source, ".git/index"));
    const closed = resource(await closeRoot(s, revision));
    expect(s.journal.tracker.record(run, closed.resourceId)).toMatchObject({
      kind: "close_epic",
      outcome: "closed",
      closure: { proof: { kind: "epic" } },
    });
    expect((await s.dispatch({ kind: "complete_run" })).status).toBe("rejected");
    const trackerPublication = await publishTracker(s);
    const complete = resource(await s.dispatch({ kind: "complete_run" }));
    expect(s.journal.tracker.record(run, complete.resourceId)).toMatchObject({
      kind: "complete",
      outcome: "completed",
      mutationDispatched: false,
      completion: {
        disposition: "retained_for_inspection",
        fixtureCreationIds: [],
        fixtureAccessIds: [],
      },
    });
    expect(runStatusView(s.store, run)).toMatchObject({
      control: { status: "complete" },
      tracker: { completion: { revision: trackerPublication.revision } },
    });
    expect(s.journal.actions(run).at(-1)?.status).toBe("succeeded");
    expect(s.journal.tracker.pending(run)).toBeNull();
    expect(
      s
        .trackerCommands()
        .filter((args) => args[0] === "close")
        .map((args) => args[1]),
    ).toEqual(["demo.1", "demo"]);
    expect(s.journal.commits.records(run)).toHaveLength(1);
    expect(s.journal.trackerCommits.records(run)).toHaveLength(2);
    expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
    expect(readFileSync(join(s.source, "app.txt"), "utf8")).toBe("user-owned work\n");
    expect(readFileSync(join(s.source, ".git/index"))).toEqual(index);
    expect(s.journal.repositoryAdmission.record(run)?.phase).toBe("owned");
    s.store.releaseLease(run, s.authority.ownerToken);
    const reopened = s.reopen();
    const controller = new OrchestratorController(reopened, run, {
      repositoryIO: runRepositoryIO,
      driver: () => {
        throw new Error("Completed-run cleanup must not initialize a model");
      },
    });
    const cleaned = await controller.run();
    expect(cleaned.repositoryAdmission).toMatchObject({ phase: "released", ioStopped: true });
    expect(git(s.source, "for-each-ref", RUN_OWNERSHIP_REF)).toBe("");
    expect(git(s.source, "rev-parse", `refs/heads/epicd/${run}`)).toBe(trackerPublication.revision);
    expect(readFileSync(join(s.source, ".git/index"))).toEqual(index);
    expect(readFileSync(join(s.source, "app.txt"), "utf8")).toBe("user-owned work\n");
  }, 45000);

  it("can close a delivered nested container while an unrelated root task remains open", async () => {
    const s = await closureFixture("sha1", true, true, true);
    const revision = await deliverTask(s);
    resource(
      await s.dispatch({
        kind: "request_beads_transition",
        taskId: "demo.group",
        transition: "close_container",
        revision,
      }),
    );
    expect(s.readTracker().container.status).toBe("closed");
    expect(s.readTracker().other_tasks[0].status).toBe("open");
    expect((await closeRoot(s, revision)).status).toBe("rejected");
    expect((await s.dispatch({ kind: "complete_run" })).status).toBe("rejected");
  }, 45000);

  it("requires nested container closure as well as whole-epic approval", async () => {
    const s = await closureFixture("sha1", true, "preclosed", true);
    const revision = await deliverTask(s);
    const candidate = await approveEpic(s, revision);
    expect((await closeRoot(s, revision)).status).toBe("rejected");
    resource(
      await s.dispatch({
        kind: "request_beads_transition",
        taskId: "demo.group",
        transition: "close_container",
        revision,
      }),
    );
    expect(s.journal.delivery.candidateCurrent(s.authority.runId, candidate)).toBe(true);
    resource(await closeRoot(s, revision));
    await publishTracker(s);
    resource(await s.dispatch({ kind: "complete_run" }));
  }, 45000);

  it.each([
    ["changed requirements", { epic_description: "A newly required behavior" }],
    ["new open child", { new_children: ["demo.3"] }],
    ["concurrent ownership", { epic_assignee: "someone-else" }],
  ])(
    "rejects %s from a fresh graph before dispatching root close",
    async (_label, changes) => {
      const s = await closureFixture();
      const revision = await deliverTask(s);
      await approveEpic(s, revision);
      s.writeTracker(changes);
      expect((await closeRoot(s, revision)).status).not.toBe("succeeded");
      expect(
        s
          .trackerCommands()
          .filter((args) => args[0] === "close")
          .map((args) => args[1]),
      ).toEqual(["demo.1"]);
      expect(s.journal.control(s.authority.runId).status).toBe("active");
    },
    45000,
  );

  it("does not treat an externally closed root as this run's completion proof", async () => {
    const s = await closureFixture();
    const revision = await deliverTask(s);
    await approveEpic(s, revision);
    s.writeTracker({
      epic_status: "closed",
      epic_closed_at: new Date().toISOString(),
      epic_close_reason: "Closed by someone else",
      epic_closed_by_session: "other",
    });
    resource(await s.dispatch({ kind: "refresh_tracker" }));
    expect((await s.dispatch({ kind: "complete_run" })).status).toBe("rejected");
    expect(s.journal.control(s.authority.runId).status).toBe("active");
  }, 45000);

  it("rolls back terminal state and its parent action together, then cold-recovers with fresh inspection and no repeated close", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const revision = await deliverTask(s);
    await approveEpic(s, revision);
    resource(await closeRoot(s, revision));
    await publishTracker(s);
    const intent = reserveCompletion(s);
    const ready = await s.adapter.execute(
      s.authority,
      intent.trackerOperationId,
      new AbortController().signal,
    );
    expect(ready.completion).not.toBeNull();
    expect(ready.outcome).toBeNull();
    const db = new Database(join(s.root, "state.sqlite3"));
    try {
      db.exec(`CREATE TRIGGER fail_terminal_result BEFORE UPDATE ON actions
        WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'lost terminal action write'); END`);
      expect(() =>
        s.journal.settleAction(s.authority, intent.actionId, "running", {
          status: "succeeded",
          actionId: intent.actionId,
          result: { kind: "resource", resourceId: intent.trackerOperationId, generation: 1 },
        }),
      ).toThrow("lost terminal action write");
      expect(s.journal.control(run).status).toBe("active");
      expect(s.journal.tracker.record(run, intent.trackerOperationId).outcome).toBeNull();
      expect(s.journal.action(run, intent.actionId)?.status).toBe("running");
      expect(s.store.get(run)).not.toBeNull();
      db.exec("DROP TRIGGER fail_terminal_result");
    } finally {
      db.close();
    }
    s.newLease();
    const store = s.reopen(),
      kernel = new ActionKernel(store.orchestration);
    const adapter = registerTrackerCapabilities(kernel, s.transport);
    const calls = s.trackerCommands().length;
    const recovered = await reconcileTracker(
      kernel,
      adapter,
      s.authority,
      intent.trackerOperationId,
    );
    expect(recovered).toMatchObject({ outcome: "completed", ioStopped: true });
    expect(s.trackerCommands().length).toBeGreaterThan(calls);
    expect(s.trackerCommands().filter((args) => args[0] === "close")).toHaveLength(2);
    expect(runStatusView(store, run).control.status).toBe("complete");
    const terminalCalls = s.trackerCommands().length;
    await reconcileTracker(kernel, adapter, s.authority, intent.trackerOperationId);
    expect(s.trackerCommands()).toHaveLength(terminalCalls);
  }, 45000);

  it("settles an unused completion intent and its model-requested reconciliation atomically", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const revision = await deliverTask(s);
    await approveEpic(s, revision);
    resource(await closeRoot(s, revision));
    await publishTracker(s);
    const intent = reserveCompletion(s);
    s.newLease();
    const store = s.reopen(),
      kernel = new ActionKernel(store.orchestration);
    registerTrackerCapabilities(kernel, s.transport);
    resource(
      await trackerAction(kernel, s.authority, {
        kind: "reconcile_tracker_operation",
        trackerOperationId: intent.trackerOperationId,
      }),
    );
    expect(store.orchestration.control(run).status).toBe("complete");
    expect(store.orchestration.action(run, intent.actionId)?.status).toBe("succeeded");
    expect(store.orchestration.actions(run).at(-1)?.status).toBe("succeeded");
    expect(s.trackerCommands().filter((args) => args[0] === "close")).toHaveLength(2);
  }, 45000);

  it("lets the model request completion without launching another coordinator turn during terminal inspection", async () => {
    const s = await closureFixture();
    const revision = await deliverTask(s);
    await approveEpic(s, revision);
    resource(await closeRoot(s, revision));
    await publishTracker(s);
    let calls = 0;
    const source: DecisionSource = {
      async decide({ ticket }) {
        calls += 1;
        if (calls > 1) throw new Error("Started reasoning during completion");
        return {
          explanation: "All required delivery proof is present",
          evidenceIds: [],
          request: {
            schemaVersion: 1,
            decisionId: ticket.decisionId,
            observationCursor: ticket.observationCursor,
            expectedControlVersion: ticket.expectedControlVersion,
            action: { kind: "complete_run" },
          },
        };
      },
    };
    expect(await new OrchestratorLoop(s.kernel, source, { pollMs: 10 }).run(s.authority)).toBe(
      "complete",
    );
    expect(calls).toBe(1);
  }, 45000);

  it("cold-recovers when completion and its read-only reconciliation were both interrupted", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const revision = await deliverTask(s);
    await approveEpic(s, revision);
    resource(await closeRoot(s, revision));
    await publishTracker(s);
    const intent = reserveCompletion(s);
    await s.adapter.execute(s.authority, intent.trackerOperationId, new AbortController().signal);
    const ticket = s.journal.beginDecision(
      s.authority,
      s.journal.latestObservationCursor(run),
      s.journal.control(run).controlVersion,
    );
    const admitted = s.journal.acceptAction(s.authority, {
      explanation: "Inspect the terminal operation",
      evidenceIds: [],
      request: {
        schemaVersion: 1,
        decisionId: ticket.decisionId,
        observationCursor: ticket.observationCursor,
        expectedControlVersion: ticket.expectedControlVersion,
        action: {
          kind: "reconcile_tracker_operation",
          trackerOperationId: intent.trackerOperationId,
        },
      },
    });
    if (admitted.kind !== "accepted") throw new Error("Expected reconciliation admission");
    s.journal.startAction(s.authority, admitted.action.actionId);
    s.newLease();
    const store = s.reopen(),
      kernel = new ActionKernel(store.orchestration);
    const adapter = registerTrackerCapabilities(kernel, s.transport);
    let calls = 0;
    await reconcileActions(store.orchestration, s.authority, async (action) => {
      calls += 1;
      expect(action.actionId).toBe(intent.actionId);
      const record = await adapter.reconcile(s.authority, intent.trackerOperationId);
      expect(record.completion).not.toBeNull();
      return {
        status: "succeeded",
        result: { kind: "resource", resourceId: record.trackerOperationId, generation: 1 },
      };
    });
    expect(calls).toBe(1);
    expect(store.orchestration.control(run).status).toBe("complete");
    expect(store.orchestration.action(run, intent.actionId)?.status).toBe("succeeded");
    expect(store.orchestration.action(run, admitted.action.actionId)?.status).toBe("failed");
    expect(s.trackerCommands().filter((args) => args[0] === "close")).toHaveLength(2);
  }, 45000);

  it("refuses completion while a workspace operation has no stop evidence", async () => {
    const s = await closureFixture();
    const revision = await deliverTask(s);
    await approveEpic(s, revision);
    resource(await closeRoot(s, revision));
    await publishTracker(s);
    const operation = s.journal.agents.beginWorkspaceOperation(
      s.authority,
      s.workspace,
      "inspect_materialization",
      s.journal.control(s.authority.runId).controlVersion,
    );
    expect((await s.dispatch({ kind: "complete_run" })).status).toBe("rejected");
    s.journal.agents.finishWorkspaceOperation(
      s.authority,
      operation.operationId,
      "succeeded",
      "Inspection stopped",
    );
    resource(await s.dispatch({ kind: "complete_run" }));
  }, 45000);

  it("detects a close-time ownership conflict without accepting delivery or discarding the external owner", async () => {
    const s = await closureFixture();
    const revision = await deliverTask(s);
    await approveEpic(s, revision);
    const close = s.transport.close.bind(s.transport);
    vi.spyOn(s.transport, "close").mockImplementationOnce(async (...args) => {
      s.writeTracker({ epic_assignee: "concurrent-owner" });
      return close(...args);
    });
    expect((await closeRoot(s, revision)).status).not.toBe("succeeded");
    expect(s.readTracker().epic_assignee).toBe("concurrent-owner");
    expect(s.journal.control(s.authority.runId).status).toBe("active");
    expect((await s.dispatch({ kind: "complete_run" })).status).not.toBe("succeeded");
  }, 45000);
});
