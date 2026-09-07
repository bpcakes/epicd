import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import type {
  ControllerAuthority,
  KernelAction,
  MemoryInput,
  OrchestratorDecision,
} from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const roots: string[] = [];
const stores: StateStore[] = [];
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(policy = RepositoryPolicySchema.parse({ schemaVersion: 1 })) {
  const root = mkdtempSync(join(tmpdir(), "epicd-journal-"));
  roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new StateStore(path);
  stores.push(store);
  const run = store.createAdaptive(initialRun(), policy);
  const lease = store.acquireLease(run.runId);
  const authority: ControllerAuthority = {
    runId: run.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const db = new Database(path);
  databases.push(db);
  return { store, journal: store.orchestration, run, authority, path, db };
}

function decision(
  setup: ReturnType<typeof fixture>,
  action: KernelAction = { kind: "inspect_run" },
): OrchestratorDecision {
  const control = setup.journal.control(setup.run.runId);
  const ticket = setup.journal.beginDecision(
    setup.authority,
    setup.journal.latestObservationCursor(setup.run.runId),
    control.controlVersion,
  );
  return {
    explanation: "Inspect fresh delivery evidence",
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

function observation(setup: ReturnType<typeof fixture>, id: string) {
  return setup.journal.appendObservation(setup.authority, {
    source: "test",
    sourceEventId: id,
    kind: "command.completed",
    summary: "validation failed",
    artifactIds: [],
    identity: null,
    wakesOrchestrator: true,
  });
}

describe("durable action admission", () => {
  it("does not refill decision budgets after invalid output or reopening state", () => {
    const setup = fixture(
      RepositoryPolicySchema.parse({
        schemaVersion: 1,
        budgets: { taskDecisions: 1, epicDecisions: 1 },
      }),
    );
    for (let index = 0; index < 2; index += 1) {
      const request = decision(setup);
      setup.journal.rejectDecision(
        setup.authority,
        request.request.decisionId,
        "Malformed response",
      );
    }
    const reopened = new StateStore(setup.path);
    stores.push(reopened);
    expect(reopened.orchestration.control(setup.run.runId).decisionsUsed).toBe(2);
    expect(() => decision(setup)).toThrow("budget exhausted");
  });

  it("pins Astra when an unleased settings reset restores inheritance", () => {
    const setup = fixture();
    setup.store.releaseLease(setup.run.runId, setup.authority.ownerToken);
    const preferences = structuredClone(setup.run.agentSettings);
    preferences.orchestrator = { model: null, reasoningEffort: null };
    setup.store.updateAgentSettings(setup.run.runId, preferences, {
      model: "different-worker",
      reasoningEffort: null,
    });
    expect(setup.store.get(setup.run.runId)?.agentSettings.orchestrator.model).toBe("gpt-6-astra");
    expect(setup.store.get(setup.run.runId)?.model).toBe("different-worker");
    expect(setup.journal.control(setup.run.runId).controlVersion).toBe(1);
  });
  it("records one intent for identical replay and rejects different arguments under the same decision", () => {
    const setup = fixture();
    const request = decision(setup);
    const first = setup.journal.acceptAction(setup.authority, request);
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") throw new Error("Expected acceptance");
    expect(setup.journal.acceptAction(setup.authority, structuredClone(request))).toEqual({
      kind: "replayed",
      action: first.action,
    });
    const different = {
      ...request,
      request: {
        ...request.request,
        action: { kind: "inspect_fixture" as const, fixtureId: "db" },
      },
    };
    expect(setup.journal.acceptAction(setup.authority, different)).toMatchObject({
      kind: "rejected",
      result: { code: "replay_mismatch" },
    });
    expect(setup.journal.actions(setup.run.runId)).toHaveLength(1);
    expect(
      setup.store.events(setup.run.runId).some((event) => event.kind === "action.rejected"),
    ).toBe(true);
  });

  it("does not consume observations that arrive while the model is deciding", () => {
    const setup = fixture();
    const first = observation(setup, "one");
    const request = decision(setup);
    const late = observation(setup, "two");
    setup.journal.acceptAction(setup.authority, request);
    expect(setup.journal.control(setup.run.runId).observationCursor).toBe(first.id);
    expect(setup.journal.observations(setup.run.runId, first.id)).toEqual([late]);
  });

  it("pins pending decision identity across restart without replenishing budgets", () => {
    const setup = fixture();
    const request = decision(setup);
    const other = new StateStore(setup.path);
    stores.push(other);
    expect(
      other.orchestration.beginDecision(
        setup.authority,
        request.request.observationCursor,
        request.request.expectedControlVersion,
      ).decisionId,
    ).toBe(request.request.decisionId);
    expect(other.orchestration.control(setup.run.runId).decisionsUsed).toBe(1);
  });

  it("rejects stale settings decisions and direct conflicting model updates", () => {
    const setup = fixture();
    const request = decision(setup);
    const settings = structuredClone(setup.run.agentSettings);
    settings.orchestrator.reasoningEffort = "medium";
    setup.store.updateAgentSettingsWithLease(setup.run.runId, setup.authority.ownerToken, settings);
    expect(setup.journal.control(setup.run.runId).controlVersion).toBe(1);
    expect(setup.journal.acceptAction(setup.authority, request)).toMatchObject({
      kind: "rejected",
      result: { code: "stale_control" },
    });
    settings.orchestrator.model = "not-astra";
    expect(() =>
      setup.store.updateAgentSettingsWithLease(
        setup.run.runId,
        setup.authority.ownerToken,
        settings,
      ),
    ).toThrow("requires gpt-6-astra");
    expect(setup.journal.control(setup.run.runId).controlVersion).toBe(1);
  });

  it("rejects invented tickets, forged cursors, and lost lease generations", () => {
    const setup = fixture();
    const request = decision(setup);
    expect(
      setup.journal.acceptAction(setup.authority, {
        ...request,
        request: { ...request.request, decisionId: "invented" },
      }),
    ).toMatchObject({ kind: "rejected", result: { code: "unknown_decision" } });
    expect(() =>
      setup.journal.acceptAction({ ...setup.authority, leaseId: "old-generation" }, request),
    ).toThrow("lease was lost");
    expect(
      setup.journal.acceptAction(setup.authority, {
        ...request,
        request: { ...request.request, observationCursor: 1000 },
      }),
    ).toMatchObject({ kind: "rejected", result: { code: "wrong_cursor" } });
  });

  it("rolls back intent, decision acceptance, and cursor together when audit persistence fails", () => {
    const setup = fixture();
    observation(setup, "one");
    const request = decision(setup);
    setup.db.exec(
      `CREATE TRIGGER fail_action_audit BEFORE INSERT ON events WHEN NEW.kind = 'action.accepted' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`,
    );
    expect(() => setup.journal.acceptAction(setup.authority, request)).toThrow(
      "injected storage failure",
    );
    expect(setup.journal.actions(setup.run.runId)).toEqual([]);
    expect(setup.journal.control(setup.run.runId).observationCursor).toBe(0);
    expect(
      setup.db
        .prepare("SELECT status FROM decisions WHERE decision_id = ?")
        .get(request.request.decisionId),
    ).toEqual({ status: "pending" });
    setup.db.exec("DROP TRIGGER fail_action_audit");
    expect(setup.journal.acceptAction(setup.authority, request).kind).toBe("accepted");
  });

  it("marks interrupted external actions indeterminate, rejects the former owner, and retains terminal replay", () => {
    const setup = fixture();
    const request = decision(setup);
    const accepted = setup.journal.acceptAction(setup.authority, request);
    if (accepted.kind !== "accepted") throw new Error("Expected action");
    setup.journal.startAction(setup.authority, accepted.action.actionId);
    setup.store.forceReleaseLease(setup.run.runId, process.pid, setup.authority.leaseId);
    const other = new StateStore(setup.path);
    stores.push(other);
    const lease = other.acquireLease(setup.run.runId);
    const authority = {
      runId: setup.run.runId,
      ownerToken: lease.ownerToken,
      leaseId: lease.leaseId,
    };
    expect(() =>
      setup.journal.settleAction(setup.authority, accepted.action.actionId, "running", {
        status: "succeeded",
        actionId: accepted.action.actionId,
        result: { kind: "inspection", text: "late", artifactIds: [] },
      }),
    ).toThrow("lease was lost");
    expect(other.orchestration.markInterruptedActions(authority)[0]?.status).toBe("indeterminate");
    expect(other.orchestration.acceptAction(authority, request)).toMatchObject({
      kind: "replayed",
      action: { status: "indeterminate" },
    });
    expect(() => other.orchestration.startAction(authority, accepted.action.actionId)).toThrow(
      "accepted action",
    );
  });

  it("checks dispatch against a pause after intent admission", () => {
    const setup = fixture();
    const accepted = setup.journal.acceptAction(setup.authority, decision(setup));
    if (accepted.kind !== "accepted") throw new Error("Expected action");
    setup.journal.changeStatus(setup.authority, "paused");
    expect(() => setup.journal.startAction(setup.authority, accepted.action.actionId)).toThrow(
      "stale before dispatch",
    );
    expect(() => decision(setup)).toThrow("paused");
  });

  it("deduplicates source events while detecting reused IDs with different content", () => {
    const setup = fixture();
    const first = observation(setup, "one");
    expect(observation(setup, "one")).toEqual(first);
    expect(() =>
      setup.journal.appendObservation(setup.authority, {
        source: "test",
        sourceEventId: "one",
        kind: "command.completed",
        summary: "changed",
        artifactIds: [],
        identity: null,
        wakesOrchestrator: true,
      }),
    ).toThrow("different content");
    expect(setup.journal.observations(setup.run.runId)).toHaveLength(1);
  });

  it("prevents a whole legacy snapshot from overwriting adaptive state", () => {
    const setup = fixture();
    expect(() =>
      setup.store.saveWithLease(
        { ...setup.run, stateSchemaVersion: 1, orchestrationMode: "legacy" },
        setup.authority.ownerToken,
      ),
    ).toThrow("legacy state snapshot");
  });

  it("retains run-local knowledge and validates provenance and supersession", () => {
    const setup = fixture();
    const source = observation(setup, "receipt");
    const input: MemoryInput = {
      kind: "knowledge",
      content: "Review wrappers append tracked receipts; use underlying checks",
      scope: "run",
      taskId: null,
      confidence: "observed",
      observationIds: [source.id],
      evidenceIds: [],
      revision: "revision-one",
      environmentGeneration: null,
      supersedes: null,
    };
    const first = setup.journal.recordMemory(setup.authority, input);
    const second = setup.journal.recordMemory(setup.authority, {
      ...input,
      content: "Confirmed no-receipt command",
      supersedes: first.memoryId,
    });
    expect(setup.journal.memory(setup.run.runId)).toEqual([second]);
    expect(setup.journal.memory(setup.run.runId, true)[0]?.supersededBy).toBe(second.memoryId);
    expect(() =>
      setup.journal.recordMemory(setup.authority, { ...input, observationIds: [999] }),
    ).toThrow("outside this run");
    expect(() =>
      setup.journal.recordMemory(setup.authority, { ...input, supersedes: first.memoryId }),
    ).toThrow("supersession is stale");
  });

  it("quarantines raw actions, observations, memory, and policy atomically with invalid state", () => {
    const setup = fixture();
    observation(setup, "one");
    setup.journal.acceptAction(setup.authority, decision(setup));
    setup.store.releaseLease(setup.run.runId, setup.authority.ownerToken);
    setup.db
      .prepare("UPDATE runs SET state_json = ? WHERE run_id = ?")
      .run('{"broken":true}', setup.run.runId);
    setup.store.quarantineInvalidRun(setup.run.runId);
    const preserved = setup.db
      .prepare("SELECT source_table, row_json FROM quarantined_orchestration WHERE run_id = ?")
      .all(setup.run.runId) as { source_table: string; row_json: string }[];
    expect(preserved.map((row) => row.source_table)).toEqual(
      expect.arrayContaining(["orchestration_runs", "decisions", "actions", "observations"]),
    );
    expect(
      JSON.parse(preserved.find((row) => row.source_table === "actions")!.row_json).status,
    ).toBe("accepted");
    expect(setup.journal.hasRun(setup.run.runId)).toBe(false);
  });
});
