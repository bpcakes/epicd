import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  RunAlreadyControlledError,
  RunNotFoundError,
  RunStateDecodeError,
  runStateDecodeDetail,
  StateStore,
  unsupportedRunStateVersion,
} from "../src/adapters/store.js";
import {
  createInactiveAgentSessions,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_AGENT_PREFERENCES,
  prepareRunStateForControl,
  RunStateSchema,
  type RunState,
} from "../src/domain/types.js";
import { humanRunStatus, RunStatusV1Schema, runStatusView } from "../src/status.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function state(runId: string, epicId = "epic-1"): RunState {
  const now = new Date().toISOString();
  return {
    stateSchemaVersion: 1,
    runId,
    agentNamespace: "0123456789abcdef0123",
    repoPath: "/repo",
    epicId,
    epicTitle: "Test epic",
    model: null,
    reasoningEffort: null,
    runtime: "sdk",
    agentSettings: DEFAULT_AGENT_PREFERENCES,
    agentAccessMode: "sandboxed",
    maxReviewPasses: 3,
    phase: "selecting",
    currentBeadId: null,
    currentBeadTitle: null,
    agentSessions: createInactiveAgentSessions(),
    pendingAgentCleanup: [],
    baseRevision: null,
    epicBaseRevision: "abc123",
    candidateRevision: null,
    reviewBaselineFingerprint: null,
    reviewedFingerprint: null,
    reviewedTree: null,
    completedTasks: 0,
    totalTasks: 2,
    reviewPass: 0,
    pendingFindings: [],
    recentOutcomes: [],
    lastReviewSummary: null,
    resumePhase: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("StateStore", () => {
  it("projects a versioned status contract with legacy session aliases", () => {
    const run = state("status-view");
    run.agentSessions.review = {
      status: "active",
      sessionId: "thr-review",
      contract: {
        runtime: "sdk",
        requested: { model: "gpt-review", reasoningEffort: "xhigh" },
        effective: { model: "gpt-review", reasoningEffort: "xhigh" },
      },
    };

    const controllerLease = {
      pid: 12_345,
      leaseId: "00000000-0000-4000-8000-000000000001",
      acquiredAt: "2026-09-01T00:00:00.000Z",
      alive: true,
    };
    const status = runStatusView(run, controllerLease);
    expect(status).toMatchObject({
      schemaVersion: 1,
      agentNamespace: run.agentNamespace,
      reviewThreadId: "thr-review",
      orchestratorThreadId: null,
      agentSessions: { review: { status: "active", sessionId: "thr-review" } },
      baseRevision: run.baseRevision,
      epicBaseRevision: run.epicBaseRevision,
      reviewBaselineFingerprint: run.reviewBaselineFingerprint,
      reviewedFingerprint: run.reviewedFingerprint,
      reviewedTree: run.reviewedTree,
      recentOutcomes: run.recentOutcomes,
      controllerLease,
      agentSettings: {
        orchestrator: { reasoningEffort: "high" },
        implementation: { reasoningEffort: "high" },
        review: { reasoningEffort: "xhigh" },
      },
      agentPreferences: run.agentSettings,
    });
    expect(() => RunStatusV1Schema.parse({ ...status, schemaVersion: 2 })).toThrow();
    expect(
      RunStatusV1Schema.parse({
        ...status,
        controllerLease: { ...controllerLease, leaseId: "opaque-lease-token" },
      }).controllerLease?.leaseId,
    ).toBe("opaque-lease-token");
    expect(humanRunStatus(run, controllerLease)).toContain(
      `controller pid 12345 · lease ${controllerLease.leaseId} · alive`,
    );
  });

  it("surfaces residual errors and session recovery in human status", () => {
    const run = state("status-recovery");
    run.phase = "complete";
    run.lastError = "cleanup completion could not be recorded";
    run.agentSessions.review = {
      status: "unresolved",
      sessionId: "legacy-review",
      settings: DEFAULT_AGENT_SETTINGS.review,
    };

    const status = humanRunStatus(run);

    expect(status).toContain("session recovery: review (unresolved)");
    expect(status).toContain("last error: cleanup completion could not be recorded");
  });

  it("indents multiline errors in human status", () => {
    const run = state("status-multiline-error");
    run.lastError = "first line\nsecond line\nthird line";

    expect(humanRunStatus(run)).toContain(
      "\n  last error: first line\n    second line\n    third line",
    );
  });

  it("defaults legacy persisted runs to the SDK runtime", () => {
    const legacy = { ...state("legacy") } as Record<string, unknown>;
    delete legacy.runtime;
    delete legacy.agentSettings;
    delete legacy.agentAccessMode;
    delete legacy.agentNamespace;
    delete legacy.agentSessions;
    delete legacy.pendingAgentCleanup;
    delete legacy.maxReviewPasses;
    delete legacy.stateSchemaVersion;
    expect(RunStateSchema.parse(legacy).stateSchemaVersion).toBe(1);
    expect(RunStateSchema.parse(legacy).runtime).toBe("sdk");
    expect(RunStateSchema.parse(legacy).agentSettings).toEqual(DEFAULT_AGENT_PREFERENCES);
    expect(RunStateSchema.parse(legacy).agentAccessMode).toBe("sandboxed");
    expect(RunStateSchema.parse(legacy).agentNamespace).toMatch(/^[a-f0-9]{20}$/);
    expect(RunStateSchema.parse(legacy).agentSessions).toEqual(createInactiveAgentSessions());
    expect(RunStateSchema.parse(legacy).pendingAgentCleanup).toEqual([]);
    expect(RunStateSchema.parse(legacy).maxReviewPasses).toBe(5);
    const firstDefaults = RunStateSchema.parse(legacy);
    const secondDefaults = RunStateSchema.parse(legacy);
    expect(firstDefaults.agentSessions).not.toBe(secondDefaults.agentSessions);
    expect(firstDefaults.agentSettings.orchestrator).not.toBe(
      secondDefaults.agentSettings.orchestrator,
    );
  });

  it("rejects persisted state written by an unsupported future schema", () => {
    expect(() =>
      RunStateSchema.parse({ ...state("future-state"), stateSchemaVersion: 3 }),
    ).toThrow();
  });

  it("preserves concrete reasoning from legacy runs as explicit role overrides", () => {
    const legacy = {
      ...state("legacy-reasoning"),
      agentSettings: DEFAULT_AGENT_SETTINGS,
    } as Record<string, unknown>;
    delete legacy.reasoningEffort;

    expect(RunStateSchema.parse(legacy)).toMatchObject({
      reasoningEffort: null,
      agentSettings: DEFAULT_AGENT_SETTINGS,
    });
  });

  it("rejects blank model identifiers at the persisted state boundary", () => {
    expect(() => RunStateSchema.parse({ ...state("blank-model"), model: "" })).toThrow();
    expect(() => RunStateSchema.parse({ ...state("space-model"), model: "   " })).toThrow();
    expect(RunStateSchema.parse({ ...state("trimmed-model"), model: "  gpt-model  " }).model).toBe(
      "gpt-model",
    );
  });

  it("migrates the legacy dangerous permission boolean to a named access mode", () => {
    const legacy = { ...state("legacy-danger") } as Record<string, unknown>;
    delete legacy.agentAccessMode;
    legacy.dangerouslyBypassApprovalsAndSandbox = true;

    expect(RunStateSchema.parse(legacy).agentAccessMode).toBe("danger-full-access");
  });

  it("decodes an unpinned legacy SDK session without applying a state transition", () => {
    const legacy = { ...state("legacy-unresolved-session") } as Record<string, unknown>;
    delete legacy.agentSessions;
    legacy.implementationThreadId = "thr-implementation";

    const migrated = RunStateSchema.parse(legacy);
    expect(migrated.agentSessions.implementation).toEqual({
      status: "unresolved",
      sessionId: "thr-implementation",
      settings: { model: null, reasoningEffort: "high" },
    });
    expect(migrated.pendingAgentCleanup).toEqual([]);

    const controlled = prepareRunStateForControl(migrated);
    expect(controlled.agentSessions.implementation).toEqual({ status: "inactive" });
    expect(controlled.pendingAgentCleanup).toContainEqual({
      kind: "session",
      runtime: "sdk",
      role: "implementation",
      sessionId: "thr-implementation",
      reason: "unverifiable-session-contract",
    });
  });

  it("rotates a locally persisted unresolved SDK session only for a controller", () => {
    const persisted = state("persisted-unresolved-session");
    (persisted.agentSessions as Record<string, unknown>).review = {
      status: "unresolved",
      sessionId: "thr-review",
      settings: DEFAULT_AGENT_SETTINGS.review,
    };

    const decoded = RunStateSchema.parse(persisted);
    expect(decoded.agentSessions.review).toMatchObject({
      status: "unresolved",
      sessionId: "thr-review",
    });
    expect(decoded.pendingAgentCleanup).toEqual([]);

    const migrated = prepareRunStateForControl(decoded);
    expect(migrated.agentSessions.review).toEqual({ status: "inactive" });
    expect(migrated.pendingAgentCleanup).toContainEqual({
      kind: "session",
      runtime: "sdk",
      role: "review",
      sessionId: "thr-review",
      reason: "unverifiable-session-contract",
    });
  });

  it("turns terminal legacy sessions into durable cleanup work", () => {
    const completed = state("completed-legacy-session");
    completed.phase = "complete";
    completed.agentSessions.review = {
      status: "unresolved",
      sessionId: "thr-completed-review",
      settings: { model: null, reasoningEffort: "xhigh" },
    };

    const controlled = prepareRunStateForControl(completed);

    expect(controlled.agentSessions.review).toEqual({ status: "inactive" });
    expect(controlled.pendingAgentCleanup).toContainEqual({
      kind: "session",
      runtime: "sdk",
      role: "review",
      sessionId: "thr-completed-review",
      reason: "unverifiable-session-contract",
    });
  });

  it("migrates legacy pinned settings into one atomic active-session record", () => {
    const legacy = { ...state("legacy-active-session") } as Record<string, unknown>;
    delete legacy.agentSessions;
    legacy.reviewThreadId = "thr-review";
    legacy.activeAgentSettings = {
      orchestrator: null,
      implementation: null,
      review: { model: "gpt-pinned", reasoningEffort: "xhigh" },
    };
    expect(RunStateSchema.parse(legacy).agentSessions.review).toEqual({
      status: "active",
      sessionId: "thr-review",
      contract: {
        runtime: "sdk",
        requested: { model: "gpt-pinned", reasoningEffort: "xhigh" },
        effective: { model: "gpt-pinned", reasoningEffort: "xhigh" },
      },
    });
  });

  it("migrates the intermediate active-session shape into an explicit contract", () => {
    const persisted = state("intermediate-session") as unknown as Record<string, unknown>;
    const sessions = structuredClone(persisted.agentSessions) as Record<string, unknown>;
    sessions.review = {
      status: "active",
      sessionId: "thr-review",
      settings: { model: "gpt-pinned", reasoningEffort: "xhigh" },
    };
    persisted.agentSessions = sessions;

    expect(RunStateSchema.parse(persisted).agentSessions.review).toEqual({
      status: "active",
      sessionId: "thr-review",
      contract: {
        runtime: "sdk",
        requested: { model: "gpt-pinned", reasoningEffort: "xhigh" },
        effective: { model: "gpt-pinned", reasoningEffort: "xhigh" },
      },
    });
  });

  it("migrates pre-runtime session contracts into runtime-discriminated contracts", () => {
    const persisted = state("pre-runtime-contract") as unknown as Record<string, unknown>;
    const sessions = structuredClone(persisted.agentSessions) as Record<string, unknown>;
    sessions.review = {
      status: "active",
      sessionId: "thr-review",
      contract: {
        requested: { model: "gpt-pinned", reasoningEffort: "xhigh" },
        effective: { model: "gpt-pinned", reasoningEffort: "xhigh" },
      },
    };
    persisted.agentSessions = sessions;

    expect(RunStateSchema.parse(persisted).agentSessions.review).toMatchObject({
      status: "active",
      contract: { runtime: "sdk" },
    });
  });

  it("rejects active session contracts for a different runtime", () => {
    const persisted = state("runtime-mismatch") as unknown as Record<string, unknown>;
    const sessions = structuredClone(persisted.agentSessions) as Record<string, unknown>;
    sessions.review = {
      status: "active",
      sessionId: "agent-review",
      contract: {
        runtime: "herdr",
        requested: { model: null, reasoningEffort: "xhigh" },
        effective: { model: null, reasoningEffort: "xhigh" },
      },
    };
    persisted.agentSessions = sessions;

    expect(() => RunStateSchema.parse(persisted)).toThrow("session runtime must match");
  });

  it("rejects unresolved SDK compatibility state on a Herdr run", () => {
    const persisted = state("unresolved-runtime-mismatch") as unknown as Record<string, unknown>;
    persisted.runtime = "herdr";
    const sessions = structuredClone(persisted.agentSessions) as Record<string, unknown>;
    sessions.review = {
      status: "unresolved",
      sessionId: "thr-review",
      settings: { model: null, reasoningEffort: "xhigh" },
    };
    persisted.agentSessions = sessions;

    expect(() => RunStateSchema.parse(persisted)).toThrow(
      "unresolved sessions are valid only for the SDK runtime",
    );
  });

  it("rejects an SDK contract without a concrete effective model", () => {
    const persisted = state("sdk-model-null") as unknown as Record<string, unknown>;
    const sessions = structuredClone(persisted.agentSessions) as Record<string, unknown>;
    sessions.review = {
      status: "active",
      sessionId: "thr-review",
      contract: {
        runtime: "sdk",
        requested: { model: null, reasoningEffort: "xhigh" },
        effective: { model: null, reasoningEffort: "xhigh" },
      },
    };
    persisted.agentSessions = sessions;

    expect(() => RunStateSchema.parse(persisted)).toThrow();
  });

  it("persists recovery-critical state and ordered UI events", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const run = state("run-1");
    store.create(run);
    run.phase = "implementing";
    run.currentBeadId = "epic-1.1";
    run.baseRevision = "abc123";
    run.agentSessions.implementation = {
      status: "active",
      sessionId: "thr-implementation",
      contract: {
        runtime: "sdk",
        requested: { model: "gpt-pinned", reasoningEffort: "high" },
        effective: { model: "gpt-pinned", reasoningEffort: "high" },
      },
    };
    store.save(run);
    store.addEvent(run.runId, "info", "thread.started", "Implementation started");
    store.addEvent(run.runId, "success", "implementation.complete", "Implementation completed");

    expect(store.get("run-1")).toMatchObject({
      phase: "implementing",
      currentBeadId: "epic-1.1",
      agentSessions: {
        implementation: {
          status: "active",
          sessionId: "thr-implementation",
          contract: {
            effective: { model: "gpt-pinned", reasoningEffort: "high" },
          },
        },
      },
    });
    for (const recovered of [
      store.findLatest("/repo", "epic-1"),
      store.findActive("/repo"),
      store.list("/repo")[0],
    ]) {
      expect(recovered).toMatchObject({
        runId: "run-1",
        phase: "implementing",
        runtime: "sdk",
        agentSettings: DEFAULT_AGENT_PREFERENCES,
        agentAccessMode: "sandboxed",
        maxReviewPasses: 3,
      });
    }
    expect(store.events("run-1").map((event) => event.kind)).toEqual([
      "thread.started",
      "implementation.complete",
    ]);
    const database = new Database(path, { readonly: true });
    const row = database.prepare("SELECT state_json FROM runs WHERE run_id = ?").get("run-1") as {
      state_json: string;
    };
    const persisted = JSON.parse(row.state_json) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("implementationThreadId");
    expect(persisted).not.toHaveProperty("orchestratorThreadId");
    expect(persisted).not.toHaveProperty("reviewThreadId");
    database.close();
    store.close();
  });

  it("keeps strict and diagnostic row selectors aligned", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    const completed = state("completed-row", "epic-completed");
    completed.phase = "complete";
    completed.createdAt = "2026-01-01T00:00:00.000Z";
    completed.updatedAt = completed.createdAt;
    const active = state("active-row", "epic-active");
    active.createdAt = "2026-01-02T00:00:00.000Z";
    active.updatedAt = active.createdAt;
    store.create(completed);
    store.create(active);

    expect(store.findLatest("/repo", completed.epicId)?.runId).toBe(completed.runId);
    expect(store.inspectLatest("/repo", completed.epicId)).toMatchObject({
      kind: "valid",
      state: { runId: completed.runId },
    });
    expect(store.findActive("/repo")?.runId).toBe(active.runId);
    expect(store.inspectWorkflowOwner("/repo")).toMatchObject({
      kind: "valid",
      state: { runId: active.runId },
    });
    expect(store.list("/repo").map((run) => run.runId)).toEqual(
      store
        .inspect("/repo")
        .map((inspection) => (inspection.kind === "valid" ? inspection.state.runId : null)),
    );
    store.close();
  });

  it("requires the active controller lease for controller event writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    const run = state("leased-events");
    store.create(run);
    const lease = store.acquireLease(run.runId);

    store.addEventWithLease(
      run.runId,
      lease.ownerToken,
      "info",
      "controller.active",
      "Controller owns this event",
    );
    store.releaseLease(run.runId, lease.ownerToken);
    expect(() =>
      store.addEventWithLease(
        run.runId,
        lease.ownerToken,
        "warning",
        "controller.stale",
        "Stale controller event",
      ),
    ).toThrow("not controlled by this epicd process");
    expect(store.events(run.runId).map((event) => event.kind)).toEqual(["controller.active"]);
    store.close();
  });

  it("rejects unleased event writes through another connection until the controller releases", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const owner = new StateStore(path);
    const other = new StateStore(path);
    const run = state("foreign-events");
    try {
      owner.create(run);
      const lease = owner.acquireLease(run.runId);
      expect(() =>
        other.addEvent(run.runId, "warning", "run.pause_requested", "Foreign pause request"),
      ).toThrow(RunAlreadyControlledError);
      expect(owner.events(run.runId)).toEqual([]);
      expect(owner.controllerLease(run.runId)?.leaseId).toBe(lease.leaseId);

      owner.addEventWithLease(run.runId, lease.ownerToken, "info", "controller.active", "Owned");
      owner.releaseLease(run.runId, lease.ownerToken);
      other.addEvent(run.runId, "info", "admin.event", "Unleased");
      expect(owner.events(run.runId).map((event) => event.kind)).toEqual([
        "controller.active",
        "admin.event",
      ]);
    } finally {
      other.close();
      owner.close();
    }
  });

  it("reclaims a stale lease atomically with an unleased event write", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    const database = new Database(path);
    const run = state("stale-event-lease");
    try {
      store.create(run);
      database
        .prepare(
          `INSERT INTO run_leases(run_id, owner_token, lease_id, pid, acquired_at)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run(run.runId, "dead-owner", "dead-lease", 2_147_483_647, new Date().toISOString());
      database.exec(`CREATE TRIGGER reject_event BEFORE INSERT ON events
        BEGIN SELECT RAISE(ABORT, 'event write failed'); END`);

      expect(() => store.addEvent(run.runId, "info", "admin.event", "Unleased")).toThrow(
        "event write failed",
      );
      expect(store.controllerLease(run.runId)?.leaseId).toBe("dead-lease");
      expect(store.events(run.runId)).toEqual([]);

      database.exec("DROP TRIGGER reject_event");
      store.addEvent(run.runId, "info", "admin.event", "Unleased");
      expect(store.controllerLease(run.runId)).toBeNull();
      expect(store.events(run.runId).map((event) => event.kind)).toEqual(["admin.event"]);
    } finally {
      database.close();
      store.close();
    }
  });

  it("rejects persisted phases that are missing their recovery-critical fields", () => {
    const invalid = {
      ...state("invalid"),
      phase: "reviewing",
      currentBeadId: "epic-1.1",
    };

    expect(() => RunStateSchema.parse(invalid)).toThrow("baseRevision");
  });

  it("rejects a session that is both active and pending cleanup", () => {
    const invalid = state("invalid-cleanup");
    invalid.agentSessions.review = {
      status: "active",
      sessionId: "thr-review",
      contract: {
        runtime: "sdk",
        requested: { model: "gpt-review", reasoningEffort: "xhigh" },
        effective: { model: "gpt-review", reasoningEffort: "xhigh" },
      },
    };
    invalid.pendingAgentCleanup = [
      { kind: "session", runtime: "sdk", role: "review", sessionId: "thr-review" },
    ];

    expect(() => RunStateSchema.parse(invalid)).toThrow(
      "a session cannot be active and pending cleanup at the same time",
    );
  });

  it("rejects incomplete active-session metadata", () => {
    const invalid = state("invalid-active-session") as unknown as Record<string, unknown>;
    const sessions = structuredClone(invalid.agentSessions) as Record<string, unknown>;
    sessions.review = {
      status: "active",
      contract: {
        requested: { model: "gpt-review", reasoningEffort: "xhigh" },
        effective: { model: "gpt-review", reasoningEffort: "xhigh" },
      },
    };
    invalid.agentSessions = sessions;

    expect(() => RunStateSchema.parse(invalid)).toThrow();
  });

  it("prevents two non-complete controllers from owning the same repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    store.create(state("run-1"));
    expect(() => store.create(state("run-2", "epic-2"))).toThrow("already owned by epic-1");
    const first = store.get("run-1");
    if (!first) throw new Error("missing first run");
    first.phase = "complete";
    store.save(first);
    expect(() => store.create(state("run-2", "epic-2"))).not.toThrow();
    store.close();
  });

  it("classifies lease contention, missing runs, and invalid persisted state", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    store.create(state("leased"));
    const lease = store.acquireLease("leased");
    expect(() => store.acquireLease("leased")).toThrow(RunAlreadyControlledError);
    store.releaseLease("leased", lease.ownerToken);
    expect(() => store.acquireLease("missing")).toThrow(RunNotFoundError);

    const database = new Database(path);
    database.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run("{", "leased");
    database.close();
    expect(() => store.acquireLease("leased")).toThrow(RunStateDecodeError);
    store.close();
  });

  it("isolates an invalid row while inspecting repository status", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    const valid = state("valid-status", "epic-valid");
    valid.phase = "complete";
    store.create(valid);
    store.create(state("invalid-status", "epic-invalid"));
    const database = new Database(path);
    database.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run("{", "invalid-status");
    database.close();

    const inspected = store.inspect("/repo");
    expect(inspected).toHaveLength(2);
    expect(inspected).toContainEqual({ kind: "valid", state: RunStateSchema.parse(valid) });
    expect(inspected).toContainEqual(
      expect.objectContaining({
        kind: "invalid",
        runId: "invalid-status",
        epicId: "epic-invalid",
        error: expect.any(RunStateDecodeError),
      }),
    );
    expect(() => store.list("/repo")).toThrow(RunStateDecodeError);
    store.close();
  });

  it("atomically quarantines invalid state and its events without requiring a valid row", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    const invalid = state("invalid-quarantine");
    store.create(invalid);
    store.addEvent(invalid.runId, "warning", "test.invalid", "Preserve this event");
    const database = new Database(path);
    database.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run("{", invalid.runId);
    database.close();

    const result = store.quarantineInvalidRun(invalid.runId);

    expect(result).toMatchObject({
      runId: invalid.runId,
      repoPath: invalid.repoPath,
      epicId: invalid.epicId,
      recordedPhase: invalid.phase,
      reason: expect.stringContaining("JSON"),
    });
    expect(store.get(invalid.runId)).toBeNull();
    const archived = new Database(path, { readonly: true });
    expect(
      archived
        .prepare("SELECT state_json, reason, quarantined_at FROM quarantined_runs WHERE run_id = ?")
        .get(invalid.runId),
    ).toMatchObject({
      state_json: "{",
      reason: result.reason,
      quarantined_at: result.quarantinedAt,
    });
    expect(
      archived
        .prepare("SELECT kind, message FROM quarantined_events WHERE run_id = ?")
        .all(invalid.runId),
    ).toEqual([{ kind: "test.invalid", message: "Preserve this event" }]);
    archived.close();
    expect(() => store.create(state("replacement-after-quarantine", "epic-2"))).not.toThrow();
    store.close();
  });

  it("refuses to quarantine state written by a newer Epicd schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    const future = state("future-quarantine");
    store.create(future);
    const database = new Database(path);
    database
      .prepare("UPDATE runs SET state_json = ? WHERE run_id = ?")
      .run(JSON.stringify({ ...future, stateSchemaVersion: 3 }), future.runId);
    database.close();

    const inspected = store.inspectCurrent(future.repoPath, future.epicId);
    expect(inspected).toMatchObject({ kind: "invalid", runId: future.runId });
    if (inspected?.kind !== "invalid") throw new Error("expected newer-schema state");
    expect(unsupportedRunStateVersion(inspected.error)).toBe(3);
    expect(runStateDecodeDetail(inspected.error)).toContain("requires a newer Epicd");
    expect(() => store.quarantineInvalidRun(future.runId)).toThrow(
      "upgrade Epicd instead of quarantining",
    );
    expect(store.inspectCurrent(future.repoPath, future.epicId)).toMatchObject({
      kind: "invalid",
      runId: future.runId,
    });
    expect(() => store.create(state("replacement-after-future-state", "epic-2"))).toThrow(
      "occupied by invalid active run future-quarantine",
    );
    store.close();
  });

  it("quarantines only invalid runs without a live controller", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    const valid = state("valid-quarantine");
    store.create(valid);
    expect(() => store.quarantineInvalidRun(valid.runId)).toThrow("has valid persisted state");

    const lease = store.acquireLease(valid.runId);
    const database = new Database(path);
    database.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run("{", valid.runId);
    database.close();
    expect(() => store.quarantineInvalidRun(valid.runId)).toThrow(RunAlreadyControlledError);
    store.releaseLease(valid.runId, lease.ownerToken);
    expect(() => store.quarantineInvalidRun(valid.runId)).not.toThrow();
    store.close();
  });

  it("inspects only the newest row for scoped status", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    const older = state("older-status");
    older.phase = "complete";
    older.createdAt = "2026-01-01T00:00:00.000Z";
    older.updatedAt = older.createdAt;
    const latest = state("latest-status");
    latest.phase = "complete";
    latest.createdAt = "2026-01-02T00:00:00.000Z";
    latest.updatedAt = latest.createdAt;
    store.create(older);
    store.create(latest);
    const database = new Database(path);
    database.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run("{", older.runId);
    database.close();

    expect(store.inspectLatest("/repo", "epic-1")).toEqual({
      kind: "valid",
      state: RunStateSchema.parse(latest),
    });
    store.close();
  });

  it("keeps older cleanup reachable without blocking a different epic", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    const recoverable = state("older-cleanup");
    recoverable.phase = "complete";
    recoverable.createdAt = "2026-01-01T00:00:00.000Z";
    recoverable.updatedAt = recoverable.createdAt;
    const latest = state("latest-clean", "epic-1");
    latest.phase = "complete";
    latest.createdAt = "2026-01-02T00:00:00.000Z";
    latest.updatedAt = latest.createdAt;
    store.create(recoverable);
    store.create(latest);

    recoverable.pendingAgentCleanup = [{ kind: "run", runtime: "herdr" }];
    const database = new Database(path);
    database
      .prepare("UPDATE runs SET state_json = ? WHERE run_id = ?")
      .run(JSON.stringify(recoverable), recoverable.runId);
    database.close();

    expect(store.inspectRecoverable("/repo", "epic-1")).toEqual({
      kind: "valid",
      state: RunStateSchema.parse(recoverable),
    });
    expect(store.inspectCurrent("/repo", "epic-1")).toEqual({
      kind: "valid",
      state: RunStateSchema.parse(recoverable),
    });
    expect(() => store.create(state("replacement-run", "epic-1"))).toThrow(
      "still has agent cleanup or session recovery",
    );
    expect(() => store.create(state("competing-run", "epic-2"))).not.toThrow();
    store.close();
  });

  it("fails closed on an invalid completed row when replacing the same epic", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    const invalid = state("invalid-completed");
    invalid.phase = "complete";
    store.create(invalid);
    const database = new Database(path);
    database.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run("{", invalid.runId);
    database.close();

    expect(store.inspectRecoverable("/repo", "epic-1")).toMatchObject({
      kind: "invalid",
      runId: invalid.runId,
    });
    expect(store.inspectCurrent("/repo", "epic-1")).toMatchObject({
      kind: "invalid",
      runId: invalid.runId,
    });
    expect(() => store.create(state("same-epic", "epic-1"))).toThrow(
      "has unresolved invalid run invalid-completed",
    );
    expect(() => store.create(state("other-epic", "epic-2"))).not.toThrow();
    store.close();
  });

  it("abandons cleanup explicitly only for completed unleased runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    const completed = state("abandon-cleanup");
    completed.phase = "complete";
    completed.pendingAgentCleanup = [{ kind: "run", runtime: "herdr" }];
    completed.lastError = "cleanup controller failed";
    store.create(completed);

    const abandoned = store.abandonAgentCleanup(completed.runId);

    expect(abandoned.abandonedActions).toBe(1);
    expect(abandoned.state.pendingAgentCleanup).toEqual([]);
    expect(abandoned.state.lastError).toBeNull();
    expect(store.events(completed.runId)).toContainEqual(
      expect.objectContaining({
        level: "warning",
        kind: "agent.cleanup_abandoned",
        message: "Abandoned 1 agent cleanup action(s)",
        detail: "External agent resources may remain open",
      }),
    );
    expect(store.inspectRecoverable("/repo", "epic-1")).toBeNull();
    expect(() => store.abandonAgentCleanup(completed.runId)).toThrow("no pending agent cleanup");
    store.close();
  });

  it("abandons a completed cleanup diagnostic after all resource actions finished", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    const completed = state("abandon-cleanup-diagnostic");
    completed.phase = "complete";
    completed.lastError = "cleanup completion could not be recorded";
    store.create(completed);
    expect(() => store.create(state("replacement", completed.epicId))).toThrow(
      `has a saved diagnostic in completed run ${completed.runId}`,
    );
    expect(() => store.create(state("replacement", completed.epicId))).toThrow(
      `epicd cleanup ${completed.runId} --abandon`,
    );

    const abandoned = store.abandonAgentCleanup(completed.runId);

    expect(abandoned).toMatchObject({ abandonedActions: 0, state: { lastError: null } });
    expect(store.inspectRecoverable("/repo", "epic-1")).toBeNull();
    expect(store.events(completed.runId)).toContainEqual(
      expect.objectContaining({
        kind: "agent.cleanup_abandoned",
        message: "Cleared completed cleanup diagnostic",
        detail: null,
      }),
    );
    store.close();
  });

  it("rolls back administrative cleanup when its nested event write fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    const database = new Database(path);
    const completed = state("abandon-event-failure");
    completed.phase = "complete";
    completed.pendingAgentCleanup = [{ kind: "run", runtime: "herdr" }];
    completed.lastError = "cleanup needs attention";
    try {
      store.create(completed);
      const before = store.get(completed.runId);
      database.exec(`CREATE TRIGGER reject_event BEFORE INSERT ON events
        BEGIN SELECT RAISE(ABORT, 'event write failed'); END`);
      expect(() => store.abandonAgentCleanup(completed.runId)).toThrow("event write failed");
      expect(store.get(completed.runId)).toEqual(before);
      expect(store.events(completed.runId)).toEqual([]);

      database.exec("DROP TRIGGER reject_event");
      expect(store.abandonAgentCleanup(completed.runId).abandonedActions).toBe(1);
      expect(store.get(completed.runId)?.pendingAgentCleanup).toEqual([]);
      expect(store.events(completed.runId).map((event) => event.kind)).toEqual([
        "agent.cleanup_abandoned",
      ]);
    } finally {
      database.close();
      store.close();
    }
  });

  it("refuses to abandon cleanup for active or currently controlled runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    const active = state("active-cleanup");
    store.create(active);
    expect(() => store.abandonAgentCleanup(active.runId)).toThrow(
      "cleanup can be abandoned only after completion",
    );

    active.phase = "complete";
    active.pendingAgentCleanup = [{ kind: "run", runtime: "herdr" }];
    store.save(active);
    const lease = store.acquireLease(active.runId);
    expect(() => store.abandonAgentCleanup(active.runId)).toThrow(RunAlreadyControlledError);
    store.releaseLease(active.runId, lease.ownerToken);
    store.close();
  });

  it("keeps a terminal unresolved session reachable for controller migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    const unresolved = state("terminal-unresolved");
    unresolved.phase = "complete";
    unresolved.agentSessions.review = {
      status: "unresolved",
      sessionId: "thr-terminal",
      settings: { model: null, reasoningEffort: "xhigh" },
    };
    store.create(unresolved);

    expect(store.inspectRecoverable("/repo", "epic-1")).toMatchObject({
      kind: "valid",
      state: { runId: unresolved.runId },
    });
    const lease = store.acquireLease(unresolved.runId);
    expect(lease.state).toMatchObject({
      agentSessions: { review: { status: "inactive" } },
      pendingAgentCleanup: [
        {
          kind: "session",
          runtime: "sdk",
          role: "review",
          sessionId: "thr-terminal",
          reason: "unverifiable-session-contract",
        },
      ],
    });
    store.releaseLease(unresolved.runId, lease.ownerToken);
    store.close();
  });

  it.each([
    ["run ID", "runId", "different-run"],
    ["repository path", "repoPath", "/different-repo"],
    ["epic ID", "epicId", "different-epic"],
    ["phase", "phase", "blocked"],
    ["updated timestamp", "updatedAt", "2099-01-01T00:00:00.000Z"],
  ])("rejects drift in the indexed %s", (label, field, driftedValue) => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    const persisted = state(`identity-drift-${field}`);
    store.create(persisted);
    const database = new Database(path);
    database
      .prepare("UPDATE runs SET state_json = ? WHERE run_id = ?")
      .run(JSON.stringify({ ...persisted, [field]: driftedValue }), persisted.runId);
    database.close();

    expect(() => store.get(persisted.runId)).toThrow(RunStateDecodeError);
    const inspected = store.inspect("/repo")[0];
    expect(inspected).toMatchObject({
      kind: "invalid",
      runId: persisted.runId,
    });
    if (inspected?.kind !== "invalid") throw new Error("expected invalid persisted state");
    expect(runStateDecodeDetail(inspected.error)).toContain(label);
    store.close();
  });

  it("refuses to create through an invalid active run with actionable recovery guidance", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    store.create(state("invalid-active"));
    const database = new Database(path);
    database.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run("{", "invalid-active");
    database.close();

    expect(() => store.create(state("replacement", "epic-2"))).toThrow(
      "occupied by invalid active run invalid-active; inspect it with epicd status",
    );
    store.close();
  });

  it("leases a run to only one live controller process", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    store.create(state("run-1"));
    const lease = store.acquireLease("run-1");
    expect(store.controllerLease("run-1")).toMatchObject({
      pid: process.pid,
      leaseId: lease.leaseId,
      alive: true,
    });
    expect(lease.state).toMatchObject({ runId: "run-1", totalTasks: 2 });
    expect(() => store.acquireLease("run-1")).toThrow("already controlled");
    const run = store.get("run-1");
    if (!run) throw new Error("missing leased run");
    run.totalTasks = 5;
    expect(() => store.save(run)).toThrow(RunAlreadyControlledError);
    expect(() => store.saveWithLease(run, "wrong-owner")).toThrow("not controlled");
    expect(store.get("run-1")?.totalTasks).toBe(2);
    store.saveWithLease(run, lease.ownerToken);
    expect(store.get("run-1")?.totalTasks).toBe(5);
    store.releaseLease("run-1", lease.ownerToken);
    expect(store.controllerLease("run-1")).toBeNull();
    const replacement = store.acquireLease("run-1");
    expect(replacement.ownerToken).not.toBe(lease.ownerToken);
    store.releaseLease("run-1", replacement.ownerToken);
    store.close();
  });

  it("updates agent settings without persisting a caller's volatile workflow snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    const persisted = state("settings-only");
    store.create(persisted);
    const lease = store.acquireLease(persisted.runId);
    const settings = structuredClone(persisted.agentSettings);
    settings.review = { model: "gpt-review", reasoningEffort: "low" };

    const updated = store.updateAgentSettingsWithLease(persisted.runId, lease.ownerToken, settings);

    expect(updated).toEqual({
      event: expect.objectContaining({ kind: "agent.settings_updated", runId: persisted.runId }),
      agentSettings: settings,
      model: persisted.model,
      reasoningEffort: persisted.reasoningEffort,
      updatedAt: expect.any(String),
    });
    expect(store.get(persisted.runId)).toMatchObject({
      phase: "selecting",
      currentBeadId: null,
      totalTasks: 2,
      agentSettings: updated.agentSettings,
      updatedAt: updated.updatedAt,
    });
    expect(() =>
      store.updateAgentSettingsWithLease(persisted.runId, "wrong-owner", settings),
    ).toThrow("not controlled by this epicd process");
    expect(() => store.updateAgentSettings(persisted.runId, settings)).toThrow(
      RunAlreadyControlledError,
    );
    store.releaseLease(persisted.runId, lease.ownerToken);
    const unleased = store.updateAgentSettings(persisted.runId, settings);
    expect(unleased.agentSettings).toEqual(settings);
    expect(store.controllerLease(persisted.runId)).toBeNull();
    store.close();
  });

  it("rolls back settings when their audit event cannot be written", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    const database = new Database(path);
    const run = state("settings-event-failure");
    try {
      store.create(run);
      const before = store.get(run.runId);
      database.exec(`CREATE TRIGGER reject_settings_event BEFORE INSERT ON events
        WHEN NEW.kind = 'agent.settings_updated'
        BEGIN SELECT RAISE(ABORT, 'settings event failed'); END`);
      const settings = structuredClone(run.agentSettings);
      settings.review.model = "gpt-updated";
      expect(() => store.updateAgentSettings(run.runId, settings)).toThrow("settings event failed");
      expect(store.get(run.runId)).toEqual(before);
      expect(store.events(run.runId)).toEqual([]);
    } finally {
      database.close();
      store.close();
    }
  });

  it.runIf(process.platform === "linux")(
    "reclaims a lease when a live PID belongs to a different process instance",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
      tempDirs.push(dir);
      const path = join(dir, "state.sqlite3");
      const store = new StateStore(path);
      store.create(state("reused-pid"));
      const database = new Database(path);
      database
        .prepare(
          `INSERT INTO run_leases(
             run_id, owner_token, lease_id, pid, acquired_at, process_marker
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "reused-pid",
          "stale-owner",
          "stale-lease",
          process.pid,
          new Date().toISOString(),
          "linux:different-process-instance",
        );
      database.close();

      const replacement = store.acquireLease("reused-pid");
      expect(replacement.ownerToken).not.toBe("stale-owner");
      store.releaseLease("reused-pid", replacement.ownerToken);
      store.close();
    },
  );

  it.runIf(process.platform === "linux")(
    "reclaims a lease recorded by a previous Linux boot",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
      tempDirs.push(dir);
      const path = join(dir, "state.sqlite3");
      const store = new StateStore(path);
      store.create(state("previous-boot"));
      const database = new Database(path);
      database
        .prepare(
          `INSERT INTO run_leases(
             run_id, owner_token, lease_id, pid, acquired_at, process_marker
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "previous-boot",
          "stale-owner",
          "stale-lease",
          process.pid,
          new Date().toISOString(),
          "linux:not-the-current-boot:1",
        );
      database.close();

      const replacement = store.acquireLease("previous-boot");
      expect(replacement.ownerToken).not.toBe("stale-owner");
      store.releaseLease("previous-boot", replacement.ownerToken);
      store.close();
    },
  );

  it("fails closed when a live lease has no platform process marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    store.create(state("marker-unavailable"));
    const database = new Database(path);
    database
      .prepare(
        `INSERT INTO run_leases(
           run_id, owner_token, lease_id, pid, acquired_at, process_marker
         ) VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run("marker-unavailable", "live-owner", "live-lease", process.pid, new Date().toISOString());
    database.close();

    expect(() => store.acquireLease("marker-unavailable")).toThrow(RunAlreadyControlledError);
    expect(store.forceReleaseLease("marker-unavailable", process.pid, "live-lease")).toBe(true);
    store.close();
  });

  it("force-releases only the lease owned by the operator-confirmed PID", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    store.create(state("force-unlock"));
    const lease = store.acquireLease("force-unlock");

    expect(() => store.forceReleaseLease("force-unlock", process.pid + 1, lease.leaseId)).toThrow(
      "lease ownership changed after it was inspected",
    );
    expect(() => store.forceReleaseLease("force-unlock", process.pid, "stale-lease-id")).toThrow(
      "lease ownership changed after it was inspected",
    );
    expect(() => store.acquireLease("force-unlock")).toThrow(RunAlreadyControlledError);
    expect(store.forceReleaseLease("force-unlock", process.pid, lease.leaseId)).toBe(true);
    expect(store.forceReleaseLease("force-unlock", process.pid, lease.leaseId)).toBe(false);
    expect(() => store.forceReleaseLease("missing", process.pid, lease.leaseId)).toThrow(
      RunNotFoundError,
    );
    store.close();
  });

  it("refuses a stale unlock after the same process reacquires the lease", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    store.create(state("reacquired-lease"));
    const first = store.acquireLease("reacquired-lease");
    store.releaseLease("reacquired-lease", first.ownerToken);
    const second = store.acquireLease("reacquired-lease");

    expect(() => store.forceReleaseLease("reacquired-lease", process.pid, first.leaseId)).toThrow(
      "lease ownership changed after it was inspected",
    );
    expect(() => store.acquireLease("reacquired-lease")).toThrow(RunAlreadyControlledError);
    store.releaseLease("reacquired-lease", second.ownerToken);
    store.close();
  });

  it("persists stateful session migration only when a controller acquires the lease", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    const unresolved = state("migration-on-control");
    unresolved.agentSessions.review = {
      status: "unresolved",
      sessionId: "thr-legacy",
      settings: { model: null, reasoningEffort: "xhigh" },
    };
    store.create(unresolved);

    expect(store.get(unresolved.runId)).toMatchObject({
      agentSessions: { review: { status: "unresolved" } },
      pendingAgentCleanup: [],
    });

    const lease = store.acquireLease(unresolved.runId);
    expect(lease.state).toMatchObject({
      agentSessions: { review: { status: "inactive" } },
      pendingAgentCleanup: [
        {
          kind: "session",
          runtime: "sdk",
          role: "review",
          sessionId: "thr-legacy",
          reason: "unverifiable-session-contract",
        },
      ],
    });
    store.releaseLease(unresolved.runId, lease.ownerToken);
    expect(store.get(unresolved.runId)).toMatchObject(lease.state);
    store.close();
  });

  it("updates settings atomically without taking a lease or performing controller migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    const unresolved = state("settings-lease-no-migration");
    unresolved.agentSessions.review = {
      status: "unresolved",
      sessionId: "thr-legacy",
      settings: { model: null, reasoningEffort: "xhigh" },
    };
    store.create(unresolved);

    const settings = structuredClone(unresolved.agentSettings);
    settings.review = { model: "gpt-next", reasoningEffort: null };
    const updated = store.updateAgentSettings(unresolved.runId, settings);
    expect(store.get(unresolved.runId)?.agentSessions.review).toMatchObject({
      status: "unresolved",
      sessionId: "thr-legacy",
    });
    expect(updated.agentSettings).toEqual(settings);
    expect(store.get(unresolved.runId)?.pendingAgentCleanup).toEqual([]);
    expect(store.controllerLease(unresolved.runId)).toBeNull();
    store.close();
  });

  it("removes a dead-process lease before an unleased save", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const store = new StateStore(path);
    const run = state("stale-lease");
    store.create(run);
    const database = new Database(path);
    database
      .prepare(
        `INSERT INTO run_leases(run_id, owner_token, lease_id, pid, acquired_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(run.runId, "dead-owner", "dead-lease", 2_147_483_647, new Date().toISOString());
    database.close();

    run.totalTasks = 7;
    expect(() => store.save(run)).not.toThrow();
    expect(store.get(run.runId)?.totalTasks).toBe(7);
    store.close();
  });

  it("does not mutate caller state when an ordinary save targets an unknown run", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    const missing = state("missing-run");
    const originalUpdatedAt = missing.updatedAt;

    expect(() => store.save(missing)).toThrow("Unknown epicd run missing-run");
    expect(missing.updatedAt).toBe(originalUpdatedAt);
    store.close();
  });

  it("distinguishes a missing leased run from a lease owned by another controller", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    const missing = state("missing-leased-run");

    expect(() => store.saveWithLease(missing, "owner-token")).toThrow(
      "Unknown epicd run missing-leased-run",
    );
    store.close();
  });

  it("reports conflicting active runs when migrating legacy state", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const database = new Database(path);
    database.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        epic_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX runs_active_epic
        ON runs(repo_path, epic_id)
        WHERE phase != 'complete';
    `);
    const insert = database.prepare(
      `INSERT INTO runs(run_id, repo_path, epic_id, phase, state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const run of [state("run-1", "epic-1"), state("run-2", "epic-2")]) {
      insert.run(
        run.runId,
        run.repoPath,
        run.epicId,
        run.phase,
        JSON.stringify(run),
        run.createdAt,
        run.updatedAt,
      );
    }
    database.close();

    expect(() => new StateStore(path)).toThrow("multiple active epics (epic-1,epic-2)");
  });

  it("adds process identity to legacy lease tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const database = new Database(path);
    database.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        epic_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE run_leases (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        owner_token TEXT NOT NULL,
        pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL
      ) STRICT;
    `);
    const legacyRun = state("legacy-lease");
    database
      .prepare(
        `INSERT INTO runs(run_id, repo_path, epic_id, phase, state_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacyRun.runId,
        legacyRun.repoPath,
        legacyRun.epicId,
        legacyRun.phase,
        JSON.stringify(legacyRun),
        legacyRun.createdAt,
        legacyRun.updatedAt,
      );
    database
      .prepare(
        `INSERT INTO run_leases(run_id, owner_token, pid, acquired_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(legacyRun.runId, "legacy-owner", process.pid, new Date().toISOString());
    database.close();

    const store = new StateStore(path);
    const migrated = new Database(path, { readonly: true });
    const columns = migrated.pragma("table_info(run_leases)") as Array<{
      name: string;
      notnull: 0 | 1;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["process_marker", "lease_id"]),
    );
    const migratedLease = migrated
      .prepare("SELECT lease_id FROM run_leases WHERE run_id = ?")
      .get(legacyRun.runId) as { lease_id: string };
    expect(migratedLease.lease_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(columns.find((column) => column.name === "lease_id")?.notnull).toBe(1);
    migrated.close();
    store.close();
  });

  it("backfills null identities before enforcing a legacy nullable lease column", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const path = join(dir, "state.sqlite3");
    const database = new Database(path);
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        epic_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE run_leases (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        owner_token TEXT NOT NULL,
        lease_id TEXT,
        pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        process_marker TEXT
      ) STRICT;
    `);
    const legacyRun = state("nullable-legacy-lease");
    database
      .prepare(
        `INSERT INTO runs(run_id, repo_path, epic_id, phase, state_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacyRun.runId,
        legacyRun.repoPath,
        legacyRun.epicId,
        legacyRun.phase,
        JSON.stringify(legacyRun),
        legacyRun.createdAt,
        legacyRun.updatedAt,
      );
    database
      .prepare(
        `INSERT INTO run_leases(run_id, owner_token, lease_id, pid, acquired_at)
         VALUES (?, ?, NULL, ?, ?)`,
      )
      .run(legacyRun.runId, "legacy-owner", process.pid, new Date().toISOString());
    database.close();

    const store = new StateStore(path);
    const migrated = new Database(path, { readonly: true });
    const columns = migrated.pragma("table_info(run_leases)") as Array<{
      name: string;
      notnull: 0 | 1;
    }>;
    const migratedLease = migrated
      .prepare("SELECT lease_id FROM run_leases WHERE run_id = ?")
      .get(legacyRun.runId) as { lease_id: string };
    expect(migratedLease.lease_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(columns.find((column) => column.name === "lease_id")?.notnull).toBe(1);
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(store.controllerLease(legacyRun.runId)).toMatchObject({
      pid: process.pid,
      alive: true,
    });
    migrated.close();
    store.close();
  });
});
