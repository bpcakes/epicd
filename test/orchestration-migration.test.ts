import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { RunStateSchema } from "../src/domain/types.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const roots: string[] = [];
const stores: StateStore[] = [];
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "epicd-orchestration-migration-"));
  roots.push(root);
  return { root, path: join(root, "state.sqlite3") };
}

describe("orchestration storage migration", () => {
  it("takes a SQLite snapshot of committed WAL state before forward migration", () => {
    const { root, path } = fixture();
    const old = new Database(path);
    databases.push(old);
    old.pragma("journal_mode=WAL");
    old.exec(
      "CREATE TABLE runs(run_id TEXT PRIMARY KEY, repo_path TEXT NOT NULL, epic_id TEXT NOT NULL, phase TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT",
    );
    const legacy = initialRun("legacy");
    old
      .prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        legacy.runId,
        legacy.repoPath,
        legacy.epicId,
        legacy.phase,
        JSON.stringify(legacy),
        legacy.createdAt,
        legacy.updatedAt,
      );
    const store = new StateStore(path);
    stores.push(store);
    expect(store.get(legacy.runId)).toMatchObject({ stateSchemaVersion: 1, model: "worker-model" });
    expect(store.orchestration.hasRun(legacy.runId)).toBe(false);
    const backups = readdirSync(root).filter((name) => name.includes(".before-orchestration-"));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(root, backups[0]!), { readonly: true });
    databases.push(backup);
    expect(
      backup.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(legacy.runId),
    ).toEqual({ state_json: JSON.stringify(legacy) });
    expect(
      backup.prepare("SELECT 1 FROM sqlite_master WHERE name = 'orchestration_runs'").get(),
    ).toBeUndefined();
    if (process.platform !== "win32")
      expect(statSync(join(root, backups[0]!)).mode & 0o777).toBe(0o600);
    const reopened = new StateStore(path);
    stores.push(reopened);
    expect(
      readdirSync(root).filter((name) => name.includes(".before-orchestration-")),
    ).toHaveLength(1);
  });

  it("requires a version-2 adaptive marker, confined access, and the explicit Astra contract", () => {
    const { path } = fixture();
    const store = new StateStore(path);
    stores.push(store);
    const input = initialRun();
    const run = store.createAdaptive(input, RepositoryPolicySchema.parse({ schemaVersion: 1 }));
    expect(run).toMatchObject({
      stateSchemaVersion: 2,
      orchestrationMode: "adaptive",
      agentSettings: { orchestrator: { model: "gpt-6-astra" } },
    });
    expect(store.orchestration.policy(run.runId).coordinator.model).toBe("gpt-6-astra");
    expect(() => RunStateSchema.parse({ ...run, stateSchemaVersion: 1 })).toThrow("version 2");
    expect(() => RunStateSchema.parse({ ...run, agentAccessMode: "danger-full-access" })).toThrow(
      "confined access",
    );
    expect(() => store.save(run)).toThrow("legacy state snapshot");
  });

  it("rejects a future database schema without rewriting it", () => {
    const { path } = fixture();
    const store = new StateStore(path);
    stores.push(store);
    const database = new Database(path);
    databases.push(database);
    database.exec("UPDATE orchestration_schema SET version = 7");
    expect(() => new StateStore(path)).toThrow("different Epicd schema version");
    expect(database.prepare("SELECT version FROM orchestration_schema").get()).toEqual({
      version: 7,
    });
  });

  it("detects a dropped adaptive marker instead of exposing the run as legacy", () => {
    const { path } = fixture();
    const store = new StateStore(path);
    stores.push(store);
    const state = store.createAdaptive(
      initialRun(),
      RepositoryPolicySchema.parse({ schemaVersion: 1 }),
    );
    const database = new Database(path);
    databases.push(database);
    database
      .prepare("UPDATE runs SET state_json = ? WHERE run_id = ?")
      .run(
        JSON.stringify({ ...state, stateSchemaVersion: 1, orchestrationMode: "legacy" }),
        state.runId,
      );
    expect(() => store.acquireLease(state.runId)).toThrow("Persisted state");
    expect(store.inspectCurrent(state.repoPath, state.epicId)?.kind).toBe("invalid");
  });
});
