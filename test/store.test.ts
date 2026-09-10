import { fixtureAccounts } from "./fixtures/accounts.js";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  StateStore,
  RunAlreadyControlledError,
  RunStateDecodeError,
} from "../src/adapters/store.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import {
  resolveAgentRoleSettings,
  RunStateSchema,
  RUN_STATE_SCHEMA_VERSION,
  type RunState,
} from "../src/domain/types.js";
import { runStatusView } from "../src/status.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture(overrides: Partial<RunState> = {}) {
  const root = mkdtempSync("/var/tmp/epicd-current-store-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite3"),
    store = new StateStore(path);
  cleanup.push(() => store.close());
  const state = store.create(
    { ...initialRun(), ...overrides },
    RepositoryPolicySchema.parse({ schemaVersion: 1 }),
  );
  const lease = store.acquireLease(state.runId);
  const authority = { runId: state.runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
  return { root, path, store, state, authority, journal: store.orchestration };
}
function database(path: string) {
  const db = new Database(path);
  cleanup.push(() => db.close());
  return db;
}
describe("single-format run ownership and operator controls", () => {
  it("creates private current-format state and preserves immutable identity across settings writes", () => {
    const f = fixture();
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    const settings = structuredClone(f.state.agentSettings);
    settings.review.model = "review-worker";
    f.store.updateAgentSettingsWithLease(f.state.runId, f.authority.ownerToken, settings);
    const state = f.store.get(f.state.runId)!;
    expect(state.repoPath).toBe(f.state.repoPath);
    expect(state.epicBaseRevision).toBe(f.state.epicBaseRevision);
    expect(state.runtimeConfiguration).toBeNull();
    expect(state.agentSettings.review.model).toBe("review-worker");
    expect(resolveAgentRoleSettings(state, "orchestrator")).toEqual({
      model: "gpt-6-astra",
      reasoningEffort: "high",
    });
    expect(f.journal.control(state.runId).controlVersion).toBe(1);
  });
  it("does not expose snapshot saves, conversion, or cleanup-state adapters", () => {
    const f = fixture();
    for (const name of ["save", "saveWithLease", "createAdaptive", "abandonAgentCleanup"])
      expect(f.store).not.toHaveProperty(name);
    expect(RunStateSchema.safeParse({ ...f.state, orchestrationMode: "legacy" }).success).toBe(
      false,
    );
    expect(RunStateSchema.safeParse({ ...f.state, phase: "reviewing" }).success).toBe(false);
  });
  it("preserves live ownership and requires the exact inspected lease to fence it", () => {
    const f = fixture();
    expect(() => f.store.acquireLease(f.state.runId)).toThrow(RunAlreadyControlledError);
    expect(() => f.store.updateAgentSettings(f.state.runId, f.state.agentSettings)).toThrow(
      RunAlreadyControlledError,
    );
    expect(() => f.store.forceReleaseLease(f.state.runId, process.pid, "wrong")).toThrow(
      "ownership changed",
    );
    expect(f.store.forceReleaseLease(f.state.runId, process.pid, f.authority.leaseId)).toBe(true);
    const next = f.store.acquireLease(f.state.runId);
    expect(next.leaseId).not.toBe(f.authority.leaseId);
    expect(() => f.journal.assertAuthority(f.authority)).toThrow("lease");
    f.store.releaseLease(f.state.runId, f.authority.ownerToken);
    expect(f.store.controllerLease(f.state.runId)?.leaseId).toBe(next.leaseId);
  });
  it("records an operator pause without stealing a live controller lease and invalidates stale decisions", () => {
    const f = fixture();
    const ticket = f.journal.beginDecision(f.authority, 0, 0);
    f.journal.operatorControl(f.state.runId, 0, { kind: "pause" });
    expect(f.store.controllerLease(f.state.runId)?.leaseId).toBe(f.authority.leaseId);
    expect(f.journal.control(f.state.runId)).toMatchObject({ status: "paused", controlVersion: 1 });
    expect(
      f.journal.acceptAction(f.authority, {
        explanation: "old decision",
        evidenceIds: [],
        request: {
          schemaVersion: 1,
          decisionId: ticket.decisionId,
          observationCursor: ticket.observationCursor,
          expectedControlVersion: ticket.expectedControlVersion,
          action: { kind: "inspect_run" },
        },
      }).kind,
    ).toBe("rejected");
    expect(() => f.journal.operatorControl(f.state.runId, 0, { kind: "resume" })).toThrow(
      "Control changed",
    );
    f.journal.operatorControl(f.state.runId, 1, { kind: "resume" });
    const db = new Database(f.path);
    try {
      expect(db.prepare("SELECT phase FROM runs").get()).toEqual({ phase: "active" });
    } finally {
      db.close();
    }
  });
  it("requires a correlated response and retains it across reopen without minting a permission grant", () => {
    const f = fixture();
    const escalationId = f.journal.setEscalation(
      f.authority,
      "May I change the scope?",
      "authority",
      [],
    );
    expect(() => f.journal.operatorControl(f.state.runId, 1, { kind: "resume" })).toThrow(
      "pending question",
    );
    expect(() =>
      f.journal.operatorControl(f.state.runId, 1, {
        kind: "respond",
        escalationId: "wrong",
        message: "yes",
      }),
    ).toThrow("Escalation changed");
    f.journal.operatorControl(f.state.runId, 1, {
      kind: "respond",
      escalationId,
      message: "Keep scope; token=private",
    });
    const reopened = new StateStore(f.path);
    cleanup.push(() => reopened.close());
    expect(reopened.orchestration.pendingEscalation(f.state.runId)).toBeNull();
    expect(reopened.orchestration.control(f.state.runId)).toMatchObject({
      status: "active",
      controlVersion: 2,
    });
    const response = reopened.orchestration
      .observations(f.state.runId)
      .find((value) => value.source === "operator");
    expect(response?.summary).toContain(escalationId);
    expect(response?.summary).toContain("no environment or destructive-action grant");
    expect(response?.summary).toContain("token=[REDACTED]");
    expect(JSON.stringify(response)).not.toContain("private");
    expect(() =>
      reopened.orchestration.operatorControl(f.state.runId, 2, {
        kind: "respond",
        escalationId,
        message: "replay",
      }),
    ).toThrow("Escalation changed");
  });
  it("does not let pausing dismiss an unanswered escalation", () => {
    const f = fixture();
    const id = f.journal.setEscalation(f.authority, "Question", "authority", []);
    f.journal.operatorControl(f.state.runId, 1, { kind: "pause" });
    expect(() => f.journal.operatorControl(f.state.runId, 2, { kind: "resume" })).toThrow(
      "pending question",
    );
    expect(runStatusView(f.store, f.state.runId).escalation?.escalationId).toBe(id);
    f.journal.operatorControl(f.state.runId, 2, {
      kind: "respond",
      escalationId: id,
      message: "Continue within scope",
    });
    expect(runStatusView(f.store, f.state.runId).control.status).toBe("active");
  });
  it("retains repository exclusion while paused and rejects invalid coordinator settings atomically", () => {
    const f = fixture();
    f.journal.operatorControl(f.state.runId, 0, { kind: "pause" });
    expect(() =>
      f.store.create({ ...f.state, runId: "second" }, f.journal.policy(f.state.runId)),
    ).toThrow("already owned");
    const before = f.store.get(f.state.runId);
    const preferences = structuredClone(f.state.agentSettings);
    preferences.orchestrator.model = "other-model";
    expect(() =>
      f.store.updateAgentSettingsWithLease(f.state.runId, f.authority.ownerToken, preferences),
    ).toThrow();
    expect(f.store.get(f.state.runId)).toEqual(before);
    expect(f.journal.control(f.state.runId).controlVersion).toBe(1);
  });
  it.each([
    ["runId", "other-run"],
    ["repoPath", "/different/repository"],
    ["epicId", "other-epic"],
    ["updatedAt", "2020-01-01T00:00:00.000Z"],
  ])("rejects a serialized %s mismatch without changing the raw row", (field, value) => {
    const f = fixture();
    const db = database(f.path);
    const raw = JSON.stringify({ ...f.state, [field]: value });
    db.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run(raw, f.state.runId);
    expect(() => f.store.get(f.state.runId)).toThrow(RunStateDecodeError);
    expect(() => f.store.acquireLease(f.state.runId)).toThrow(RunStateDecodeError);
    expect(f.store.inspectWorkflowOwner(f.state.repoPath)?.kind).toBe("invalid");
    expect(db.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(f.state.runId)).toEqual({
      state_json: raw,
    });
    expect(f.store.controllerLease(f.state.runId)?.leaseId).toBe(f.authority.leaseId);
  });
  it("cannot free repository ownership by corrupting its indexed status to complete", () => {
    const f = fixture();
    const db = database(f.path);
    db.prepare("UPDATE runs SET phase = 'complete' WHERE run_id = ?").run(f.state.runId);
    expect(() => f.store.get(f.state.runId)).toThrow(RunStateDecodeError);
    expect(f.store.inspectWorkflowOwner(f.state.repoPath)?.kind).toBe("invalid");
    expect(() =>
      f.store.create({ ...f.state, runId: "replacement" }, f.journal.policy(f.state.runId)),
    ).toThrow("occupied by invalid active run");
  });
  it("rolls back settings, version and audit writes together when audit insertion fails", () => {
    const f = fixture();
    const db = database(f.path);
    const before = db.prepare("SELECT * FROM runs").all();
    const events = db.prepare("SELECT * FROM events").all();
    db.exec(
      "CREATE TRIGGER fail_settings_audit BEFORE INSERT ON events WHEN NEW.kind = 'agent.settings_updated' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    const settings = structuredClone(f.state.agentSettings);
    settings.review.model = "changed-worker";
    expect(() =>
      f.store.updateAgentSettingsWithLease(f.state.runId, f.authority.ownerToken, settings),
    ).toThrow("audit unavailable");
    expect(db.prepare("SELECT * FROM runs").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM events").all()).toEqual(events);
    expect(f.journal.control(f.state.runId).controlVersion).toBe(0);
  });
  it("fences old and unleased event writers without deleting the new owner's lease", () => {
    const f = fixture();
    f.store.forceReleaseLease(f.state.runId, process.pid, f.authority.leaseId);
    const next = f.store.acquireLease(f.state.runId);
    expect(() =>
      f.store.addEventWithLease(
        f.state.runId,
        f.authority.ownerToken,
        "info",
        "old",
        "stale writer",
      ),
    ).toThrow("not controlled by this epicd process");
    expect(() => f.store.addEvent(f.state.runId, "info", "unleased", "unleased writer")).toThrow(
      RunAlreadyControlledError,
    );
    f.store.addEventWithLease(f.state.runId, next.ownerToken, "info", "current", "current writer");
    expect(database(f.path).prepare("SELECT kind FROM events").all()).toEqual([
      { kind: "current" },
    ]);
    expect(f.store.controllerLease(f.state.runId)?.leaseId).toBe(next.leaseId);
  });
  it("treats an unavailable process marker conservatively while the recorded PID is live", () => {
    const f = fixture();
    database(f.path)
      .prepare("UPDATE run_leases SET process_marker = NULL WHERE run_id = ?")
      .run(f.state.runId);
    expect(f.store.controllerLease(f.state.runId)?.alive).toBe(true);
    expect(() => f.store.acquireLease(f.state.runId)).toThrow(RunAlreadyControlledError);
    expect(() => f.store.updateAgentSettings(f.state.runId, f.state.agentSettings)).toThrow(
      RunAlreadyControlledError,
    );
  });
  it("preserves corrupt raw state, events and indexed Git identity on explicit quarantine", () => {
    const common = { path: "/shared/git", device: "12", inode: "34" };
    const f = fixture({
      runtimeConfiguration: {
        commonDirectory: common,
        executable: "/bin/false",
        trackerExecutable: "/bin/false",
        runtimeRoot: "/owned/runtime",
        workspaceRoot: "/owned/workspaces",
        accounts: fixtureAccounts(),
        turnTimeoutMs: 1000,
        herdr: null,
      },
    });
    const db = database(f.path);
    f.store.addEventWithLease(
      f.state.runId,
      f.authority.ownerToken,
      "info",
      "retained",
      "retained event",
    );
    const raw = "{undecodable state";
    db.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run(raw, f.state.runId);
    expect(f.store.inspectWorkflowOwner("/linked/checkout", common)?.kind).toBe("invalid");
    expect(() =>
      f.store.create(
        { ...f.state, runId: "replacement", repoPath: "/linked/checkout" },
        f.journal.policy(f.state.runId),
      ),
    ).toThrow("occupied by invalid active run");
    expect(() => f.store.quarantineInvalidRun(f.state.runId)).toThrow(RunAlreadyControlledError);
    expect(db.prepare("SELECT * FROM quarantined_runs").all()).toEqual([]);
    f.store.releaseLease(f.state.runId, f.authority.ownerToken);
    f.store.quarantineInvalidRun(f.state.runId);
    expect(f.store.get(f.state.runId)).toBeNull();
    expect(
      db
        .prepare(
          "SELECT state_json, common_path, common_device, common_inode FROM quarantined_runs",
        )
        .get(),
    ).toEqual({
      state_json: raw,
      common_path: common.path,
      common_device: common.device,
      common_inode: common.inode,
    });
    expect(db.prepare("SELECT kind, message FROM quarantined_events").all()).toEqual([
      { kind: "retained", message: "retained event" },
    ]);
    expect(
      db
        .prepare(
          "SELECT source_table FROM quarantined_orchestration WHERE source_table = 'orchestration_runs'",
        )
        .all(),
    ).toHaveLength(1);
  });
  it("rejects a version-3 record without rewriting or inferring account selections", () => {
    const f = fixture();
    const db = database(f.path);
    const raw = JSON.stringify({ ...f.state, stateSchemaVersion: 3 });
    db.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run(raw, f.state.runId);
    expect(() => f.store.get(f.state.runId)).toThrow(RunStateDecodeError);
    expect(db.prepare("SELECT state_json FROM runs").get()).toEqual({ state_json: raw });
  });
  it("does not quarantine a future run-state version or rewrite it", () => {
    const f = fixture();
    const db = database(f.path);
    const raw = JSON.stringify({ ...f.state, stateSchemaVersion: RUN_STATE_SCHEMA_VERSION + 1 });
    db.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run(raw, f.state.runId);
    f.store.releaseLease(f.state.runId, f.authority.ownerToken);
    expect(() => f.store.quarantineInvalidRun(f.state.runId)).toThrow("upgrade Epicd");
    expect(db.prepare("SELECT state_json FROM runs").get()).toEqual({ state_json: raw });
    expect(db.prepare("SELECT * FROM quarantined_runs").all()).toEqual([]);
  });
});
