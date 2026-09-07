import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ActionKernel } from "../src/kernel/actions.js";
import {
  registerDeliveryRecoveryCapabilities,
  reconcileDeliveryAction,
} from "../src/kernel/delivery-recovery.js";
import { reconcileActions } from "../src/kernel/reconcile.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { ControlledSdkRuntime } from "../src/adapters/controlled-sdk.js";
import { OrchestratorController, controlledDriver } from "../src/controller.js";
import { closureFixture } from "./fixtures/tracker-closure.js";
import type { KernelAction } from "../src/domain/orchestration.js";
import { fixture, check, git, success, target, waitFor } from "./fixtures/review.js";

type Setup = Awaited<ReturnType<typeof fixture>>;
type Kind =
  | "capture_candidate"
  | "create_review_workspace"
  | "create_implementation_workspace"
  | "run_validation"
  | "run_review"
  | "request_commit";

async function request(s: Setup, kind: Kind): Promise<KernelAction> {
  if (kind === "create_implementation_workspace") return { kind, baseCommitId: null };
  const validationPlanId = await s.define();
  if (kind === "capture_candidate")
    return { kind, taskId: s.taskId, ...target(s.workspace), validationPlanId };
  const candidate = await s.capture(validationPlanId);
  if (kind === "create_review_workspace") return { kind, ...candidate, revision: null };
  const copy = await s.copy(candidate);
  if (kind === "run_validation")
    return { kind, ...candidate, ...target(copy), validationPlanId, checkId: check.id };
  await s.validate(candidate, copy);
  if (kind === "run_review") {
    s.response(s.report(candidate));
    return {
      kind,
      ...candidate,
      ...target(copy),
      agent: null,
      instructions: "Independently inspect the candidate",
    };
  }
  await s.review(candidate);
  return { kind, ...candidate, subject: "Retain exact reviewed behavior" };
}

/** Physical work and its durable resource succeed; only the action acknowledgement is lost. */
async function loseAcknowledgement(s: Setup, action: KernelAction) {
  const original = s.journal.settleAction.bind(s.journal);
  const fault = vi
    .spyOn(s.journal, "settleAction")
    .mockImplementation((authority, id, expected, result) => {
      if (
        result.status === "succeeded" &&
        s.journal.action(authority.runId, id)?.request.action.kind === action.kind
      )
        throw new Error("Lost action acknowledgement");
      return original(authority, id, expected, result);
    });
  try {
    const running = await s.kernel.execute(s.decision(action), s.authority);
    if (running.status !== "running") throw new Error(`Expected asynchronous ${action.kind}`);
    await expect(s.kernel.operation(running.operationId)!).rejects.toThrow(
      "Lost action acknowledgement",
    );
    return s.journal.action(s.authority.runId, running.actionId)!;
  } finally {
    fault.mockRestore();
  }
}

function cold(s: Setup) {
  s.newLease();
  const journal = s.reopen().orchestration;
  const manager = new WorkspaceManager(journal, join(s.root, "managed"));
  const driver = new ControlledSdkRuntime(journal, {
    root: join(s.root, "runtime"),
    executable: join(s.root, "bin", "codex"),
    authCachePath: null,
    launcherEntrypoint: join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
    turnTimeoutMs: 30000,
  });
  const kernel = new ActionKernel(journal);
  registerDeliveryRecoveryCapabilities(kernel, manager, driver);
  journal.markInterruptedActions(s.authority);
  const decision = (action: KernelAction) => {
    const ticket = journal.beginDecision(
      s.authority,
      journal.latestObservationCursor(s.authority.runId),
      journal.control(s.authority.runId).controlVersion,
    );
    return {
      explanation: "Inspect the interrupted operation without replay",
      evidenceIds: [],
      request: {
        schemaVersion: 1 as const,
        decisionId: ticket.decisionId,
        observationCursor: ticket.observationCursor,
        expectedControlVersion: ticket.expectedControlVersion,
        action,
      },
    };
  };
  const dispatch = async (action: KernelAction) => {
    const result = await kernel.execute(decision(action), s.authority);
    return result.status === "running" ? await kernel.operation(result.operationId)! : result;
  };
  return { journal, manager, driver, kernel, decision, dispatch };
}
function inspection(input: Awaited<ReturnType<Setup["dispatch"]>>) {
  const value = success(input);
  if (value.kind !== "inspection") throw new Error("Expected recovery inspection");
  return JSON.parse(value.text);
}

describe.skipIf(process.platform !== "linux")("model-requested and cold delivery recovery", () => {
  it.each([
    "capture_candidate",
    "create_review_workspace",
    "create_implementation_workspace",
    "run_validation",
    "run_review",
    "request_commit",
  ] as const)(
    "cold-recovers the durable %s outcome without repeating its effect",
    async (kind) => {
      const s = await fixture(),
        run = s.authority.runId;
      const action = await request(s, kind);
      const parent = await loseAcknowledgement(s, action);
      const userIndex = readFileSync(join(s.source, ".git/index"));
      const recovered = cold(s);
      const writes = vi.spyOn(recovered.manager, "writeCandidateCommit");
      const copies = vi.spyOn(recovered.manager, "create");
      const turns = vi.spyOn(recovered.driver, "run");
      const beforeTurns = recovered.journal.agents.turns(run).length;
      const decision = recovered.decision({ kind: "reconcile_action", actionId: parent.actionId });
      const running = await recovered.kernel.execute(decision, s.authority);
      if (running.status !== "running") throw new Error("Expected recovery dispatch");
      const result = await recovered.kernel.operation(running.operationId)!;
      expect(inspection(result)).toMatchObject({
        actionId: parent.actionId,
        status: "succeeded",
        result: { kind: kind === "run_validation" ? "validation" : "resource" },
      });
      expect(recovered.journal.action(run, parent.actionId)?.status).toBe("succeeded");
      expect(await recovered.kernel.execute(decision, s.authority)).toEqual(result);
      expect(
        inspection(
          await recovered.dispatch({ kind: "reconcile_action", actionId: parent.actionId }),
        ).status,
      ).toBe("succeeded");
      expect(writes).not.toHaveBeenCalled();
      expect(copies).not.toHaveBeenCalled();
      expect(turns).not.toHaveBeenCalled();
      expect(recovered.journal.agents.turns(run)).toHaveLength(beforeTurns);
      expect(readFileSync(join(s.source, ".git/index"))).toEqual(userIndex);
      expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
      expect(git(s.source, "for-each-ref", "refs/heads/epicd/")).toBe("");
      if (kind === "request_commit") expect(recovered.journal.reviews.records(run)).toHaveLength(1);
    },
    30000,
  );

  it("recovers a failed check as failed evidence, not as passing validation", async () => {
    const s = await fixture({ ...check, args: ["-c", "exit 7"] });
    const parent = await loseAcknowledgement(s, await request(s, "run_validation"));
    const recovered = cold(s);
    expect(
      inspection(await recovered.dispatch({ kind: "reconcile_action", actionId: parent.actionId })),
    ).toMatchObject({
      status: "succeeded",
      result: { kind: "validation", outcome: "failed", satisfiesCheck: false },
    });
    const evidence = recovered.journal.delivery.validationForOperation(
      s.authority.runId,
      parent.operationId,
    )!;
    expect(evidence.outcome?.exitCode).toBe(7);
    expect(recovered.journal.delivery.satisfiesCheck(s.authority.runId, evidence.evidenceId)).toBe(
      false,
    );
  });

  it("inspects a retained commit after losing its adapter result, without writing another object", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    const action = await request(s, "request_commit");
    const write = s.manager.writeCandidateCommit.bind(s.manager);
    vi.spyOn(s.manager, "writeCandidateCommit").mockImplementation(async (...args) => {
      await write(...args);
      throw new Error("Lost stopped commit result");
    });
    const lost = await s.dispatch(action);
    expect(lost.status).toBe("indeterminate");
    const intent = s.journal.commits.records(run)[0]!;
    const object = git(s.workspace.path, "cat-file", "commit", intent.revision!);
    const recovered = cold(s);
    const writes = vi.spyOn(recovered.manager, "writeCandidateCommit");
    await reconcileActions(
      recovered.journal,
      s.authority,
      async (record) =>
        (await reconcileDeliveryAction(
          recovered.journal,
          recovered.manager,
          recovered.driver,
          s.authority,
          record,
        ))!,
    );
    expect(recovered.journal.action(run, lost.actionId)?.status).toBe("succeeded");
    expect(recovered.journal.commits.record(run, intent.commitId)).toMatchObject({
      status: "created",
      sourceIntact: true,
    });
    expect(writes).not.toHaveBeenCalled();
    expect(git(s.workspace.path, "cat-file", "commit", intent.revision!)).toBe(object);
  });

  it("allows another read after transient inspection failure without retrying the commit write", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    const action = await request(s, "request_commit");
    const write = s.manager.writeCandidateCommit.bind(s.manager);
    vi.spyOn(s.manager, "writeCandidateCommit").mockImplementation(async (...args) => {
      await write(...args);
      throw new Error("Lost stopped commit result");
    });
    const lost = await s.dispatch(action);
    expect(lost.status).toBe("indeterminate");
    const intent = s.journal.commits.records(run)[0]!;
    const originalBytes = git(s.workspace.path, "cat-file", "commit", intent.revision!);
    const recovered = cold(s);
    const inspect = vi
      .spyOn(recovered.manager, "inspectCandidateCommit")
      .mockRejectedValueOnce(new Error("Transient object inspection failure"));
    const writes = vi.spyOn(recovered.manager, "writeCandidateCommit");
    const retry = { kind: "reconcile_action", actionId: lost.actionId } as const;
    expect(inspection(await recovered.dispatch(retry)).status).toBe("indeterminate");
    expect(recovered.journal.commits.record(run, intent.commitId)).toEqual(intent);
    expect(inspection(await recovered.dispatch(retry)).status).toBe("succeeded");
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(writes).not.toHaveBeenCalled();
    expect(recovered.journal.commits.records(run)).toHaveLength(1);
    expect(git(s.workspace.path, "cat-file", "commit", intent.revision!)).toBe(originalBytes);
  });

  it("leaves unsupported indeterminate actions to their dedicated recovery capability", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    s.kernel.registerExternal("export_tracker", async () => {
      throw new Error("Interrupted before export admission");
    });
    const lost = await s.dispatch({ kind: "export_tracker" });
    expect(lost.status).toBe("indeterminate");
    const recovered = cold(s);
    const result = await recovered.dispatch({ kind: "reconcile_action", actionId: lost.actionId });
    expect(result).toMatchObject({ status: "rejected", code: "recovery_unavailable" });
    expect(recovered.journal.action(run, lost.actionId)?.status).toBe("indeterminate");
    expect(recovered.journal.tracker.operations(run)).toEqual([]);
  });

  it("does not clear an old commit exclusion from an absent ref or a replacement lease", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    const action = await request(s, "request_commit");
    vi.spyOn(s.manager, "writeCandidateCommit").mockRejectedValue(new Error("Unknown old Git I/O"));
    const lost = await s.dispatch(action);
    expect(lost.status).toBe("indeterminate");
    const intent = s.journal.commits.records(run)[0]!;
    const recovered = cold(s);
    expect(
      inspection(await recovered.dispatch({ kind: "reconcile_action", actionId: lost.actionId }))
        .status,
    ).toBe("indeterminate");
    expect(recovered.journal.agents.activeWorkspaceOperation(run, intent)?.operationId).toBe(
      intent.workspaceOperationId,
    );
    expect(recovered.journal.commits.record(run, intent.commitId).status).toBe("preparing");
  });

  it("requires another review when only a stopped turn, not a complete review verdict, survived", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    const action = await request(s, "run_review");
    const fault = vi.spyOn(s.journal.reviews, "beginFinalInspection").mockImplementation(() => {
      throw new Error("Lost before final inspection");
    });
    const lost = await s.dispatch(action);
    fault.mockRestore();
    expect(lost.status).toBe("indeterminate");
    const review = s.journal.reviews.records(run)[0]!;
    expect(s.journal.agents.turn(run, review.turnIdentity!).stopEvidence).toBeTruthy();
    const recovered = cold(s);
    const turns = vi.spyOn(recovered.driver, "run");
    expect(
      inspection(await recovered.dispatch({ kind: "reconcile_action", actionId: lost.actionId }))
        .status,
    ).toBe("failed");
    expect(recovered.journal.reviews.evidence(run, review.evidenceId)).toMatchObject({
      status: "finished",
      sourceIntact: false,
      report: null,
    });
    expect(recovered.journal.reviews.approval(run, review)).toBeNull();
    expect(recovered.journal.agents.turn(run, review.turnIdentity!).result).not.toBeNull();
    expect(turns).not.toHaveBeenCalled();
  });

  it("preserves an uncertain final review inspection even when its agent stopped", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    const action = await request(s, "run_review");
    const verify = s.manager.verifyValidationWorkspace.bind(s.manager);
    let inspections = 0;
    const fault = vi
      .spyOn(s.manager, "verifyValidationWorkspace")
      .mockImplementation(async (...args) => {
        if (++inspections === 2) throw new Error("Unknown final inspection I/O");
        return verify(...args);
      });
    const lost = await s.dispatch(action);
    fault.mockRestore();
    expect(lost.status).toBe("indeterminate");
    const review = s.journal.reviews.records(run)[0]!;
    const recovered = cold(s);
    expect(
      inspection(await recovered.dispatch({ kind: "reconcile_action", actionId: lost.actionId }))
        .status,
    ).toBe("indeterminate");
    expect(recovered.journal.agents.activeWorkspaceOperation(run, review)?.operationId).toBe(
      review.inspectionOperationId,
    );
    expect(recovered.journal.reviews.approval(run, review)).toBeNull();
  });

  it("preserves a materialized but unbound review copy instead of recreating or approving it", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    const action = await request(s, "create_review_workspace");
    vi.spyOn(s.journal.delivery, "bindReviewCopy").mockImplementation(() => {
      throw new Error("Binding not persisted");
    });
    const lost = await s.dispatch(action);
    expect(lost.status).toBe("indeterminate");
    const parent = s.journal.action(run, lost.actionId)!;
    const copy = s.journal.agents.workspaceForOperation(run, parent.operationId)!;
    const recovered = cold(s);
    expect(
      inspection(await recovered.dispatch({ kind: "reconcile_action", actionId: parent.actionId }))
        .status,
    ).toBe("failed");
    expect(recovered.journal.delivery.reviewCopyForOperation(run, parent.operationId)).toBeNull();
    expect(readFileSync(join(copy.path, "app.txt"), "utf8")).toBe("green\n");
  });

  it("preserves a changed review copy and does not rewrite it to satisfy recovery", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    const parent = await loseAcknowledgement(s, await request(s, "create_review_workspace"));
    const copy = s.journal.agents.workspaceForOperation(run, parent.operationId)!;
    writeFileSync(join(copy.path, "app.txt"), "user intervention\n");
    const recovered = cold(s);
    expect(
      inspection(await recovered.dispatch({ kind: "reconcile_action", actionId: parent.actionId }))
        .status,
    ).toBe("indeterminate");
    expect(readFileSync(join(copy.path, "app.txt"), "utf8")).toBe("user intervention\n");
  });

  it("fails a stopped capture with a lost snapshot result without recapturing its source", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    const action = await request(s, "capture_candidate");
    const capture = s.manager.capture.bind(s.manager);
    vi.spyOn(s.manager, "capture").mockImplementation(async (...args) => {
      await capture(...args);
      throw new Error("Lost captured manifest");
    });
    const lost = await s.dispatch(action);
    expect(lost.status).toBe("indeterminate");
    const refs = git(s.workspace.path, "for-each-ref", "refs/epicd/candidates/");
    const recovered = cold(s);
    const captures = vi.spyOn(recovered.manager, "capture");
    expect(
      inspection(await recovered.dispatch({ kind: "reconcile_action", actionId: lost.actionId }))
        .status,
    ).toBe("failed");
    expect(captures).not.toHaveBeenCalled();
    expect(git(s.workspace.path, "for-each-ref", "refs/epicd/candidates/")).toBe(refs);
    expect(recovered.journal.delivery.latestCandidate(run, s.taskId)?.status).toBe("failed");
  });

  it("does not manufacture a validation result after losing the supervisor outcome transaction", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    const action = await request(s, "run_validation");
    vi.spyOn(s.journal.delivery, "finishValidation").mockImplementation(() => {
      throw new Error("Validation outcome not durable");
    });
    const lost = await s.dispatch(action);
    expect(lost.status).toBe("indeterminate");
    const parent = s.journal.action(run, lost.actionId)!;
    const evidence = s.journal.delivery.validationForOperation(run, parent.operationId)!;
    const recovered = cold(s);
    expect(
      inspection(await recovered.dispatch({ kind: "reconcile_action", actionId: lost.actionId }))
        .status,
    ).toBe("indeterminate");
    expect(recovered.journal.delivery.evidence(run, evidence.evidenceId).outcome).toBeNull();
    expect(recovered.journal.agents.activeWorkspaceOperation(run, evidence)?.operationId).toBe(
      evidence.workspaceOperationId,
    );
  });

  it("rejects live and unknown action targets without stopping the current review", async () => {
    const s = await fixture();
    const action = await request(s, "run_review");
    if (action.kind !== "run_review") throw new Error("Expected review");
    s.response(s.report(action), ["sleep 30"]);
    const running = await s.kernel.execute(s.decision(action), s.authority);
    if (running.status !== "running") throw new Error("Expected running review");
    await waitFor(() =>
      s.journal.agents
        .turns(s.authority.runId)
        .some(
          (turn) =>
            turn.identity.operationId === running.operationId &&
            turn.submissionAcknowledgement !== null,
        ),
    );
    expect(
      await s.dispatch({ kind: "reconcile_action", actionId: running.actionId }),
    ).toMatchObject({ status: "rejected", code: "recovery_action_live" });
    expect(s.journal.action(s.authority.runId, running.actionId)?.status).toBe("running");
    expect(
      await s.dispatch({
        kind: "reconcile_action",
        actionId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toMatchObject({ status: "rejected", code: "unknown_recovery_action" });
    s.kernel.interruptAll();
    await s.kernel.operation(running.operationId);
  });

  it("recovers through the real controller before requesting the next coordinator decision", async () => {
    const s = await closureFixture(),
      run = s.authority.runId;
    const parent = await loseAcknowledgement(s, await request(s, "request_commit"));
    const committed = s.journal.commits.records(run)[0]!;
    const originalBytes = git(s.workspace.path, "cat-file", "commit", committed.revision!);
    s.store.releaseLease(run, s.authority.ownerToken);
    const store = s.reopen();
    let decisions = 0;
    const controller = new OrchestratorController(store, run, {
      driver: (selected, state) => {
        const actual = controlledDriver(selected, state);
        return {
          kind: actual.kind,
          reconcile: actual.reconcile.bind(actual),
          async run(authority, identity, signal) {
            expect(selected.orchestration.action(run, parent.actionId)?.status).toBe("succeeded");
            const prompt = selected.orchestration.agents.turn(run, identity).prompt.instructions;
            const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
            s.response({
              explanation: "Bounded scripted recovery probe, not an autonomous model judgment",
              evidenceIds: [],
              request: {
                schemaVersion: 1,
                decisionId: input.ticket.decisionId,
                observationCursor: input.ticket.observationCursor,
                expectedControlVersion: input.ticket.expectedControlVersion,
                action: {
                  kind: "escalate",
                  question: "Recovery probe finished; delivery is not claimed",
                  reason: "judgment",
                  evidenceIds: [],
                },
              },
            });
            decisions++;
            return actual.run(authority, identity, signal);
          },
        };
      },
    });
    const status = await controller.run();
    expect(status.control.status).toBe("awaiting_user");
    expect(decisions).toBe(1);
    expect(store.controllerLease(run)).toBeNull();
    expect(store.orchestration.commits.records(run)).toHaveLength(1);
    expect(store.orchestration.publications.records(run)).toEqual([]);
    expect(git(s.workspace.path, "cat-file", "commit", committed.revision!)).toBe(originalBytes);
    expect(git(s.source, "rev-parse", "HEAD")).toBe(s.head);
  }, 30000);

  it("cold-settles an interrupted reconciliation without repeating its already recovered parent", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    const parent = await loseAcknowledgement(s, await request(s, "request_commit"));
    const first = cold(s);
    const settle = first.journal.settleAction.bind(first.journal);
    const fault = vi
      .spyOn(first.journal, "settleAction")
      .mockImplementation((authority, id, expected, result) => {
        if (result.status === "succeeded" && id !== parent.actionId)
          throw new Error("Lost reconciliation acknowledgement");
        return settle(authority, id, expected, result);
      });
    let readerId: string;
    try {
      const running = await first.kernel.execute(
        first.decision({ kind: "reconcile_action", actionId: parent.actionId }),
        s.authority,
      );
      if (running.status !== "running") throw new Error("Expected reconciliation");
      readerId = running.actionId;
      await expect(first.kernel.operation(running.operationId)!).rejects.toThrow(
        "Lost reconciliation acknowledgement",
      );
    } finally {
      fault.mockRestore();
    }
    expect(first.journal.action(run, parent.actionId)?.status).toBe("succeeded");
    const second = cold(s);
    const inspect = vi.spyOn(second.manager, "inspectCandidateCommit");
    await reconcileActions(
      second.journal,
      s.authority,
      async (record) =>
        (await reconcileDeliveryAction(
          second.journal,
          second.manager,
          second.driver,
          s.authority,
          record,
        ))!,
    );
    expect(second.journal.action(run, readerId!)?.status).toBe("failed");
    expect(second.journal.action(run, parent.actionId)?.status).toBe("succeeded");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rolls back failed parent settlement and permits another observation without repeating the effect", async () => {
    const s = await fixture(),
      run = s.authority.runId;
    const parent = await loseAcknowledgement(s, await request(s, "request_commit"));
    const first = cold(s);
    const observe = first.journal.appendObservation.bind(first.journal);
    const fault = vi
      .spyOn(first.journal, "appendObservation")
      .mockImplementation((authority, event) => {
        if (event.sourceEventId === `${parent.actionId}:indeterminate:succeeded`)
          throw new Error("Recovery audit unavailable");
        return observe(authority, event);
      });
    try {
      expect(
        (await first.dispatch({ kind: "reconcile_action", actionId: parent.actionId })).status,
      ).toBe("indeterminate");
    } finally {
      fault.mockRestore();
    }
    expect(first.journal.action(run, parent.actionId)?.status).toBe("indeterminate");
    const write = vi.spyOn(first.manager, "writeCandidateCommit");
    expect(
      inspection(await first.dispatch({ kind: "reconcile_action", actionId: parent.actionId }))
        .status,
    ).toBe("succeeded");
    expect(write).not.toHaveBeenCalled();
    expect(first.journal.commits.records(run)).toHaveLength(1);
  });
});
