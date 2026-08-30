import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { StateStore } from "../src/adapters/store.js";
import { DEFAULT_AGENT_SETTINGS, RunStateSchema, type RunState } from "../src/domain/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function state(runId: string, epicId = "epic-1"): RunState {
  const now = new Date().toISOString();
  return {
    runId,
    agentNamespace: "0123456789abcdef0123",
    repoPath: "/repo",
    epicId,
    epicTitle: "Test epic",
    model: null,
    runtime: "sdk",
    agentSettings: DEFAULT_AGENT_SETTINGS,
    agentAccessMode: "sandboxed",
    maxReviewPasses: 3,
    phase: "selecting",
    currentBeadId: null,
    currentBeadTitle: null,
    orchestratorThreadId: null,
    implementationThreadId: null,
    reviewThreadId: null,
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
  it("defaults legacy persisted runs to the SDK runtime", () => {
    const legacy = { ...state("legacy") } as Record<string, unknown>;
    delete legacy.runtime;
    delete legacy.agentSettings;
    delete legacy.agentAccessMode;
    delete legacy.agentNamespace;
    delete legacy.pendingAgentCleanup;
    delete legacy.maxReviewPasses;
    expect(RunStateSchema.parse(legacy).runtime).toBe("sdk");
    expect(RunStateSchema.parse(legacy).agentSettings).toEqual(DEFAULT_AGENT_SETTINGS);
    expect(RunStateSchema.parse(legacy).agentAccessMode).toBe("sandboxed");
    expect(RunStateSchema.parse(legacy).agentNamespace).toMatch(/^[a-f0-9]{20}$/);
    expect(RunStateSchema.parse(legacy).pendingAgentCleanup).toEqual([]);
    expect(RunStateSchema.parse(legacy).maxReviewPasses).toBe(5);
  });

  it("migrates the legacy dangerous permission boolean to a named access mode", () => {
    const legacy = { ...state("legacy-danger") } as Record<string, unknown>;
    delete legacy.agentAccessMode;
    legacy.dangerouslyBypassApprovalsAndSandbox = true;

    expect(RunStateSchema.parse(legacy).agentAccessMode).toBe("danger-full-access");
  });

  it("persists recovery-critical state and ordered UI events", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    expect(statSync(join(dir, "state.sqlite3")).mode & 0o777).toBe(0o600);
    const run = state("run-1");
    store.create(run);
    run.phase = "implementing";
    run.currentBeadId = "epic-1.1";
    run.baseRevision = "abc123";
    run.implementationThreadId = "thr-implementation";
    store.save(run);
    store.addEvent(run.runId, "info", "thread.started", "Implementation started");
    store.addEvent(run.runId, "success", "implementation.complete", "Implementation completed");

    expect(store.get("run-1")).toMatchObject({
      phase: "implementing",
      currentBeadId: "epic-1.1",
      implementationThreadId: "thr-implementation",
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
        agentSettings: DEFAULT_AGENT_SETTINGS,
        agentAccessMode: "sandboxed",
        maxReviewPasses: 3,
      });
    }
    expect(store.events("run-1").map((event) => event.kind)).toEqual([
      "thread.started",
      "implementation.complete",
    ]);
    store.close();
  });

  it("rejects persisted phases that are missing their recovery-critical fields", () => {
    const invalid = {
      ...state("invalid"),
      phase: "reviewing",
      currentBeadId: "epic-1.1",
      implementationThreadId: "thr-implementation",
    };

    expect(() => RunStateSchema.parse(invalid)).toThrow("baseRevision");
  });

  it("rejects a session that is both active and pending cleanup", () => {
    const invalid = state("invalid-cleanup");
    invalid.reviewThreadId = "thr-review";
    invalid.pendingAgentCleanup = [
      { kind: "session", runtime: "sdk", role: "review", sessionId: "thr-review" },
    ];

    expect(() => RunStateSchema.parse(invalid)).toThrow(
      "a session cannot be active and pending cleanup at the same time",
    );
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

  it("leases a run to only one live controller process", () => {
    const dir = mkdtempSync(join(tmpdir(), "epicd-store-"));
    tempDirs.push(dir);
    const store = new StateStore(join(dir, "state.sqlite3"));
    store.create(state("run-1"));
    const lease = store.acquireLease("run-1");
    expect(() => store.acquireLease("run-1")).toThrow("already controlled");
    store.releaseLease("run-1", lease);
    const replacement = store.acquireLease("run-1");
    expect(replacement).not.toBe(lease);
    store.releaseLease("run-1", replacement);
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
});
