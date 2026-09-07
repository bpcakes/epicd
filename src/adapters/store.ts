import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { ZodError } from "zod";
import {
  AgentPreferencesSchema,
  EngineEventSchema,
  prepareRunStateForControl,
  RUN_STATE_SCHEMA_VERSION,
  runNeedsResume,
  runRecoveryKind,
  RunStateSchema,
  resolveAdaptiveAgentRoleSettings,
  type AgentPreferences,
  type EngineEvent,
  type EventLevel,
  type RunState,
} from "../domain/types.js";
import { redactSensitiveText } from "../util/redact.js";
import {
  OrchestrationJournal,
  createOrchestrationSchema,
  ORCHESTRATION_SCHEMA_VERSION,
} from "./orchestration-journal.js";
import { RepositoryPolicySchema, type RepositoryPolicy } from "../domain/repository-policy.js";

type RunRow = {
  run_id: string;
  repo_path: string;
  epic_id: string;
  phase: string;
  state_json: string;
  updated_at: string;
  orchestration_present?: number;
};
type QuarantineRunRow = RunRow & { created_at: string };
type EventRow = {
  id: number;
  run_id: string;
  at: string;
  level: string;
  kind: string;
  message: string;
  detail: string | null;
};
type LeaseRow = {
  owner_token: string;
  lease_id: string;
  pid: number;
  acquired_at: string;
  process_marker: string | null;
};
type PersistenceAuthority = { kind: "unleased" } | { kind: "lease"; ownerToken: string };

export type AgentSettingsUpdate = Pick<
  RunState,
  "agentSettings" | "model" | "reasoningEffort" | "updatedAt"
> & { event: EngineEvent };

export type RunLease = {
  ownerToken: string;
  leaseId: string;
  state: RunState;
};

export type ControllerLeaseInfo = {
  pid: number;
  leaseId: string;
  acquiredAt: string;
  alive: boolean;
};

export type QuarantinedRun = {
  runId: string;
  repoPath: string;
  epicId: string;
  recordedPhase: string;
  quarantinedAt: string;
  reason: string;
};

export type StoredRunInspection =
  | { kind: "valid"; state: RunState }
  | {
      kind: "invalid";
      runId: string;
      repoPath: string;
      epicId: string;
      phase: string;
      updatedAt: string;
      error: RunStateDecodeError;
    };

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Unknown epicd run ${runId}`);
    this.name = "RunNotFoundError";
  }
}

export class RunAlreadyControlledError extends Error {
  constructor(
    readonly runId: string,
    readonly pid: number,
    readonly leaseId: string,
  ) {
    super(`Run ${runId} is already controlled by process ${pid} (lease ${leaseId})`);
    this.name = "RunAlreadyControlledError";
  }
}

export class RunStateDecodeError extends Error {
  constructor(
    readonly runId: string,
    cause: unknown,
  ) {
    super(`Persisted state for run ${runId} is invalid`, { cause });
    this.name = "RunStateDecodeError";
  }
}

class UnsupportedRunStateVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `state schema version ${version} requires a newer Epicd; this build supports version ${RUN_STATE_SCHEMA_VERSION}`,
    );
    this.name = "UnsupportedRunStateVersionError";
  }
}

export function unsupportedRunStateVersion(error: RunStateDecodeError): number | null {
  return error.cause instanceof UnsupportedRunStateVersionError ? error.cause.version : null;
}

export function runStateDecodeDetail(error: RunStateDecodeError): string {
  const cause = error.cause;
  let detail: string;
  if (cause instanceof ZodError) {
    const issue = cause.issues[0];
    const path = issue?.path.map(String).join(".");
    detail = issue ? `${path ? `${path}: ` : ""}${issue.message}` : cause.message;
  } else if (cause instanceof Error) {
    detail = cause.message;
  } else {
    detail = String(cause);
  }
  return redactSensitiveText(detail.replaceAll(/\s+/g, " ").trim());
}

function decodeRunRow(row: RunRow): RunState;
function decodeRunRow(row: RunRow | undefined): RunState | null;
function decodeRunRow(row: RunRow | undefined): RunState | null {
  if (!row) return null;
  try {
    const input: unknown = JSON.parse(row.state_json);
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const version = (input as Record<string, unknown>).stateSchemaVersion;
      if (
        typeof version === "number" &&
        Number.isInteger(version) &&
        version > RUN_STATE_SCHEMA_VERSION
      ) {
        throw new UnsupportedRunStateVersionError(version);
      }
    }
    const state = RunStateSchema.parse(input);
    if (
      row.orchestration_present !== undefined &&
      Boolean(row.orchestration_present) !== (state.orchestrationMode === "adaptive")
    ) {
      throw new Error("Run orchestration mode does not match its durable control record");
    }
    const identities = [
      ["run ID", row.run_id, state.runId],
      ["repository path", row.repo_path, state.repoPath],
      ["epic ID", row.epic_id, state.epicId],
      ["phase", row.phase, state.phase],
      ["updated timestamp", row.updated_at, state.updatedAt],
    ] as const;
    for (const [name, indexed, serialized] of identities) {
      if (indexed !== serialized) {
        throw new Error(`indexed ${name} ${indexed} does not match state ${name} ${serialized}`);
      }
    }
    return state;
  } catch (error) {
    throw new RunStateDecodeError(row.run_id, error);
  }
}

function inspectRunRow(row: RunRow): StoredRunInspection {
  try {
    return { kind: "valid", state: decodeRunRow(row) };
  } catch (error) {
    const decodeError =
      error instanceof RunStateDecodeError ? error : new RunStateDecodeError(row.run_id, error);
    return {
      kind: "invalid",
      runId: row.run_id,
      repoPath: row.repo_path,
      epicId: row.epic_id,
      phase: row.phase,
      updatedAt: row.updated_at,
      error: decodeError,
    };
  }
}

const RUN_ROW_COLUMNS = `run_id, repo_path, epic_id, phase, state_json, updated_at,
  EXISTS(SELECT 1 FROM orchestration_runs WHERE orchestration_runs.run_id = runs.run_id) AS orchestration_present`;
const RUN_NEWEST_FIRST = "updated_at DESC, created_at DESC, run_id DESC";

function encodeRunState(state: RunState): string {
  return JSON.stringify(state);
}

export function defaultStatePath(): string {
  const stateRoot = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateRoot, "epicd", "epicd.sqlite3");
}

export class StateStore {
  readonly path: string;
  private readonly db: Database.Database;
  readonly orchestration: OrchestrationJournal;

  constructor(path = defaultStatePath()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { timeout: 5_000 });
    this.orchestration = new OrchestrationJournal(this.db);
    try {
      this.initialize();
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.pragma("foreign_keys = ON");
    } catch (error) {
      this.db.close();
      throw error;
    }
    for (const databaseFile of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(databaseFile)) chmodSync(databaseFile, 0o600);
    }
  }

  /** Hard cut: initialize empty storage or reopen this exact format. Never migrate existing data. */
  private initialize(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const tables = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      if (tables.length) {
        const versions = tables.some((table) => table.name === "orchestration_schema")
          ? (this.db.prepare("SELECT version FROM orchestration_schema").all() as {
              version: number;
            }[])
          : [];
        if (versions.length !== 1 || versions[0]?.version !== ORCHESTRATION_SCHEMA_VERSION)
          throw new Error(
            "This Epicd state format is unsupported. Use a fresh state path; existing data was not migrated or deleted.",
          );
        this.db.exec("COMMIT");
        return;
      }
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
        lease_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        process_marker TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS quarantined_runs (
        run_id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        epic_id TEXT NOT NULL,
        recorded_phase TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        quarantined_at TEXT NOT NULL,
        reason TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS quarantined_events (
        run_id TEXT NOT NULL REFERENCES quarantined_runs(run_id) ON DELETE CASCADE,
        event_id INTEGER NOT NULL,
        at TEXT NOT NULL,
        level TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT,
        PRIMARY KEY (run_id, event_id)
      ) STRICT;
      `);
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS runs_active_repo
          ON runs(repo_path)
          WHERE phase != 'complete';
        CREATE INDEX IF NOT EXISTS runs_by_repo_epic_order
          ON runs(repo_path, epic_id, updated_at DESC, created_at DESC, run_id DESC);
      `);
      createOrchestrationSchema(this.db);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  create(state: RunState): void {
    const parsed = RunStateSchema.parse(state);
    if (parsed.orchestrationMode === "adaptive")
      throw new Error("Adaptive creation requires a frozen policy");
    this.createRun(parsed);
  }

  createAdaptive(state: RunState, policyInput: RepositoryPolicy): RunState {
    const policy = RepositoryPolicySchema.parse(policyInput);
    const coordinator = resolveAdaptiveAgentRoleSettings(state, "orchestrator");
    if (
      !policy.coordinator.reasoningEfforts.includes(
        coordinator.reasoningEffort as (typeof policy.coordinator.reasoningEfforts)[number],
      )
    )
      throw new Error("Coordinator effort is not allowed by frozen policy");
    if (state.phase !== "selecting" || state.currentBeadId !== null || state.completedTasks !== 0)
      throw new Error("Cannot convert an existing delivery workflow to adaptive mode");
    const parsed = RunStateSchema.parse({
      ...state,
      stateSchemaVersion: 2,
      orchestrationMode: "adaptive",
      agentSettings: {
        ...state.agentSettings,
        orchestrator: { ...state.agentSettings.orchestrator, model: coordinator.model },
      },
    });
    this.createRun(parsed, policy);
    return parsed;
  }

  private createRun(parsed: RunState, policy?: RepositoryPolicy): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const workflowOwner = this.inspectWorkflowOwner(parsed.repoPath);
      if (workflowOwner) throw recoverableRunError(workflowOwner, true);
      const existingEpic = this.inspectRecoverable(parsed.repoPath, parsed.epicId);
      if (existingEpic) throw recoverableRunError(existingEpic);
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
          encodeRunState(parsed),
          parsed.createdAt,
          parsed.updatedAt,
        );
      if (policy) this.orchestration.initialize(parsed.runId, policy, parsed.totalTasks);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  save(state: RunState): void {
    this.persist(state, { kind: "unleased" });
  }

  saveWithLease(state: RunState, ownerToken: string): void {
    this.persist(state, { kind: "lease", ownerToken });
  }

  updateAgentSettingsWithLease(
    runId: string,
    ownerToken: string,
    settings: AgentPreferences,
    runWide?: Pick<RunState, "model" | "reasoningEffort">,
  ): AgentSettingsUpdate {
    return this.updateAgentSettingsAuthorized(runId, settings, runWide, {
      kind: "lease",
      ownerToken,
    });
  }

  updateAgentSettings(
    runId: string,
    settings: AgentPreferences,
    runWide?: Pick<RunState, "model" | "reasoningEffort">,
  ): AgentSettingsUpdate {
    return this.updateAgentSettingsAuthorized(runId, settings, runWide, { kind: "unleased" });
  }

  private updateAgentSettingsAuthorized(
    runId: string,
    settings: AgentPreferences,
    runWide: Pick<RunState, "model" | "reasoningEffort"> | undefined,
    authority: PersistenceAuthority,
  ): AgentSettingsUpdate {
    const parsedSettings = AgentPreferencesSchema.parse(settings);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(`SELECT ${RUN_ROW_COLUMNS} FROM runs WHERE run_id = ?`)
        .get(runId) as RunRow | undefined;
      if (!row) throw new RunNotFoundError(runId);
      const source = decodeRunRow(row);
      if (source.phase === "complete") {
        throw new Error("A completed run cannot create new agent threads");
      }
      if (authority.kind === "unleased") this.removeStaleLeaseOrThrow(runId);
      const candidate = RunStateSchema.parse({
        ...source,
        ...(runWide ?? {}),
        agentSettings: parsedSettings,
        updatedAt: new Date().toISOString(),
      });
      if (source.orchestrationMode === "adaptive") {
        const effective = resolveAdaptiveAgentRoleSettings(candidate, "orchestrator");
        const policy = this.orchestration.policy(runId);
        if (
          !policy.coordinator.reasoningEfforts.some(
            (effort) => effort === effective.reasoningEffort,
          )
        )
          throw new Error("Coordinator effort is not allowed by frozen policy");
        candidate.agentSettings.orchestrator.model = effective.model;
      }
      const result = this.writeRunState(candidate, authority, true);
      if (result.changes !== 1) {
        throw new Error(`Run ${runId} is not controlled by this epicd process`);
      }
      const event = this.addEventAuthorized(
        runId,
        "success",
        "agent.settings_updated",
        "Updated model and reasoning settings for future agent sessions",
        "Existing agent sessions keep the settings they started with",
        authority,
      );
      if (source.orchestrationMode === "adaptive") this.orchestration.noteSettingsChange(runId);
      this.db.exec("COMMIT");
      return {
        event,
        agentSettings: candidate.agentSettings,
        model: candidate.model,
        reasoningEffort: candidate.reasoningEffort,
        updatedAt: candidate.updatedAt,
      };
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private persist(state: RunState, authority: PersistenceAuthority): void {
    const parsed = RunStateSchema.parse({ ...state, updatedAt: new Date().toISOString() });
    const result =
      authority.kind === "unleased"
        ? this.withUnleasedRun(parsed.runId, () => this.writeRunState(parsed, authority))
        : this.writeRunState(parsed, authority);
    if (result.changes !== 1) {
      const exists = this.db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(parsed.runId) as
        { 1: number } | undefined;
      throw new Error(
        !exists
          ? `Unknown epicd run ${parsed.runId}`
          : `Run ${parsed.runId} is not controlled by this epicd process`,
      );
    }
    Object.assign(state, parsed);
  }

  /** Keep lease validation and the write atomic, including within administrative transactions. */
  private withUnleasedRun<T>(runId: string, write: () => T): T {
    return this.db
      .transaction(() => {
        this.removeStaleLeaseOrThrow(runId);
        return write();
      })
      .immediate();
  }

  /** The only update path for a serialized run and its indexed identity columns. */
  private writeRunState(
    state: RunState,
    authority: PersistenceAuthority,
    settingsOnly = false,
  ): { changes: number } {
    if (this.orchestration.hasRun(state.runId) && !settingsOnly) {
      throw new Error("Adaptive control facts cannot be overwritten by a legacy state snapshot");
    }
    const parsed = RunStateSchema.parse(state);
    const parameters = [
      parsed.phase,
      encodeRunState(parsed),
      parsed.updatedAt,
      parsed.runId,
    ] as const;
    const result =
      authority.kind === "unleased"
        ? this.db
            .prepare("UPDATE runs SET phase = ?, state_json = ?, updated_at = ? WHERE run_id = ?")
            .run(...parameters)
        : this.db
            .prepare(
              `UPDATE runs SET phase = ?, state_json = ?, updated_at = ?
               WHERE run_id = ?
                 AND EXISTS (
                   SELECT 1 FROM run_leases
                   WHERE run_id = ? AND owner_token = ?
                 )`,
            )
            .run(...parameters, parsed.runId, authority.ownerToken);
    return { changes: result.changes };
  }

  private removeStaleLeaseOrThrow(runId: string): void {
    const lease = this.db
      .prepare(
        "SELECT owner_token, lease_id, pid, acquired_at, process_marker FROM run_leases WHERE run_id = ?",
      )
      .get(runId) as LeaseRow | undefined;
    if (!lease) return;
    if (isLeaseOwnerAlive(lease)) {
      throw new RunAlreadyControlledError(runId, lease.pid, lease.lease_id);
    }
    this.db.prepare("DELETE FROM run_leases WHERE run_id = ?").run(runId);
  }

  get(runId: string): RunState | null {
    const row = this.db
      .prepare(`SELECT ${RUN_ROW_COLUMNS} FROM runs WHERE run_id = ?`)
      .get(runId) as RunRow | undefined;
    return decodeRunRow(row);
  }

  findLatest(repoPath: string, epicId?: string): RunState | null {
    return decodeRunRow(this.latestRunRow(repoPath, epicId));
  }

  findActive(repoPath: string): RunState | null {
    return decodeRunRow(this.workflowOwnerRow(repoPath));
  }

  list(repoPath?: string): RunState[] {
    const rows = repoPath
      ? this.repositoryRunRows(repoPath)
      : (this.db
          .prepare(`SELECT ${RUN_ROW_COLUMNS} FROM runs ORDER BY ${RUN_NEWEST_FIRST}`)
          .all() as RunRow[]);
    return rows.map((row) => decodeRunRow(row));
  }

  inspect(repoPath: string, epicId?: string): StoredRunInspection[] {
    const rows = epicId
      ? (this.db
          .prepare(
            `SELECT ${RUN_ROW_COLUMNS} FROM runs
             WHERE repo_path = ? AND epic_id = ? ORDER BY ${RUN_NEWEST_FIRST}`,
          )
          .all(repoPath, epicId) as RunRow[])
      : this.repositoryRunRows(repoPath);
    return rows.map(inspectRunRow);
  }

  inspectLatest(repoPath: string, epicId: string): StoredRunInspection | null {
    const row = this.latestRunRow(repoPath, epicId);
    return row ? inspectRunRow(row) : null;
  }

  /** Selects the run an epic-scoped status should show, aligned with resume semantics. */
  inspectCurrent(repoPath: string, epicId: string): StoredRunInspection | null {
    return this.inspectRecoverable(repoPath, epicId) ?? this.inspectLatest(repoPath, epicId);
  }

  /** Finds repository-wide Git workflow ownership, independent of cleanup-only work. */
  inspectWorkflowOwner(repoPath: string): StoredRunInspection | null {
    const row = this.workflowOwnerRow(repoPath);
    return row ? inspectRunRow(row) : null;
  }

  private latestRunRow(repoPath: string, epicId?: string): RunRow | undefined {
    return epicId
      ? (this.db
          .prepare(
            `SELECT ${RUN_ROW_COLUMNS} FROM runs
             WHERE repo_path = ? AND epic_id = ? ORDER BY ${RUN_NEWEST_FIRST} LIMIT 1`,
          )
          .get(repoPath, epicId) as RunRow | undefined)
      : (this.db
          .prepare(
            `SELECT ${RUN_ROW_COLUMNS} FROM runs
             WHERE repo_path = ? ORDER BY ${RUN_NEWEST_FIRST} LIMIT 1`,
          )
          .get(repoPath) as RunRow | undefined);
  }

  private workflowOwnerRow(repoPath: string): RunRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${RUN_ROW_COLUMNS} FROM runs
         WHERE repo_path = ? AND phase != 'complete'
         ORDER BY ${RUN_NEWEST_FIRST} LIMIT 1`,
      )
      .get(repoPath) as RunRow | undefined;
    return row;
  }

  private repositoryRunRows(repoPath: string): RunRow[] {
    return this.db
      .prepare(
        `SELECT ${RUN_ROW_COLUMNS} FROM runs
         WHERE repo_path = ? ORDER BY ${RUN_NEWEST_FIRST}`,
      )
      .all(repoPath) as RunRow[];
  }

  /** Finds the newest run that still owns workflow, session, or cleanup work. */
  inspectRecoverable(repoPath: string, epicId: string): StoredRunInspection | null {
    const rows = this.db
      .prepare(
        `SELECT ${RUN_ROW_COLUMNS} FROM runs
         WHERE repo_path = ? AND epic_id = ? ORDER BY ${RUN_NEWEST_FIRST}`,
      )
      .all(repoPath, epicId) as RunRow[];
    for (const row of rows) {
      const inspected = inspectRunRow(row);
      if (inspected.kind === "invalid" || runNeedsResume(inspected.state)) return inspected;
    }
    return null;
  }

  /**
   * Removes an undecodable run without deriving workflow or cleanup actions from it.
   * The raw row and its events remain in quarantine for forensic recovery.
   */
  quarantineInvalidRun(runId: string): QuarantinedRun {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT run_id, repo_path, epic_id, phase, state_json, created_at, updated_at
           FROM runs WHERE run_id = ?`,
        )
        .get(runId) as QuarantineRunRow | undefined;
      if (!row) throw new RunNotFoundError(runId);
      const inspected = inspectRunRow(row);
      if (inspected.kind === "valid") {
        throw new Error(
          `Run ${runId} has valid persisted state; use normal resume or cleanup instead of quarantine`,
        );
      }
      const unsupportedVersion = unsupportedRunStateVersion(inspected.error);
      if (unsupportedVersion !== null) {
        throw new Error(
          `Run ${runId} uses state schema version ${unsupportedVersion}; upgrade Epicd instead of quarantining state written by a newer version`,
        );
      }
      this.removeStaleLeaseOrThrow(runId);
      const quarantinedAt = new Date().toISOString();
      const reason = runStateDecodeDetail(inspected.error);
      this.db
        .prepare(
          `INSERT INTO quarantined_runs(
             run_id, repo_path, epic_id, recorded_phase, state_json,
             created_at, updated_at, quarantined_at, reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.run_id,
          row.repo_path,
          row.epic_id,
          row.phase,
          row.state_json,
          row.created_at,
          row.updated_at,
          quarantinedAt,
          reason,
        );
      this.db
        .prepare(
          `INSERT INTO quarantined_events(
             run_id, event_id, at, level, kind, message, detail
           )
           SELECT run_id, id, at, level, kind, message, detail
           FROM events WHERE run_id = ?`,
        )
        .run(runId);
      this.orchestration.preserveQuarantine(runId);
      const removed = this.db.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
      if (removed.changes !== 1) throw new RunNotFoundError(runId);
      this.db.exec("COMMIT");
      return {
        runId,
        repoPath: row.repo_path,
        epicId: row.epic_id,
        recordedPhase: row.phase,
        quarantinedAt,
        reason,
      };
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  abandonAgentCleanup(runId: string): { state: RunState; abandonedActions: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.removeStaleLeaseOrThrow(runId);
      const row = this.db
        .prepare(`SELECT ${RUN_ROW_COLUMNS} FROM runs WHERE run_id = ?`)
        .get(runId) as RunRow | undefined;
      if (!row) throw new RunNotFoundError(runId);
      const state = decodeRunRow(row);
      if (state.phase !== "complete") {
        throw new Error(
          `Run ${runId} is ${state.phase}; cleanup can be abandoned only after completion`,
        );
      }
      const abandonedActions =
        state.pendingAgentCleanup.length +
        Object.values(state.agentSessions).filter((session) => session.status !== "inactive")
          .length;
      if (abandonedActions === 0 && state.lastError === null) {
        throw new Error(`Run ${runId} has no pending agent cleanup`);
      }
      const updatedAt = new Date().toISOString();
      const abandoned = RunStateSchema.parse({
        ...state,
        agentSessions: {
          orchestrator: { status: "inactive" },
          implementation: { status: "inactive" },
          review: { status: "inactive" },
        },
        pendingAgentCleanup: [],
        lastError: null,
        updatedAt,
      });
      const written = this.writeRunState(abandoned, { kind: "unleased" });
      if (written.changes !== 1) throw new RunNotFoundError(runId);
      const abandonedResources = abandonedActions > 0;
      this.addEvent(
        runId,
        "warning",
        "agent.cleanup_abandoned",
        abandonedResources
          ? `Abandoned ${abandonedActions} agent cleanup action(s)`
          : "Cleared completed cleanup diagnostic",
        abandonedResources ? "External agent resources may remain open" : null,
      );
      this.db.exec("COMMIT");
      return { state: abandoned, abandonedActions };
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  addEvent(
    runId: string,
    level: EventLevel,
    kind: string,
    message: string,
    detail: string | null = null,
  ): EngineEvent {
    return this.addEventAuthorized(runId, level, kind, message, detail, { kind: "unleased" });
  }

  addEventWithLease(
    runId: string,
    ownerToken: string,
    level: EventLevel,
    kind: string,
    message: string,
    detail: string | null = null,
  ): EngineEvent {
    return this.addEventAuthorized(runId, level, kind, message, detail, {
      kind: "lease",
      ownerToken,
    });
  }

  private addEventAuthorized(
    runId: string,
    level: EventLevel,
    kind: string,
    message: string,
    detail: string | null,
    authority: PersistenceAuthority,
  ): EngineEvent {
    const event = EngineEventSchema.parse({
      runId,
      at: new Date().toISOString(),
      level,
      kind,
      message,
      detail,
    });
    const parameters = [
      event.runId,
      event.at,
      event.level,
      event.kind,
      event.message,
      event.detail,
    ] as const;
    const result =
      authority.kind === "unleased"
        ? this.withUnleasedRun(runId, () =>
            this.db
              .prepare(
                "INSERT INTO events(run_id, at, level, kind, message, detail) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(...parameters),
          )
        : this.db
            .prepare(
              `INSERT INTO events(run_id, at, level, kind, message, detail)
               SELECT ?, ?, ?, ?, ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM run_leases
                 WHERE run_id = ? AND owner_token = ?
               )`,
            )
            .run(...parameters, event.runId, authority.ownerToken);
    if (result.changes !== 1) {
      throw new Error(`Run ${runId} is not controlled by this epicd process`);
    }
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

  controllerLease(runId: string): ControllerLeaseInfo | null {
    const lease = this.db
      .prepare(
        `SELECT owner_token, lease_id, pid, acquired_at, process_marker
         FROM run_leases WHERE run_id = ?`,
      )
      .get(runId) as LeaseRow | undefined;
    return lease
      ? {
          pid: lease.pid,
          leaseId: lease.lease_id,
          acquiredAt: lease.acquired_at,
          alive: isLeaseOwnerAlive(lease),
        }
      : null;
  }

  acquireLease(runId: string): RunLease {
    return this.acquire(runId);
  }

  private acquire(runId: string): RunLease {
    const ownerToken = randomUUID();
    const leaseId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(`SELECT ${RUN_ROW_COLUMNS} FROM runs WHERE run_id = ?`)
        .get(runId) as RunRow | undefined;
      if (!row) throw new RunNotFoundError(runId);
      let state: RunState;
      state = decodeRunRow(row);
      const existing = this.db
        .prepare(
          "SELECT owner_token, lease_id, pid, acquired_at, process_marker FROM run_leases WHERE run_id = ?",
        )
        .get(runId) as LeaseRow | undefined;
      if (existing && isLeaseOwnerAlive(existing)) {
        throw new RunAlreadyControlledError(runId, existing.pid, existing.lease_id);
      }
      this.db.prepare("DELETE FROM run_leases WHERE run_id = ?").run(runId);
      this.db
        .prepare(
          `INSERT INTO run_leases(
             run_id, owner_token, lease_id, pid, acquired_at, process_marker
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          ownerToken,
          leaseId,
          process.pid,
          new Date().toISOString(),
          processMarker(process.pid),
        );
      const controlledState =
        state.orchestrationMode === "adaptive" ? state : prepareRunStateForControl(state);
      if (encodeRunState(controlledState) !== encodeRunState(state)) {
        state = RunStateSchema.parse({
          ...controlledState,
          updatedAt: new Date().toISOString(),
        });
        this.writeRunState(state, { kind: "lease", ownerToken });
      }
      this.db.exec("COMMIT");
      return { ownerToken, leaseId, state };
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  releaseLease(runId: string, ownerToken: string): void {
    this.db
      .prepare("DELETE FROM run_leases WHERE run_id = ? AND owner_token = ?")
      .run(runId, ownerToken);
  }

  forceReleaseLease(runId: string, expectedPid: number, expectedLeaseId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const exists = this.db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId);
      if (!exists) throw new RunNotFoundError(runId);
      const lease = this.db
        .prepare("SELECT pid, lease_id FROM run_leases WHERE run_id = ?")
        .get(runId) as { pid: number; lease_id: string } | undefined;
      if (!lease) {
        this.db.exec("COMMIT");
        return false;
      }
      if (lease.pid !== expectedPid || lease.lease_id !== expectedLeaseId) {
        throw new Error(
          `Run ${runId} lease ownership changed after it was inspected; inspect the current controller before retrying`,
        );
      }
      const result = this.db
        .prepare("DELETE FROM run_leases WHERE run_id = ? AND pid = ? AND lease_id = ?")
        .run(runId, expectedPid, expectedLeaseId);
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

function recoverableRunError(inspection: StoredRunInspection, repositoryWide = false): Error {
  if (inspection.kind === "invalid") {
    return new Error(
      repositoryWide
        ? `Repository ${inspection.repoPath} is occupied by invalid active run ${inspection.runId}; inspect it with epicd status before creating another run`
        : `Epic ${inspection.epicId} has unresolved invalid run ${inspection.runId}; inspect it with epicd status before replacing that epic`,
      { cause: inspection.error },
    );
  }
  const state = inspection.state;
  if (state.phase === "complete") {
    if (runRecoveryKind(state) === "diagnostic") {
      return new Error(
        `Epic ${state.epicId} has a saved diagnostic in completed run ${state.runId}; resume it with epicd resume ${state.epicId}, or clear it with epicd cleanup ${state.runId} --abandon`,
      );
    }
    return new Error(
      `Epic ${state.epicId} still has agent cleanup or session recovery; resume that run before replacing the epic`,
    );
  }
  return new Error(
    `Repository ${state.repoPath} is already owned by ${state.epicId} (${state.phase} workflow); resume that run before starting another epic`,
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

function isLeaseOwnerAlive(lease: Pick<LeaseRow, "pid" | "process_marker">): boolean {
  if (!isProcessAlive(lease.pid)) return false;
  if (lease.process_marker === null) return true;
  const recordedMarker = parseLinuxProcessMarker(lease.process_marker);
  const currentBootId = linuxBootId();
  if (recordedMarker?.bootId && currentBootId && recordedMarker.bootId !== currentBootId) {
    return false;
  }
  const currentMarker = processMarker(lease.pid);
  if (currentMarker === null) return true;
  const parsedCurrent = parseLinuxProcessMarker(currentMarker);
  if (recordedMarker && parsedCurrent) {
    return (
      recordedMarker.startTime === parsedCurrent.startTime &&
      (!recordedMarker.bootId ||
        !parsedCurrent.bootId ||
        recordedMarker.bootId === parsedCurrent.bootId)
    );
  }
  return currentMarker === lease.process_marker;
}

function processMarker(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(") ");
    if (commandEnd < 0) return null;
    const fieldsAfterCommand = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const startTime = fieldsAfterCommand[19];
    if (!startTime || !/^\d+$/.test(startTime)) return null;
    const bootId = linuxBootId();
    return bootId ? `linux:${bootId}:${startTime}` : `linux:${startTime}`;
  } catch {
    return null;
  }
}

function linuxBootId(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

function parseLinuxProcessMarker(
  marker: string,
): { bootId: string | null; startTime: string } | null {
  const fields = marker.split(":");
  if (fields[0] !== "linux") return null;
  if (fields.length === 2 && /^\d+$/.test(fields[1] ?? "")) {
    return { bootId: null, startTime: fields[1] as string };
  }
  if (fields.length === 3 && fields[1] && /^\d+$/.test(fields[2] ?? "")) {
    return { bootId: fields[1], startTime: fields[2] as string };
  }
  return null;
}
