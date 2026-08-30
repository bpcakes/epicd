import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  EngineEventSchema,
  RunStateSchema,
  type EngineEvent,
  type EventLevel,
  type RunState,
} from "../domain/types.js";

type RunRow = { state_json: string };
type EventRow = {
  id: number;
  run_id: string;
  at: string;
  level: string;
  kind: string;
  message: string;
  detail: string | null;
};
type LeaseRow = { owner_token: string; pid: number };

export function defaultStatePath(): string {
  const stateRoot = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateRoot, "epicd", "epicd.sqlite3");
}

export class StateStore {
  readonly path: string;
  private readonly db: Database.Database;

  constructor(path = defaultStatePath()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { timeout: 5_000 });
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.pragma("foreign_keys = ON");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
    for (const databaseFile of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(databaseFile)) chmodSync(databaseFile, 0o600);
    }
  }

  private migrate(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        epic_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        level TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id, id DESC);
      CREATE TABLE IF NOT EXISTS run_leases (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        owner_token TEXT NOT NULL,
        pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL
      ) STRICT;
      `);
      const conflict = this.db
        .prepare(
          `SELECT repo_path, GROUP_CONCAT(epic_id) AS epic_ids
           FROM runs WHERE phase != 'complete'
           GROUP BY repo_path HAVING COUNT(*) > 1
           LIMIT 1`,
        )
        .get() as { repo_path: string; epic_ids: string } | undefined;
      if (conflict) {
        throw new Error(
          `Cannot migrate epicd state: repository ${conflict.repo_path} has multiple active epics (${conflict.epic_ids})`,
        );
      }
      this.db.exec(`
        DROP INDEX IF EXISTS runs_active_epic;
        CREATE UNIQUE INDEX IF NOT EXISTS runs_active_repo
          ON runs(repo_path)
          WHERE phase != 'complete';
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  create(state: RunState): void {
    const parsed = RunStateSchema.parse(state);
    const existing = this.findActive(parsed.repoPath);
    if (existing) throw activeRunError(existing);
    try {
      this.db
        .prepare(
          `INSERT INTO runs(run_id, repo_path, epic_id, phase, state_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.runId,
          parsed.repoPath,
          parsed.epicId,
          parsed.phase,
          JSON.stringify(parsed),
          parsed.createdAt,
          parsed.updatedAt,
        );
    } catch (error) {
      const winner = this.findActive(parsed.repoPath);
      if (winner) throw activeRunError(winner);
      throw error;
    }
  }

  save(state: RunState): void {
    const parsed = RunStateSchema.parse({ ...state, updatedAt: new Date().toISOString() });
    const result = this.db
      .prepare(`UPDATE runs SET phase = ?, state_json = ?, updated_at = ? WHERE run_id = ?`)
      .run(parsed.phase, JSON.stringify(parsed), parsed.updatedAt, parsed.runId);
    if (result.changes !== 1) throw new Error(`Unknown epicd run ${parsed.runId}`);
    Object.assign(state, parsed);
  }

  get(runId: string): RunState | null {
    const row = this.db.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(runId) as
      RunRow | undefined;
    return row ? RunStateSchema.parse(JSON.parse(row.state_json)) : null;
  }

  findLatest(repoPath: string, epicId?: string): RunState | null {
    const row = epicId
      ? (this.db
          .prepare(
            "SELECT state_json FROM runs WHERE repo_path = ? AND epic_id = ? ORDER BY updated_at DESC LIMIT 1",
          )
          .get(repoPath, epicId) as RunRow | undefined)
      : (this.db
          .prepare(
            "SELECT state_json FROM runs WHERE repo_path = ? ORDER BY updated_at DESC LIMIT 1",
          )
          .get(repoPath) as RunRow | undefined);
    return row ? RunStateSchema.parse(JSON.parse(row.state_json)) : null;
  }

  findActive(repoPath: string): RunState | null {
    const row = this.db
      .prepare(
        "SELECT state_json FROM runs WHERE repo_path = ? AND phase != 'complete' ORDER BY updated_at DESC LIMIT 1",
      )
      .get(repoPath) as RunRow | undefined;
    return row ? RunStateSchema.parse(JSON.parse(row.state_json)) : null;
  }

  list(repoPath?: string): RunState[] {
    const rows = repoPath
      ? (this.db
          .prepare("SELECT state_json FROM runs WHERE repo_path = ? ORDER BY updated_at DESC")
          .all(repoPath) as RunRow[])
      : (this.db.prepare("SELECT state_json FROM runs ORDER BY updated_at DESC").all() as RunRow[]);
    return rows.map((row) => RunStateSchema.parse(JSON.parse(row.state_json)));
  }

  addEvent(
    runId: string,
    level: EventLevel,
    kind: string,
    message: string,
    detail: string | null = null,
  ): EngineEvent {
    const event = EngineEventSchema.parse({
      runId,
      at: new Date().toISOString(),
      level,
      kind,
      message,
      detail,
    });
    const result = this.db
      .prepare(
        "INSERT INTO events(run_id, at, level, kind, message, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(event.runId, event.at, event.level, event.kind, event.message, event.detail);
    return { ...event, id: Number(result.lastInsertRowid) };
  }

  events(runId: string, limit = 200): EngineEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, at, level, kind, message, detail
         FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(runId, limit) as EventRow[];
    return rows.reverse().map((row) =>
      EngineEventSchema.parse({
        id: row.id,
        runId: row.run_id,
        at: row.at,
        level: row.level,
        kind: row.kind,
        message: row.message,
        detail: row.detail,
      }),
    );
  }

  acquireLease(runId: string): string {
    const ownerToken = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT owner_token, pid FROM run_leases WHERE run_id = ?")
        .get(runId) as LeaseRow | undefined;
      if (existing && isProcessAlive(existing.pid)) {
        throw new Error(`Run ${runId} is already controlled by process ${existing.pid}`);
      }
      this.db.prepare("DELETE FROM run_leases WHERE run_id = ?").run(runId);
      this.db
        .prepare(
          "INSERT INTO run_leases(run_id, owner_token, pid, acquired_at) VALUES (?, ?, ?, ?)",
        )
        .run(runId, ownerToken, process.pid, new Date().toISOString());
      this.db.exec("COMMIT");
      return ownerToken;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  releaseLease(runId: string, ownerToken: string): void {
    this.db
      .prepare("DELETE FROM run_leases WHERE run_id = ? AND owner_token = ?")
      .run(runId, ownerToken);
  }

  close(): void {
    this.db.close();
  }
}

function activeRunError(state: RunState): Error {
  return new Error(
    `Repository ${state.repoPath} is already owned by ${state.epicId} (${state.phase}); resume that run before starting another epic`,
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
