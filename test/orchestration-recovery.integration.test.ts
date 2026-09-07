import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { OperationFailed } from "../src/kernel/guards.js";
import { reconcileActions } from "../src/kernel/reconcile.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import type { ControllerAuthority, OrchestratorDecision } from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const roots: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "epicd-action-recovery-"));
  roots.push(root);
  const store = new StateStore(join(root, "state.sqlite3"));
  stores.push(store);
  const state = store.create(initialRun(), RepositoryPolicySchema.parse({ schemaVersion: 1 }));
  const lease = store.acquireLease(state.runId);
  const authority: ControllerAuthority = {
    runId: state.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const ticket = store.orchestration.beginDecision(authority, 0, 0);
  const decision: OrchestratorDecision = {
    explanation: "Run a required check",
    evidenceIds: [],
    request: {
      schemaVersion: 1,
      decisionId: ticket.decisionId,
      observationCursor: 0,
      expectedControlVersion: 0,
      action: {
        kind: "run_validation",
        workspaceId: "workspace",
        workspaceGeneration: 1,
        candidateId: "candidate",
        candidateGeneration: 1,
        validationPlanId: "plan",
        checkId: "tests",
      },
    },
  };
  return { store, authority, decision, kernel: new ActionKernel(store.orchestration) };
}

describe("external action uncertainty", () => {
  it("does not call a partly executed effect again when its outcome is unknown", async () => {
    const { kernel, store, authority, decision } = fixture();
    let effects = 0;
    kernel.registerExternal("run_validation", async () => {
      effects += 1;
      throw new Error("Connection lost after external dispatch");
    });
    const running = await kernel.execute(decision, authority);
    if (running.status !== "running") throw new Error("Expected background operation");
    await expect
      .poll(() => store.orchestration.action(authority.runId, running.actionId)?.status)
      .toBe("indeterminate");
    const replay = await kernel.execute(decision, authority);
    expect(replay.status).toBe("indeterminate");
    expect(effects).toBe(1);
    await reconcileActions(store.orchestration, authority, async () => ({
      status: "unresolved",
      detail: "The external resource identity remains ambiguous",
    }));
    expect(store.orchestration.action(authority.runId, running.actionId)?.status).toBe(
      "indeterminate",
    );
    expect(effects).toBe(1);
  });

  it("records a definitive command failure as a problem, not a blocked epic", async () => {
    const { kernel, store, authority, decision } = fixture();
    kernel.registerExternal("run_validation", async () => {
      throw new OperationFailed("Supervised browser check exited 1; process tree stopped");
    });
    const running = await kernel.execute(decision, authority);
    await expect
      .poll(() => store.orchestration.action(authority.runId, running.actionId)?.status)
      .toBe("failed");
    expect(store.orchestration.control(authority.runId).status).toBe("active");
    expect(store.orchestration.observations(authority.runId).map((event) => event.kind)).toEqual([
      "operation.problem",
      "action.failed",
    ]);
  });

  it("records inspected external success after recovery without dispatching the effect", async () => {
    const { store, authority, decision } = fixture();
    const accepted = store.orchestration.acceptAction(authority, decision);
    if (accepted.kind !== "accepted") throw new Error("Expected accepted intent");
    store.orchestration.startAction(authority, accepted.action.actionId);
    let inspections = 0;
    await reconcileActions(store.orchestration, authority, async (record) => {
      inspections += 1;
      expect(record.status).toBe("indeterminate");
      return {
        status: "succeeded",
        result: { kind: "resource", resourceId: "verified-owned-resource", generation: 1 },
      };
    });
    expect(inspections).toBe(1);
    expect(store.orchestration.action(authority.runId, accepted.action.actionId)?.status).toBe(
      "succeeded",
    );
    await reconcileActions(store.orchestration, authority, async () => {
      throw new Error("Terminal actions need no replay");
    });
  });

  it("does not let successful recovery bypass the journal's superseded-policy settlement guard", async () => {
    const { store, authority, decision } = fixture();
    const journal = store.orchestration;
    const accepted = journal.acceptAction(authority, decision);
    if (accepted.kind !== "accepted") throw new Error("Expected accepted intent");
    journal.startAction(authority, accepted.action.actionId);
    // Fault injection: a recovered physical fact is not successful action authority.
    const current = journal.control(authority.runId);
    const policy = vi.spyOn(journal, "control").mockReturnValue({
      ...current,
      policyDigest: "f".repeat(64),
    });
    try {
      await reconcileActions(journal, authority, async () => ({
        status: "succeeded",
        result: { kind: "resource", resourceId: "retained-resource", generation: 1 },
      }));
      expect(journal.action(authority.runId, accepted.action.actionId)?.status).toBe("failed");
      expect(journal.observations(authority.runId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "recovery.failed",
            summary: expect.stringContaining("superseded policy"),
          }),
        ]),
      );
    } finally {
      policy.mockRestore();
    }
  });
});
