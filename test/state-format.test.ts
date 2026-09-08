import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { RunStateSchema, SdkAgentSessionContractSchema } from "../src/domain/types.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-state-format-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite3");
  return { root, path };
}

describe("hard-cut state format", () => {
  it("does not initialize state truncated in place before trusted-worker attachment", () => {
    const { path } = fixture();
    const store = new StateStore(path),
      identity = store.storageIdentity();
    store.close();
    writeFileSync(path, "");
    expect(() => new StateStore(path, identity)).toThrow("cannot initialize empty state");
    expect(readFileSync(path)).toHaveLength(0);
  });
  it.each(["missing", "replaced"])(
    "refuses a %s trusted-worker state file without recreating or initializing it",
    (variant) => {
      const { path } = fixture();
      const store = new StateStore(path),
        identity = store.storageIdentity();
      store.close();
      renameSync(path, `${path}.retained`);
      if (variant === "replaced") writeFileSync(path, "user-owned unrelated file");
      expect(() => new StateStore(path, identity)).toThrow();
      if (variant === "missing") expect(existsSync(path)).toBe(false);
      else expect(readFileSync(path, "utf8")).toBe("user-owned unrelated file");
      expect(existsSync(`${path}.retained`)).toBe(true);
    },
  );
  it("requires persisted fields instead of supplying historical defaults", () => {
    for (const field of [
      "stateSchemaVersion",
      "runtime",
      "reasoningEffort",
      "agentSettings",
      "runtimeConfiguration",
      "epicBaseRevision",
      "runId",
      "repoPath",
      "epicId",
      "model",
      "totalTasks",
      "createdAt",
      "updatedAt",
    ]) {
      const input: Record<string, unknown> = initialRun();
      delete input[field];
      expect(RunStateSchema.safeParse(input).success, field).toBe(false);
      expect(input).not.toHaveProperty(field);
    }
  });

  it("rejects obsolete session contracts instead of inventing settings or a cleanup transition", () => {
    expect(
      SdkAgentSessionContractSchema.safeParse({
        runtime: "sdk",
        requested: { model: null, reasoningEffort: "high" },
        effective: { model: null, reasoningEffort: "high" },
      }).success,
    ).toBe(false);
    for (const alias of [
      "phase",
      "orchestrationMode",
      "agentSessions",
      "pendingAgentCleanup",
      "reviewThreadId",
      "implementationThreadId",
      "orchestratorThreadId",
      "activeAgentSettings",
      "dangerouslyBypassApprovalsAndSandbox",
    ]) {
      expect(
        RunStateSchema.safeParse({ ...initialRun(), [alias]: "obsolete" }).success,
        alias,
      ).toBe(false);
    }
  });

  it.each(["old-version", "session-alias"])(
    "refuses %s persisted JSON on reads and lease acquisition without rewriting it",
    (variant) => {
      const { path } = fixture();
      const store = new StateStore(path);
      cleanups.push(() => store.close());
      const run = store.create(initialRun(), RepositoryPolicySchema.parse({ schemaVersion: 1 }));
      const db = new Database(path);
      cleanups.push(() => db.close());
      const obsolete =
        variant === "old-version"
          ? { ...run, stateSchemaVersion: 1 }
          : { ...run, reviewThreadId: "do-not-revive" };
      const raw = JSON.stringify(obsolete);
      db.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run(raw, run.runId);
      expect(() => store.get(run.runId)).toThrow("Persisted state");
      expect(store.inspect(run.repoPath)[0]?.kind).toBe("invalid");
      expect(() => store.acquireLease(run.runId)).toThrow("Persisted state");
      expect(store.controllerLease(run.runId)).toBeNull();
      expect(db.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(run.runId)).toEqual({
        state_json: raw,
      });
      expect(store.orchestration.agents.turns(run.runId)).toEqual([]);
    },
  );

  it("creates the current schema once and reopens current runs without rewriting their state", () => {
    const { root, path } = fixture();
    const store = new StateStore(path);
    cleanups.push(() => store.close());
    const run = store.create(initialRun(), RepositoryPolicySchema.parse({ schemaVersion: 1 }));
    const db = new Database(path);
    cleanups.push(() => db.close());
    const before = db.prepare("SELECT * FROM runs").all();
    const reopened = new StateStore(path);
    cleanups.push(() => reopened.close());
    expect(reopened.get(run.runId)).toEqual(run);
    expect(reopened.orchestration.policy(run.runId).coordinator.model).toBe("gpt-6-astra");
    expect(db.prepare("SELECT * FROM runs").all()).toEqual(before);
    expect(db.prepare("SELECT version FROM orchestration_schema").all()).toEqual([{ version: 34 }]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'diagnostic_artifacts'").get(),
    ).toBeDefined();
    expect(readdirSync(root).some((name) => name.includes("before-orchestration"))).toBe(false);
  });

  it.each([
    { label: "unmarked", versions: null },
    { label: "empty marker", versions: [] },
    { label: "older format", versions: [23] },
    { label: "previous format without durable repository I/O", versions: [26] },
    { label: "previous format without durable turn usage", versions: [27] },
    { label: "previous format without frozen observation windows", versions: [28] },
    { label: "previous format without fixture SQL-access records", versions: [29] },
    { label: "previous format without frozen diagnostic commands", versions: [30] },
    { label: "previous format without digest-bound action inspection", versions: [31] },
    { label: "previous format without review reference bindings", versions: [32] },
    { label: "previous format without targeted action interruption", versions: [33] },
    { label: "newer format", versions: [35] },
    { label: "previous format without evidence-preserving retirement", versions: [25] },
    { label: "multiple format markers", versions: [26, 27] },
  ])("refuses $label without migration, backups or deletion", ({ versions }) => {
    const { root, path } = fixture();
    const db = new Database(path);
    cleanups.push(() => db.close());
    db.exec(
      "CREATE TABLE retained_work(value TEXT); INSERT INTO retained_work VALUES ('do not delete')",
    );
    if (versions !== null) {
      db.exec("CREATE TABLE orchestration_schema(version INTEGER PRIMARY KEY)");
      for (const version of versions)
        db.prepare("INSERT INTO orchestration_schema VALUES (?)").run(version);
    }
    const before = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    const journalMode = db.pragma("journal_mode", { simple: true });
    expect(() => new StateStore(path)).toThrow("Use a fresh state path");
    expect(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM retained_work").all()).toEqual([{ value: "do not delete" }]);
    expect(db.pragma("journal_mode", { simple: true })).toBe(journalMode);
    expect(readdirSync(root).some((name) => name.includes("before-orchestration"))).toBe(false);
  });

  it("does not disguise a missing current run-control record as a resumable legacy run", () => {
    const { path } = fixture();
    const store = new StateStore(path);
    cleanups.push(() => store.close());
    const state = store.create(initialRun(), RepositoryPolicySchema.parse({ schemaVersion: 1 }));
    const db = new Database(path);
    cleanups.push(() => db.close());
    db.prepare("DELETE FROM orchestration_runs WHERE run_id = ?").run(state.runId);
    expect(() => store.acquireLease(state.runId)).toThrow("Persisted state");
  });
});
