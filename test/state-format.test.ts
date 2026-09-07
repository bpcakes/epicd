import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
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
  it("creates the current schema once and reopens current runs without rewriting their state", () => {
    const { root, path } = fixture();
    const store = new StateStore(path);
    cleanups.push(() => store.close());
    const run = store.createAdaptive(
      initialRun(),
      RepositoryPolicySchema.parse({ schemaVersion: 1 }),
    );
    const db = new Database(path);
    cleanups.push(() => db.close());
    const before = db.prepare("SELECT * FROM runs").all();
    const reopened = new StateStore(path);
    cleanups.push(() => reopened.close());
    expect(reopened.get(run.runId)).toEqual(run);
    expect(reopened.orchestration.policy(run.runId).coordinator.model).toBe("gpt-6-astra");
    expect(db.prepare("SELECT * FROM runs").all()).toEqual(before);
    expect(db.prepare("SELECT version FROM orchestration_schema").all()).toEqual([{ version: 13 }]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'diagnostic_artifacts'").get(),
    ).toBeDefined();
    expect(readdirSync(root).some((name) => name.includes("before-orchestration"))).toBe(false);
  });

  it.each([
    { label: "unmarked", versions: null },
    { label: "empty marker", versions: [] },
    { label: "older format", versions: [12] },
    { label: "newer format", versions: [14] },
    { label: "multiple format markers", versions: [12, 13] },
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
    const state = store.createAdaptive(
      initialRun(),
      RepositoryPolicySchema.parse({ schemaVersion: 1 }),
    );
    const db = new Database(path);
    cleanups.push(() => db.close());
    db.prepare("DELETE FROM orchestration_runs WHERE run_id = ?").run(state.runId);
    expect(() => store.acquireLease(state.runId)).toThrow("Persisted state");
  });
});
