import { validateAccountReservation } from "./accounts.js";
import { accountBinding } from "../domain/accounts.js";
import { RunStateSchema } from "../domain/types.js";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve, parse as parsePath } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AgentAssignmentSchema,
  AgentConversationTransferSchema,
  AgentInstanceSchema,
  AGENT_INSTANCE_SCHEMA_VERSION,
  AgentMailboxMessageSchema,
  ProviderIdentitySchema,
  TurnRecordSchema,
  WorkspaceRecordSchema,
  type AgentAssignment,
  type AgentConversationTransfer,
  type AgentIdentity,
  type AgentInstance,
  type AgentMailboxMessage,
  type ProviderIdentity,
  type TurnRecord,
  type WorkspaceIdentity,
  type WorkspaceRecord,
} from "../domain/agents.js";
import {
  EssentialTurnFailureSchema,
  type EssentialTurnFailure,
} from "../domain/provider-failure.js";
import {
  sameTurn,
  TurnIdentitySchema,
  type ControllerAuthority,
  type ControlState,
  type ObservationInput,
  type TurnIdentity,
} from "../domain/orchestration.js";
import {
  AGENT_DIAGNOSTIC_OUTPUT_SCHEMA,
  ORCHESTRATOR_MODEL,
  BackendKindSchema,
  type AgentRole,
  type AgentSessionContract,
  type RuntimeKind,
} from "../domain/types.js";
import { AgentExecutionSchema } from "../domain/agent-execution.js";
import { digestJson, type RepositoryPolicy } from "../domain/repository-policy.js";
import { redactSensitiveText } from "../util/redact.js";
import {
  WorkspaceOperationSchema,
  workspaceExecutionScope,
  type WorkspaceOperation,
} from "../domain/workspaces.js";
import {
  CommandLifetimeSchema,
  CommandStopSchema,
  assertCommandStop,
  type CommandLifetime,
  type CommandStop,
} from "../domain/command-lifetime.js";
import {
  CodexLaunchSchema,
  CodexLaunchStopSchema,
  type CodexLaunch,
  type CodexLaunchStop,
  NativeLaunchEndpointSchema,
  type NativeLaunchEndpoint,
} from "../domain/codex-launch.js";

export const AGENT_TABLES = [
  "agent_ownership_epochs",
  "workspaces",
  "workspace_ownership_revisions",
  "workspace_operations",
  "agent_instances",
  "agent_ownership_revisions",
  "agent_conversation_transfers",
  "agent_assignments",
  "agent_turns",
  "agent_messages",
] as const;

export function createAgentsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_ownership_epochs (
      run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      revision TEXT NOT NULL CHECK(length(revision) = 32)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK(generation > 0), path TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      UNIQUE(run_id, workspace_id, generation),
      CHECK(json_extract(record_json, '$.workspaceId') = workspace_id AND
        json_extract(record_json, '$.runId') = run_id AND json_extract(record_json, '$.workspaceGeneration') = generation AND
        json_extract(record_json, '$.path') = path)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS workspace_creation_operation ON workspaces(json_extract(record_json, '$.creationOperationId'))
      WHERE json_extract(record_json, '$.creationOperationId') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS workspace_ownership_revisions (
      run_id TEXT NOT NULL, workspace_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0),
      revision TEXT NOT NULL CHECK(length(revision) = 32),
      PRIMARY KEY(run_id, workspace_id, generation),
      FOREIGN KEY(run_id, workspace_id, generation)
        REFERENCES workspaces(run_id, workspace_id, generation) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workspace_operations (
      operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL, workspace_generation INTEGER NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      FOREIGN KEY(run_id, workspace_id, workspace_generation) REFERENCES workspaces(run_id, workspace_id, generation),
      CHECK(json_extract(record_json, '$.operationId') = operation_id AND json_extract(record_json, '$.runId') = run_id AND
        json_extract(record_json, '$.workspaceId') = workspace_id AND json_extract(record_json, '$.workspaceGeneration') = workspace_generation)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_workspace_operation ON workspace_operations(workspace_id, workspace_generation)
      WHERE json_extract(record_json, '$.stopEvidence') IS NULL;
    CREATE TABLE IF NOT EXISTS agent_instances (
      agent_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0),
      run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL, workspace_generation INTEGER NOT NULL,
      assignment_id TEXT NOT NULL UNIQUE REFERENCES agent_assignments(assignment_id) DEFERRABLE INITIALLY DEFERRED,
      conversation_transfer_id TEXT REFERENCES agent_conversation_transfers(transfer_id) DEFERRABLE INITIALLY DEFERRED,
      provider_key TEXT, provider_backend TEXT, provider_runtime TEXT, provider_session_id TEXT,
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      PRIMARY KEY(agent_id, generation), UNIQUE(run_id, agent_id, generation),
      FOREIGN KEY(run_id, workspace_id, workspace_generation) REFERENCES workspaces(run_id, workspace_id, generation),
      CHECK(json_extract(record_json, '$.agentId') = agent_id AND json_extract(record_json, '$.agentGeneration') = generation AND
        json_extract(record_json, '$.runId') = run_id AND json_extract(record_json, '$.workspaceId') = workspace_id AND
        json_extract(record_json, '$.workspaceGeneration') = workspace_generation AND json_extract(record_json, '$.assignmentId') = assignment_id),
      CHECK(json_extract(record_json, '$.conversationContinuation.transferId') IS conversation_transfer_id),
      CHECK(json_extract(record_json, '$.provider.backend') IS provider_backend AND
        json_extract(record_json, '$.provider.runtime') IS provider_runtime AND
        json_extract(record_json, '$.provider.sessionId') IS provider_session_id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_provider_key
      ON agent_instances(provider_key)
      WHERE provider_key IS NOT NULL AND json_extract(record_json, '$.status') <> 'released';
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_provider_session_identity
      ON agent_instances(provider_backend, provider_session_id)
      WHERE provider_backend IS NOT NULL AND provider_session_id IS NOT NULL AND
        json_extract(record_json, '$.status') <> 'released';
    CREATE TABLE IF NOT EXISTS agent_ownership_revisions (
      run_id TEXT NOT NULL, agent_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0),
      revision TEXT NOT NULL CHECK(length(revision) = 32),
      PRIMARY KEY(run_id, agent_id, generation),
      FOREIGN KEY(run_id, agent_id, generation)
        REFERENCES agent_instances(run_id, agent_id, generation) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_conversation_transfers (
      transfer_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      source_agent_id TEXT NOT NULL, source_agent_generation INTEGER NOT NULL,
      target_agent_id TEXT, target_agent_generation INTEGER,
      session_id TEXT NOT NULL, target_runtime TEXT NOT NULL CHECK(target_runtime IN ('sdk','herdr')),
      status TEXT NOT NULL CHECK(status IN ('pending','claimed','consumed','abandoned')),
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      FOREIGN KEY(run_id, source_agent_id, source_agent_generation)
        REFERENCES agent_instances(run_id, agent_id, generation),
      FOREIGN KEY(run_id, target_agent_id, target_agent_generation)
        REFERENCES agent_instances(run_id, agent_id, generation) DEFERRABLE INITIALLY DEFERRED,
      CHECK(json_extract(record_json, '$.transferId') = transfer_id AND
        json_extract(record_json, '$.runId') = run_id AND
        json_extract(record_json, '$.sourceAgentId') = source_agent_id AND
        json_extract(record_json, '$.sourceAgentGeneration') = source_agent_generation AND
        json_extract(record_json, '$.targetAgentId') IS target_agent_id AND
        json_extract(record_json, '$.targetAgentGeneration') IS target_agent_generation AND
        json_extract(record_json, '$.sessionId') = session_id AND
        json_extract(record_json, '$.targetRuntime') = target_runtime AND
        json_extract(record_json, '$.status') = status)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_conversation_transfer
      ON agent_conversation_transfers(session_id)
      WHERE status IN ('pending','claimed');
    CREATE TABLE IF NOT EXISTS agent_assignments (
      assignment_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, agent_generation INTEGER NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      FOREIGN KEY(run_id, agent_id, agent_generation) REFERENCES agent_instances(run_id, agent_id, generation) DEFERRABLE INITIALLY DEFERRED,
      CHECK(json_extract(record_json, '$.assignmentId') = assignment_id AND json_extract(record_json, '$.runId') = run_id AND
        json_extract(record_json, '$.agentId') = agent_id AND json_extract(record_json, '$.agentGeneration') = agent_generation)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_turns (
      turn_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, agent_generation INTEGER NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      FOREIGN KEY(run_id, agent_id, agent_generation) REFERENCES agent_instances(run_id, agent_id, generation),
      CHECK(json_extract(record_json, '$.identity.turnId') = turn_id AND json_extract(record_json, '$.identity.runId') = run_id AND
        json_extract(record_json, '$.identity.agentId') = agent_id AND json_extract(record_json, '$.identity.agentGeneration') = agent_generation AND
        json_extract(record_json, '$.identity.operationId') = operation_id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_agent_turn ON agent_turns(agent_id, agent_generation)
      WHERE json_extract(record_json, '$.stopEvidence') IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS one_turn_launch_generation ON agent_turns(json_extract(record_json, '$.launch.manifest.generation'))
      WHERE json_extract(record_json, '$.launch') IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS one_turn_launch_directory ON agent_turns(json_extract(record_json, '$.launch.manifest.controlDirectory'))
      WHERE json_extract(record_json, '$.launch') IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS one_turn_native_terminal ON agent_turns(
      json_extract(record_json, '$.launch.native.socketIdentity'), json_extract(record_json, '$.launch.native.terminalId'))
      WHERE json_extract(record_json, '$.launch.native') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS agent_messages (
      message_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, agent_generation INTEGER NOT NULL, operation_id TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      FOREIGN KEY(run_id, agent_id, agent_generation) REFERENCES agent_instances(run_id, agent_id, generation),
      CHECK(json_extract(record_json, '$.messageId') = message_id AND json_extract(record_json, '$.runId') = run_id AND
        json_extract(record_json, '$.agentId') = agent_id AND json_extract(record_json, '$.agentGeneration') = agent_generation AND
        json_extract(record_json, '$.operationId') = operation_id)
    ) STRICT;
    CREATE TRIGGER agent_ownership_epoch_insert AFTER INSERT ON orchestration_runs BEGIN
      INSERT INTO agent_ownership_epochs(run_id, revision)
        VALUES (NEW.run_id, lower(hex(randomblob(16))));
    END;
    CREATE TRIGGER workspace_ownership_revision_insert AFTER INSERT ON workspaces BEGIN
      INSERT INTO workspace_ownership_revisions(run_id, workspace_id, generation, revision)
        VALUES (NEW.run_id, NEW.workspace_id, NEW.generation, lower(hex(randomblob(16))));
    END;
    CREATE TRIGGER agent_ownership_revision_insert AFTER INSERT ON agent_instances BEGIN
      INSERT INTO agent_ownership_revisions(run_id, agent_id, generation, revision)
        VALUES (NEW.run_id, NEW.agent_id, NEW.generation, lower(hex(randomblob(16))));
      UPDATE agent_ownership_epochs SET revision = lower(hex(randomblob(16))) WHERE run_id = NEW.run_id;
    END;
    CREATE TRIGGER agent_ownership_revision_update AFTER UPDATE ON agent_instances BEGIN
      UPDATE agent_ownership_revisions SET revision = lower(hex(randomblob(16)))
        WHERE run_id = NEW.run_id AND agent_id = NEW.agent_id AND generation = NEW.generation;
      UPDATE agent_ownership_epochs SET revision = lower(hex(randomblob(16))) WHERE run_id = NEW.run_id;
    END;
    CREATE TRIGGER agent_ownership_revision_delete AFTER DELETE ON agent_instances BEGIN
      UPDATE agent_ownership_epochs SET revision = lower(hex(randomblob(16))) WHERE run_id = OLD.run_id;
    END;
    CREATE TRIGGER agent_turn_ownership_revision_insert AFTER INSERT ON agent_turns BEGIN
      UPDATE agent_ownership_revisions SET revision = lower(hex(randomblob(16)))
        WHERE run_id = NEW.run_id AND agent_id = NEW.agent_id AND generation = NEW.agent_generation;
      UPDATE agent_ownership_epochs SET revision = lower(hex(randomblob(16))) WHERE run_id = NEW.run_id;
    END;
    CREATE TRIGGER agent_turn_ownership_revision_update AFTER UPDATE ON agent_turns BEGIN
      UPDATE agent_ownership_revisions SET revision = lower(hex(randomblob(16)))
        WHERE run_id = NEW.run_id AND agent_id = NEW.agent_id AND generation = NEW.agent_generation;
      UPDATE agent_ownership_epochs SET revision = lower(hex(randomblob(16))) WHERE run_id = NEW.run_id;
    END;
    CREATE TRIGGER agent_turn_ownership_revision_delete AFTER DELETE ON agent_turns BEGIN
      UPDATE agent_ownership_revisions SET revision = lower(hex(randomblob(16)))
        WHERE run_id = OLD.run_id AND agent_id = OLD.agent_id AND generation = OLD.agent_generation;
      UPDATE agent_ownership_epochs SET revision = lower(hex(randomblob(16))) WHERE run_id = OLD.run_id;
    END;
    CREATE TRIGGER agent_message_ownership_revision_insert AFTER INSERT ON agent_messages BEGIN
      UPDATE agent_ownership_revisions SET revision = lower(hex(randomblob(16)))
        WHERE run_id = NEW.run_id AND agent_id = NEW.agent_id AND generation = NEW.agent_generation;
      UPDATE agent_ownership_epochs SET revision = lower(hex(randomblob(16))) WHERE run_id = NEW.run_id;
    END;
    CREATE TRIGGER agent_message_ownership_revision_update AFTER UPDATE ON agent_messages BEGIN
      UPDATE agent_ownership_revisions SET revision = lower(hex(randomblob(16)))
        WHERE run_id = NEW.run_id AND agent_id = NEW.agent_id AND generation = NEW.agent_generation;
      UPDATE agent_ownership_epochs SET revision = lower(hex(randomblob(16))) WHERE run_id = NEW.run_id;
    END;
    CREATE TRIGGER agent_message_ownership_revision_delete AFTER DELETE ON agent_messages BEGIN
      UPDATE agent_ownership_revisions SET revision = lower(hex(randomblob(16)))
        WHERE run_id = OLD.run_id AND agent_id = OLD.agent_id AND generation = OLD.agent_generation;
      UPDATE agent_ownership_epochs SET revision = lower(hex(randomblob(16))) WHERE run_id = OLD.run_id;
    END;
    CREATE TRIGGER agent_workspace_ownership_revision_update AFTER UPDATE ON workspaces BEGIN
      UPDATE workspace_ownership_revisions SET revision = lower(hex(randomblob(16)))
        WHERE run_id = NEW.run_id AND workspace_id = NEW.workspace_id AND generation = NEW.generation;
      UPDATE agent_ownership_epochs SET revision = lower(hex(randomblob(16))) WHERE run_id = NEW.run_id;
    END;
    CREATE TRIGGER agent_workspace_operation_ownership_revision_insert AFTER INSERT ON workspace_operations BEGIN
      UPDATE workspace_ownership_revisions SET revision = lower(hex(randomblob(16)))
        WHERE run_id = NEW.run_id AND workspace_id = NEW.workspace_id AND generation = NEW.workspace_generation;
      UPDATE agent_ownership_epochs SET revision = lower(hex(randomblob(16))) WHERE run_id = NEW.run_id;
    END;
    CREATE TRIGGER agent_workspace_operation_ownership_revision_update AFTER UPDATE ON workspace_operations BEGIN
      UPDATE workspace_ownership_revisions SET revision = lower(hex(randomblob(16)))
        WHERE run_id = NEW.run_id AND workspace_id = NEW.workspace_id AND generation = NEW.workspace_generation;
      UPDATE agent_ownership_epochs SET revision = lower(hex(randomblob(16))) WHERE run_id = NEW.run_id;
    END;
    CREATE TRIGGER agent_workspace_operation_ownership_revision_delete AFTER DELETE ON workspace_operations BEGIN
      UPDATE workspace_ownership_revisions SET revision = lower(hex(randomblob(16)))
        WHERE run_id = OLD.run_id AND workspace_id = OLD.workspace_id AND generation = OLD.workspace_generation;
      UPDATE agent_ownership_epochs SET revision = lower(hex(randomblob(16))) WHERE run_id = OLD.run_id;
    END;
  `);
}

type Access = {
  publicationPermitsWorkspaceStop(runId: string, operationId: string): boolean | null;
  creationPermitsWorkspaceStop(runId: string, operationId: string): boolean | null;
  inspectionPermitsWorkspaceStop(runId: string, operationId: string): boolean | null;
  captureInterruptedBeforeLaunch(runId: string, operationId: string): boolean;
  validationInterruptedBeforeLaunch(runId: string, operationId: string): boolean;
  transaction<T>(authority: ControllerAuthority, body: () => T): T;
  control(runId: string): ControlState;
  policy(runId: string): RepositoryPolicy;
  observe(authority: ControllerAuthority, input: ObservationInput): unknown;
  publicationPending(runId: string): import("../domain/publication.js").PublicationRecord | null;
  assertTrackerCommitIdle(runId: string): void;
  deliveryRepository(runId: string): import("../domain/publication.js").DeliveryRepository | null;
  assertTaskOwned(
    runId: string,
    taskId: string | null,
  ): import("../domain/tracker.js").TaskClaimBinding | undefined;
  bindEpicRepair(
    runId: string,
    taskId: string | null,
    candidateId: string | null,
    workspace: WorkspaceIdentity,
  ): import("../domain/tracker.js").EpicRepairBinding;
  assertEpicRepair(
    runId: string,
    taskId: string | null,
    binding: import("../domain/tracker.js").EpicRepairBinding,
    workspace: WorkspaceIdentity,
    requireLatestBase: boolean,
  ): void;
  epicReviewTarget(runId: string, taskId: string | null, candidateId: string | null): boolean;
  epicRepairContext(runId: string): unknown;
};
export class AgentCoordinationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentCoordinationError";
  }
}
type NewAssignment = Pick<AgentAssignment, "purpose" | "taskId" | "candidateId" | "instructions">;
type NewAgent = WorkspaceIdentity &
  NewAssignment & {
    role: AgentRole;
    contract: AgentSessionContract;
    confinementProfile: string;
    replaces?: AgentIdentity;
    conversationTransferId?: string;
  };
const terminal = (turn: TurnRecord) => turn.stopEvidence !== null;
const now = () => new Date().toISOString();
const agentIdentityKey = (identity: AgentIdentity) =>
  `${identity.agentId}/${identity.agentGeneration}`;
const JsonValueSchema = z.json();
type ProviderIdentityInput = z.input<typeof ProviderIdentitySchema>;
type JsonValue = z.infer<typeof JsonValueSchema>;
export type RecoveryTurn = {
  rowId: number;
  identity: TurnIdentity | null;
  turn: TurnRecord | null;
  failure: unknown | null;
  ownerValidity: "readable" | "unreadable" | "not_required";
};
export type AgentRecoveryIncident = {
  rowId: number;
  identity: AgentIdentity;
  recordDigest: string;
  state: "isolated" | "uncontained";
  ownerRecordReadable: boolean;
  affectedTurnIds: string[];
  affectedMessageIds: string[];
};
/** Availability assessment, never a substitute for exact execution/absence proofs. */
export type AgentOwnershipAssessment =
  | { state: "valid"; agent: AgentInstance }
  | {
      state: "isolated" | "uncontained";
      incident: AgentRecoveryIncident;
      /** Present only when the owner row itself is valid and associated history caused the incident. */
      agent: AgentInstance | null;
    };
export type OperationalTurnEntry = {
  turn: TurnRecord;
  owner:
    { state: "valid"; role: AgentRole } | { state: "isolated"; role: "orchestrator" | "worker" };
};
type OwnershipAgentRow = {
  rowid: number;
  agent_id: string;
  generation: number;
  workspace_id: string;
  workspace_generation: number;
  record_json: string;
  revision: string | null;
  workspace_revision: string | null;
};
type OwnershipTurnRow = {
  rowid: number;
  turn_id: string;
  agent_id: string;
  agent_generation: number;
  record_json: string;
};
type OwnershipMessageRow = {
  message_id: string;
  agent_id: string;
  agent_generation: number;
  record_json: string;
};
type OwnershipCacheEntry = {
  revision: string | null;
  workspaceRevision: string | null;
  assessment: AgentOwnershipAssessment;
  turns: { rowId: number; turn: TurnRecord }[];
};
class InvalidTurnRecordError extends Error {}
function expectedTurnRecoveryFailure(error: unknown): boolean {
  return (
    error instanceof z.ZodError ||
    error instanceof InvalidTurnRecordError ||
    (error instanceof AgentCoordinationError && error.code === "unknown_agent")
  );
}
function redactResult(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactSensitiveText(value, Infinity);
  if (Array.isArray(value)) return value.map(redactResult);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:password|token|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|authorization|cookie|storageState|ownerToken)$/i.test(
          key,
        )
          ? "[REDACTED]"
          : redactResult(item),
      ]),
    );
  return value;
}
const safeText = (value: string, max = 16000) =>
  redactSensitiveText(z.string().min(1).max(max).parse(value), max - 1);

/** Parsed JSON is acyclic. Readers cannot alter another predicate's cached turn witness. */
function freezeReadRecords(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeReadRecords(child);
  Object.freeze(value);
}

/** Durable coordination only. Provider calls and filesystem effects occur outside these transactions. */
export class AgentJournal {
  private snapshotTurns: Map<string, TurnRecord[]> | null = null;
  private snapshotOperationalTurns: Map<string, OperationalTurnEntry[]> | null = null;
  private snapshotOwnership: Map<string, Map<string, AgentOwnershipAssessment>> | null = null;
  private readonly ownershipCache = new Map<
    string,
    { revision: string | null; entries: Map<string, OwnershipCacheEntry> }
  >();

  constructor(
    private readonly db: Database.Database,
    private readonly access: Access,
  ) {}

  /** Internal read-side scope; the owning journal must establish a read-only SQL snapshot. */
  withReadSnapshot<T>(read: () => T): T {
    if (!this.db.inTransaction || this.db.pragma("query_only", { simple: true }) !== 1)
      throw new Error("Turn read snapshots require a read-only database transaction");
    if (this.snapshotTurns !== null) return read();
    this.snapshotTurns = new Map();
    this.snapshotOperationalTurns = new Map();
    this.snapshotOwnership = new Map();
    try {
      return read();
    } finally {
      this.snapshotTurns = null;
      this.snapshotOperationalTurns = null;
      this.snapshotOwnership = null;
    }
  }

  /** Internal write-side scope; non-repeating ownership tokens make savepoint rollback self-invalidating. */
  withWriteTransaction<T>(write: () => T): T {
    if (!this.db.inTransaction || this.db.pragma("query_only", { simple: true }) === 1)
      throw new Error("Ownership write caching requires a writable, non-readonly transaction");
    if (this.snapshotOwnership !== null)
      throw new Error("A read snapshot cannot become a writable ownership transaction");
    return write();
  }

  reserveWorkspace(
    authority: ControllerAuthority,
    input: {
      root: string;
      purpose: WorkspaceRecord["purpose"];
      sourceMode: WorkspaceRecord["sourceMode"];
      baselineRevision: string;
      creationOperationId?: string;
    },
    expectedControlVersion: number,
  ): WorkspaceRecord {
    return this.access.transaction(authority, () => {
      this.active(authority, expectedControlVersion);
      const publication = this.access.publicationPending(authority.runId);
      if (
        publication &&
        !(input.purpose === "coordinator" && input.sourceMode === "immutable") &&
        !(
          input.purpose === "delivery" &&
          input.creationOperationId ===
            this.access.deliveryRepository(authority.runId)?.creationOperationId
        )
      )
        throw new AgentCoordinationError(
          "publication_unsettled",
          "Publication excludes new worker workspaces",
        );
      if (
        input.creationOperationId &&
        this.workspaceForOperation(authority.runId, input.creationOperationId)
      )
        throw new AgentCoordinationError(
          "workspace_creation_uncertain",
          "Workspace creation already has a reservation; reconcile it instead of copying again",
        );
      if (!isAbsolute(input.root) || resolve(input.root) === parsePath(input.root).root)
        throw new AgentCoordinationError(
          "invalid_workspace_root",
          "Workspace root must be a private absolute directory",
        );
      const workspaceId = randomUUID();
      const at = now();
      const workspace = WorkspaceRecordSchema.parse({
        schemaVersion: 1,
        runId: authority.runId,
        workspaceId,
        workspaceGeneration: 1,
        path: join(resolve(input.root), authority.runId, workspaceId),
        directory: null,
        purpose: input.purpose,
        sourceMode: input.sourceMode,
        baselineRevision: input.baselineRevision,
        baselineFingerprint: null,
        creationOperationId: input.creationOperationId ?? null,
        status: "reserved",
        activeTurnId: null,
        createdAt: at,
        updatedAt: at,
      });
      this.db
        .prepare(
          "INSERT INTO workspaces(workspace_id, run_id, generation, path, record_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run(workspaceId, authority.runId, 1, workspace.path, JSON.stringify(workspace));
      this.changed(authority, "workspace.reserved", workspaceId);
      return workspace;
    });
  }

  /** The workspace adapter calls this only after materialization and fingerprint verification. */
  markWorkspaceReady(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    fingerprint: string,
  ): WorkspaceRecord {
    return this.access.transaction(authority, () => {
      const workspace = this.workspace(authority.runId, identity);
      if (
        workspace.status !== "reserved" ||
        !lstatSync(workspace.path).isDirectory() ||
        realpathSync(workspace.path) !== workspace.path
      )
        throw new AgentCoordinationError(
          "workspace_not_reserved",
          "Workspace is not a reserved canonical directory",
        );
      workspace.status = "ready";
      const directory = lstatSync(workspace.path, { bigint: true });
      workspace.directory = {
        path: workspace.path,
        device: directory.dev.toString(),
        inode: directory.ino.toString(),
      };
      workspace.baselineFingerprint = z.string().min(1).max(256).parse(fingerprint);
      this.saveWorkspace(workspace);
      this.changed(authority, "workspace.ready", workspace.workspaceId);
      return workspace;
    });
  }

  workspace(runId: string, identity: WorkspaceIdentity): WorkspaceRecord {
    return this.read(
      WorkspaceRecordSchema,
      "SELECT record_json FROM workspaces WHERE run_id = ? AND workspace_id = ? AND generation = ?",
      [runId, identity.workspaceId, identity.workspaceGeneration],
      "unknown_workspace",
    );
  }

  workspaceForOperation(runId: string, operationId: string): WorkspaceRecord | null {
    return (
      this.all(
        WorkspaceRecordSchema,
        "SELECT record_json FROM workspaces WHERE run_id = ? AND json_extract(record_json, '$.creationOperationId') = ?",
        [runId, operationId],
      )[0] ?? null
    );
  }

  workspaces(runId: string): WorkspaceRecord[] {
    return this.all(
      WorkspaceRecordSchema,
      "SELECT record_json FROM workspaces WHERE run_id = ? ORDER BY workspace_id",
      [runId],
    );
  }

  /** Retire a disposable copy atomically with its cleanup intent, without revoking historical evidence. */
  retireWorkspace(authority: ControllerAuthority, identity: WorkspaceIdentity): WorkspaceRecord {
    return this.access.transaction(authority, () => {
      this.active(authority);
      this.access.assertTrackerCommitIdle(authority.runId);
      if (this.access.publicationPending(authority.runId))
        throw new AgentCoordinationError(
          "publication_unsettled",
          "Settle publication before workspace disposal",
        );
      const workspace = this.workspace(authority.runId, identity);
      if (["delivery", "implementation"].includes(workspace.purpose))
        throw new AgentCoordinationError(
          "workspace_dependency",
          "Delivery and implementation object sources must remain available; dispose only independent copies",
        );
      if (!["ready", "quarantined", "retired"].includes(workspace.status) || !workspace.directory)
        throw new AgentCoordinationError(
          "workspace_unavailable",
          "Disposal requires a registered materialized copy",
        );
      if (workspace.activeTurnId || this.activeWorkspaceOperation(authority.runId, identity))
        throw new AgentCoordinationError(
          "workspace_busy",
          "Reconcile every workspace writer before disposal",
        );
      if (
        this.db
          .prepare(
            `SELECT 1 FROM agent_conversation_transfers transfer
             JOIN agent_instances source ON source.run_id = transfer.run_id
               AND source.agent_id = transfer.source_agent_id
               AND source.generation = transfer.source_agent_generation
             WHERE transfer.run_id = ? AND transfer.status IN ('pending','claimed')
               AND source.workspace_id = ? AND source.workspace_generation = ? LIMIT 1`,
          )
          .get(authority.runId, workspace.workspaceId, workspace.workspaceGeneration)
      )
        throw new AgentCoordinationError(
          "conversation_transfer_open",
          "Consume or explicitly abandon the coordinator conversation before disposing its workspace",
        );
      const agents = this.all(
        AgentInstanceSchema,
        "SELECT record_json FROM agent_instances WHERE run_id = ? AND workspace_id = ? AND workspace_generation = ? ORDER BY rowid",
        [authority.runId, workspace.workspaceId, workspace.workspaceGeneration],
      );
      if (
        workspace.purpose === "coordinator" &&
        agents.some((agent) => agent.status !== "released")
      )
        throw new AgentCoordinationError(
          "coordinator_owned",
          "Only already-retired coordinator copies may be disposed",
        );
      for (const turn of this.operationalTurns(authority.runId)) {
        if (
          turn.identity.workspaceId !== workspace.workspaceId ||
          turn.identity.workspaceGeneration !== workspace.workspaceGeneration
        )
          continue;
        if (!turn.stopEvidence || (turn.launch !== null && turn.launch.stop === null))
          throw new AgentCoordinationError(
            "workspace_busy",
            "Every exact turn and launch needs confirmed stop before disposal",
          );
        if (turn.launch?.native && turn.launch.stop?.kind === "not_started")
          throw new AgentCoordinationError(
            "native_shell_unsettled",
            "A native launch that never started may leave its host shell alive; preserve the workspace and resolve terminal ownership separately",
          );
      }
      for (const agent of agents)
        this.retireStoppedAgent(
          authority,
          agent,
          "Workspace disposal; provider and evidence records retained",
        );
      workspace.status = "retired";
      this.saveWorkspace(workspace);
      this.changed(authority, "workspace.retired", workspace.workspaceId);
      return workspace;
    });
  }

  /** Called only with a journaled disposal outcome; the historical registration path is immutable. */
  finishWorkspaceDisposal(authority: ControllerAuthority, identity: WorkspaceIdentity): void {
    this.access.transaction(authority, () => {
      const workspace = this.workspace(authority.runId, identity);
      if (workspace.status !== "retired" && workspace.status !== "disposed")
        throw new AgentCoordinationError(
          "workspace_not_retired",
          "Retire workspace authority before settling disposal",
        );
      workspace.status = "disposed";
      this.saveWorkspace(workspace);
      this.changed(authority, "workspace.disposed", workspace.workspaceId);
    });
  }

  /** Synchronous admission shares the same transaction as agent turn admission. */
  beginWorkspaceOperation(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    kind: WorkspaceOperation["kind"],
    expectedControlVersion: number,
  ): WorkspaceOperation {
    return this.access.transaction(authority, () => {
      // inspect_materialization also covers commit/publication recovery reads.
      // It requires current authority and exclusive custody, even when delivery is paused.
      // Completion proves every operation stopped; it cannot admit a new recovery read.
      if (
        kind !== "inspect_materialization" ||
        this.access.control(authority.runId).status === "complete"
      )
        this.active(authority, expectedControlVersion);
      const workspace = this.workspace(authority.runId, identity);
      const publication = this.access.publicationPending(authority.runId);
      if (
        workspace.purpose !== "coordinator" &&
        kind !== "inspect_materialization" &&
        kind !== "publication"
      )
        this.access.assertTrackerCommitIdle(authority.runId);
      if (
        publication &&
        kind !== "inspect_materialization" &&
        !(
          workspace.purpose === "coordinator" &&
          workspace.sourceMode === "immutable" &&
          kind === "materialize"
        ) &&
        !(
          workspace.purpose === "delivery" &&
          workspace.creationOperationId ===
            this.access.deliveryRepository(authority.runId)?.creationOperationId &&
          (kind === "materialize" || kind === "publication")
        )
      )
        throw new AgentCoordinationError(
          "publication_unsettled",
          "Publication excludes other workspace mutations",
        );
      const allowed =
        kind === "materialize"
          ? workspace.status === "reserved"
          : kind === "inspect_materialization"
            ? ["reserved", "ready"].includes(workspace.status)
            : workspace.status === "ready";
      if (
        !allowed ||
        workspace.activeTurnId ||
        this.activeWorkspaceOperation(authority.runId, identity)
      )
        throw new AgentCoordinationError(
          "workspace_busy",
          "Workspace is unavailable or a process may still be writing it",
        );
      const at = now();
      const operation = WorkspaceOperationSchema.parse({
        schemaVersion: 1,
        runId: authority.runId,
        operationId: randomUUID(),
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
        controllerLeaseId: authority.leaseId,
        kind,
        status: "running",
        stopEvidence: null,
        execution: null,
        executionStop: null,
        createdAt: at,
        updatedAt: at,
      });
      this.db
        .prepare(
          "INSERT INTO workspace_operations(operation_id, run_id, workspace_id, workspace_generation, record_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          operation.operationId,
          authority.runId,
          workspace.workspaceId,
          workspace.workspaceGeneration,
          JSON.stringify(operation),
        );
      this.changed(authority, "workspace.operation_started", operation.operationId);
      return operation;
    });
  }

  activeWorkspaceOperation(runId: string, identity: WorkspaceIdentity): WorkspaceOperation | null {
    return (
      this.all(
        WorkspaceOperationSchema,
        "SELECT record_json FROM workspace_operations WHERE run_id = ? AND workspace_id = ? AND workspace_generation = ? AND json_extract(record_json, '$.stopEvidence') IS NULL",
        [runId, identity.workspaceId, identity.workspaceGeneration],
      )[0] ?? null
    );
  }

  workspaceOperation(runId: string, operationId: string): WorkspaceOperation {
    return this.read(
      WorkspaceOperationSchema,
      "SELECT record_json FROM workspace_operations WHERE run_id = ? AND operation_id = ?",
      [runId, operationId],
      "unknown_workspace_operation",
    );
  }

  /** Only the trusted adapter calls this after every awaited I/O/process has settled. */
  finishWorkspaceOperation(
    authority: ControllerAuthority,
    operationId: string,
    status: "succeeded" | "failed",
    stopEvidence: string,
  ): WorkspaceOperation {
    return this.access.transaction(authority, () => {
      const operation = this.workspaceOperation(authority.runId, operationId);
      const creationStop = this.access.creationPermitsWorkspaceStop(authority.runId, operationId);
      const inspectionStop = this.access.inspectionPermitsWorkspaceStop(
        authority.runId,
        operationId,
      );
      const publicationStop = this.access.publicationPermitsWorkspaceStop(
        authority.runId,
        operationId,
      );
      if (publicationStop === false)
        throw new AgentCoordinationError(
          "publication_io_unsettled",
          "The complete publication worker has not stopped; preserve every publication exclusion",
        );
      if (creationStop === false)
        throw new AgentCoordinationError(
          "workspace_creation_unsettled",
          "The complete creation worker has not stopped; preserve every copy exclusion",
        );
      if (inspectionStop === false)
        throw new AgentCoordinationError(
          "workspace_inspection_unsettled",
          "The complete inspection worker has not stopped; preserve its source exclusion",
        );
      const independentlyStopped = operation.execution !== null && operation.executionStop !== null;
      const unlaunchedValidation =
        operation.kind === "validation" &&
        operation.execution === null &&
        this.access.validationInterruptedBeforeLaunch(authority.runId, operationId);
      const unlaunchedCapture =
        operation.kind === "capture" &&
        operation.execution === null &&
        this.access.captureInterruptedBeforeLaunch(authority.runId, operationId);
      if (operation.execution && !operation.executionStop)
        throw new AgentCoordinationError(
          "workspace_execution_unsettled",
          "The complete workspace worker has no independent stop receipt",
        );
      if (
        operation.controllerLeaseId !== authority.leaseId &&
        !independentlyStopped &&
        creationStop !== true &&
        inspectionStop !== true &&
        publicationStop !== true &&
        !unlaunchedValidation &&
        !unlaunchedCapture
      )
        throw new AgentCoordinationError(
          "workspace_operation_uncertain",
          "Previous controller's I/O requires independent stop reconciliation",
        );
      if (operation.stopEvidence !== null) {
        if (operation.status !== status || operation.stopEvidence !== safeText(stopEvidence, 4000))
          throw new AgentCoordinationError(
            "workspace_operation_conflict",
            "Workspace operation already has a different terminal outcome",
          );
        return operation;
      }
      operation.status = status;
      operation.stopEvidence = safeText(stopEvidence, 4000);
      operation.updatedAt = now();
      this.db
        .prepare(
          "UPDATE workspace_operations SET record_json = ? WHERE run_id = ? AND operation_id = ?",
        )
        .run(
          JSON.stringify(WorkspaceOperationSchema.parse(operation)),
          authority.runId,
          operationId,
        );
      this.changed(authority, "workspace.operation_stopped", operation.operationId);
      return operation;
    });
  }

  /** Bind once before a fixed workspace worker may execute repository or service I/O. */
  bindWorkspaceExecution(
    authority: ControllerAuthority,
    operationId: string,
    input: CommandLifetime,
  ) {
    return this.access.transaction(authority, () => {
      this.active(authority);
      const operation = this.workspaceOperation(authority.runId, operationId);
      const execution = CommandLifetimeSchema.parse(input);
      if (
        !["validation", "commit", "capture"].includes(operation.kind) ||
        this.access.creationPermitsWorkspaceStop(authority.runId, operationId) !== null ||
        this.access.inspectionPermitsWorkspaceStop(authority.runId, operationId) !== null ||
        this.access.publicationPermitsWorkspaceStop(authority.runId, operationId) !== null ||
        operation.controllerLeaseId !== authority.leaseId ||
        operation.stopEvidence ||
        operation.execution ||
        this.access.validationInterruptedBeforeLaunch(authority.runId, operationId) ||
        this.access.captureInterruptedBeforeLaunch(authority.runId, operationId) ||
        execution.runId !== authority.runId ||
        execution.operationId !== operationId ||
        execution.controllerLeaseId !== operation.controllerLeaseId ||
        execution.scopeDigest !== workspaceExecutionScope(operation)
      )
        throw new AgentCoordinationError(
          "workspace_execution_conflict",
          "Workspace execution requires its original unused validation, commit or capture operation",
        );
      operation.execution = execution;
      this.db
        .prepare("UPDATE workspace_operations SET record_json=? WHERE run_id=? AND operation_id=?")
        .run(
          JSON.stringify(WorkspaceOperationSchema.parse(operation)),
          authority.runId,
          operationId,
        );
      this.changed(authority, "workspace.execution_bound", operationId);
      return operation;
    });
  }

  /** Receipt bytes come only from the kernel's private I/O reader, never an action payload. */
  recordWorkspaceExecutionStop(
    authority: ControllerAuthority,
    operationId: string,
    input: CommandStop,
  ) {
    return this.access.transaction(authority, () => {
      const operation = this.workspaceOperation(authority.runId, operationId);
      if (!operation.execution)
        throw new AgentCoordinationError(
          "workspace_execution_missing",
          "Workspace has no bound execution",
        );
      const receipt = CommandStopSchema.parse(input);
      assertCommandStop(operation.execution, receipt);
      if (operation.executionStop) {
        if (digestJson(operation.executionStop) !== digestJson(receipt))
          throw new AgentCoordinationError(
            "workspace_execution_conflict",
            "Workspace already retained a different stop receipt",
          );
        return operation;
      }
      operation.executionStop = receipt;
      this.db
        .prepare("UPDATE workspace_operations SET record_json=? WHERE run_id=? AND operation_id=?")
        .run(
          JSON.stringify(WorkspaceOperationSchema.parse(operation)),
          authority.runId,
          operationId,
        );
      this.changed(authority, "workspace.execution_stopped", operationId);
      return operation;
    });
  }
  instances(runId: string): AgentInstance[] {
    return this.all(
      AgentInstanceSchema,
      "SELECT record_json FROM agent_instances WHERE run_id = ? ORDER BY rowid",
      [runId],
    );
  }
  operationalInstances(runId: string): AgentInstance[] {
    return [...this.ownershipInventory(runId).values()].flatMap((assessment) =>
      assessment.state === "valid" ? [assessment.agent] : [],
    );
  }
  /** Allocation history must include owners omitted from operational projections. */
  coordinatorGenerationCount(runId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM agent_instances a JOIN workspaces w ON w.run_id = a.run_id AND w.workspace_id = a.workspace_id AND w.generation = a.workspace_generation WHERE a.run_id = ? AND json_extract(w.record_json, '$.purpose') = 'coordinator'",
      )
      .get(runId) as { count: number };
    return row.count;
  }
  /** Relational identity is authoritative when proving that a workspace was never assigned. */
  workspaceWasAssigned(runId: string, identity: WorkspaceIdentity): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM agent_instances WHERE run_id = ? AND workspace_id = ? AND workspace_generation = ? LIMIT 1",
      )
      .get(runId, identity.workspaceId, identity.workspaceGeneration);
  }
  /** Malformed ownership is a conflict, never evidence that a workspace is available. */
  workspaceHasNonReleasedOwner(runId: string, identity: WorkspaceIdentity): boolean {
    return this.workspaceHasConflictingOwner(runId, identity, new Set());
  }

  /** A validated transfer may cross only its own isolated, stopped historical owners. */
  private workspaceHasConflictingOwner(
    runId: string,
    identity: WorkspaceIdentity,
    isolatedTransferAncestors: ReadonlySet<string>,
  ): boolean {
    const rows = this.db
      .prepare(
        "SELECT agent_id, generation, record_json FROM agent_instances WHERE run_id = ? AND workspace_id = ? AND workspace_generation = ?",
      )
      .all(runId, identity.workspaceId, identity.workspaceGeneration) as {
      agent_id: string;
      generation: number;
      record_json: string;
    }[];
    return rows.some(({ agent_id, generation, record_json }) => {
      const parsed = AgentInstanceSchema.safeParse(JSON.parse(record_json));
      if (parsed.success) return parsed.data.status !== "released";
      return !isolatedTransferAncestors.has(
        agentIdentityKey({ agentId: agent_id, agentGeneration: generation }),
      );
    });
  }
  /** Invalid historical assignments conservatively disqualify independence. */
  agentHadPurpose(runId: string, agentId: string, purposes: readonly string[]): boolean {
    const rows = this.db
      .prepare(
        "SELECT record_json FROM agent_assignments WHERE run_id = ? AND agent_id = ? ORDER BY rowid",
      )
      .all(runId, agentId) as { record_json: string }[];
    return rows.some(({ record_json }) => {
      const parsed = AgentAssignmentSchema.safeParse(JSON.parse(record_json));
      return !parsed.success || purposes.includes(parsed.data.purpose);
    });
  }
  /** Completion inventories relational resources even when one payload is unreadable. */
  assignmentIds(runId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT assignment_id FROM agent_assignments WHERE run_id = ? ORDER BY assignment_id",
        )
        .all(runId) as { assignment_id: string }[]
    ).map(({ assignment_id }) => assignment_id);
  }
  recoveryIntegrity(runId: string): AgentRecoveryIncident[] {
    return [...this.ownershipInventory(runId).values()].flatMap((assessment) =>
      assessment.state === "valid" ? [] : [assessment.incident],
    );
  }

  /** Reused within one immutable read snapshot and refreshed per changed owner. */
  ownershipAssessment(runId: string, identity: AgentIdentity): AgentOwnershipAssessment {
    const assessment = this.ownershipInventory(runId).get(agentIdentityKey(identity));
    if (!assessment)
      throw new AgentCoordinationError("unknown_agent", "Unknown agent ownership identity");
    return assessment;
  }

  private ownershipInventory(runId: string): Map<string, AgentOwnershipAssessment> {
    const cached = this.snapshotOwnership?.get(runId);
    if (cached) return cached;
    const entries = this.ownershipEntries(runId);
    const inventory = new Map<string, AgentOwnershipAssessment>();
    for (const [key, entry] of entries)
      inventory.set(
        key,
        this.snapshotOwnership === null ? structuredClone(entry.assessment) : entry.assessment,
      );
    if (this.snapshotOwnership !== null) this.snapshotOwnership.set(runId, inventory);
    return inventory;
  }

  /**
   * Integrity changes are versioned by owner inside the same SQLite transaction as
   * their durable rows. Savepoint rollback therefore rolls the version back too,
   * and unchanged historical owners never need their turn/mailbox payloads parsed
   * again merely because another owner advanced.
   */
  private ownershipEntries(runId: string): Map<string, OwnershipCacheEntry> {
    const revisionRow = this.db
      .prepare("SELECT revision FROM agent_ownership_epochs WHERE run_id = ?")
      .get(runId) as { revision: string } | undefined;
    const revision = revisionRow?.revision ?? null;
    const cached = this.ownershipCache.get(runId);
    if (revision !== null && cached?.revision === revision) return cached.entries;
    const rows = this.db
      .prepare(
        `SELECT agent.rowid, agent.agent_id, agent.generation, agent.workspace_id,
                agent.workspace_generation, agent.record_json, revision.revision,
                workspace_revision.revision AS workspace_revision
         FROM agent_instances agent
         LEFT JOIN agent_ownership_revisions revision
           ON revision.run_id = agent.run_id AND revision.agent_id = agent.agent_id
             AND revision.generation = agent.generation
         LEFT JOIN workspace_ownership_revisions workspace_revision
           ON workspace_revision.run_id = agent.run_id
             AND workspace_revision.workspace_id = agent.workspace_id
             AND workspace_revision.generation = agent.workspace_generation
         WHERE agent.run_id = ? ORDER BY agent.rowid`,
      )
      .all(runId) as OwnershipAgentRow[];
    const prior = cached?.entries;
    const inventory = new Map<string, OwnershipCacheEntry>();
    if (prior === undefined) {
      const turnRows = this.db
        .prepare(
          "SELECT rowid, turn_id, agent_id, agent_generation, record_json FROM agent_turns WHERE run_id = ? ORDER BY rowid",
        )
        .all(runId) as OwnershipTurnRow[];
      const messageRows = this.db
        .prepare(
          "SELECT message_id, agent_id, agent_generation, record_json FROM agent_messages WHERE run_id = ? ORDER BY rowid",
        )
        .all(runId) as OwnershipMessageRow[];
      const turnsByOwner = new Map<string, OwnershipTurnRow[]>();
      for (const turn of turnRows) {
        const key = agentIdentityKey({
          agentId: turn.agent_id,
          agentGeneration: turn.agent_generation,
        });
        const owned = turnsByOwner.get(key) ?? [];
        owned.push(turn);
        turnsByOwner.set(key, owned);
      }
      const messagesByOwner = new Map<string, OwnershipMessageRow[]>();
      for (const message of messageRows) {
        const key = agentIdentityKey({
          agentId: message.agent_id,
          agentGeneration: message.agent_generation,
        });
        const owned = messagesByOwner.get(key) ?? [];
        owned.push(message);
        messagesByOwner.set(key, owned);
      }
      for (const row of rows) {
        const key = agentIdentityKey({
          agentId: row.agent_id,
          agentGeneration: row.generation,
        });
        inventory.set(
          key,
          this.assessOwnership(
            runId,
            row,
            turnsByOwner.get(key) ?? [],
            messagesByOwner.get(key) ?? [],
          ),
        );
      }
    } else {
      for (const row of rows) {
        const key = agentIdentityKey({
          agentId: row.agent_id,
          agentGeneration: row.generation,
        });
        const existing = prior.get(key);
        if (
          row.revision !== null &&
          existing?.revision === row.revision &&
          (existing.assessment.state === "valid" ||
            (row.workspace_revision !== null &&
              existing.workspaceRevision === row.workspace_revision))
        ) {
          inventory.set(key, existing);
          continue;
        }
        const turns = this.db
          .prepare(
            "SELECT rowid, turn_id, agent_id, agent_generation, record_json FROM agent_turns WHERE run_id = ? AND agent_id = ? AND agent_generation = ? ORDER BY rowid",
          )
          .all(runId, row.agent_id, row.generation) as OwnershipTurnRow[];
        const messages = this.db
          .prepare(
            "SELECT message_id, agent_id, agent_generation, record_json FROM agent_messages WHERE run_id = ? AND agent_id = ? AND agent_generation = ? ORDER BY rowid",
          )
          .all(runId, row.agent_id, row.generation) as OwnershipMessageRow[];
        inventory.set(key, this.assessOwnership(runId, row, turns, messages));
      }
    }
    this.ownershipCache.set(runId, { revision, entries: inventory });
    return inventory;
  }

  private assessOwnership(
    runId: string,
    row: OwnershipAgentRow,
    turns: OwnershipTurnRow[],
    messages: OwnershipMessageRow[],
  ): OwnershipCacheEntry {
    const identity = { agentId: row.agent_id, agentGeneration: row.generation };
    const parsedAgent = AgentInstanceSchema.safeParse(JSON.parse(row.record_json));
    const parsedTurns: { rowId: number; turn: TurnRecord }[] = [];
    let activeWorkspaceTurnId: string | null = null;
    let contained = true;
    if (!parsedAgent.success)
      try {
        const workspace = this.workspace(runId, {
          workspaceId: row.workspace_id,
          workspaceGeneration: row.workspace_generation,
        });
        if (workspace.activeTurnId) {
          const activeOwner = this.db
            .prepare(
              "SELECT agent_id, agent_generation FROM agent_turns WHERE run_id = ? AND turn_id = ?",
            )
            .get(runId, workspace.activeTurnId) as
            { agent_id: string; agent_generation: number } | undefined;
          // Coordinator workspaces survive runtime handoff. An active turn on
          // the shared workspace belongs to the relationally named generation,
          // not every historical owner that once used the workspace.
          if (!activeOwner) contained = false;
          else if (
            activeOwner.agent_id === row.agent_id &&
            activeOwner.agent_generation === row.generation
          )
            activeWorkspaceTurnId = workspace.activeTurnId;
        }
        if (this.activeWorkspaceOperation(runId, workspace)) contained = false;
      } catch (error) {
        if (!(error instanceof z.ZodError) && !(error instanceof AgentCoordinationError))
          throw error;
        contained = false;
      }
    for (const item of turns) {
      const parsed = TurnRecordSchema.safeParse(JSON.parse(item.record_json));
      if (!parsed.success) {
        contained = false;
        continue;
      }
      try {
        if (parsedAgent.success) this.validateTurnAgainstAgent(parsed.data, parsedAgent.data);
        else this.validateTurnIntrinsic(parsed.data);
      } catch (error) {
        if (!(error instanceof InvalidTurnRecordError)) throw error;
        contained = false;
        continue;
      }
      parsedTurns.push({ rowId: item.rowid, turn: parsed.data });
      if (!parsedAgent.success && !this.ownerIndependentTurnContained(parsed.data))
        contained = false;
    }
    if (
      activeWorkspaceTurnId !== null &&
      !parsedTurns.some(
        ({ turn }) =>
          turn.identity.turnId === activeWorkspaceTurnId &&
          this.ownerIndependentTurnContained(turn),
      )
    )
      contained = false;
    for (const item of messages) {
      const parsed = AgentMailboxMessageSchema.safeParse(JSON.parse(item.record_json));
      if (
        !parsed.success ||
        parsed.data.messageId !== item.message_id ||
        parsed.data.runId !== runId ||
        parsed.data.agentId !== row.agent_id ||
        parsed.data.agentGeneration !== row.generation
      )
        contained = false;
    }
    let assessment: AgentOwnershipAssessment;
    if (parsedAgent.success && contained) assessment = { state: "valid", agent: parsedAgent.data };
    else {
      const incident: AgentRecoveryIncident = {
        rowId: row.rowid,
        identity,
        recordDigest: digestJson([
          row.record_json,
          ...turns.map((turn) => turn.record_json),
          ...messages.map((message) => message.record_json),
        ]),
        state: contained ? "isolated" : "uncontained",
        ownerRecordReadable: parsedAgent.success,
        affectedTurnIds: turns.map((turn) => turn.turn_id),
        affectedMessageIds: messages.map((message) => message.message_id),
      };
      assessment = {
        state: incident.state,
        incident,
        agent: parsedAgent.success ? parsedAgent.data : null,
      };
    }
    const entry = {
      revision: row.revision,
      workspaceRevision: row.workspace_revision,
      assessment,
      turns: parsedTurns,
    };
    freezeReadRecords(entry);
    return entry;
  }

  private ownerIndependentTurnContained(turn: TurnRecord): boolean {
    if (turn.status === "prepared")
      return turn.launch === null && turn.submissionAcknowledgement === null;
    if (turn.launch !== null) return turn.launch.stop !== null;
    return terminal(turn);
  }
  summaries(runId: string) {
    // Status/context views remain useful during recovery even when one durable
    // agent row is unreadable. Strict instances() is retained for ordinary
    // callers; this projection reports the unreadable count without exposing
    // partially parsed execution or account data.
    const assessments = [...this.ownershipInventory(runId).values()];
    let unreadableInstances = assessments.filter(
      (entry) => entry.state !== "valid" && !entry.incident.ownerRecordReadable,
    ).length;
    const instances = assessments.flatMap((entry) =>
      entry.state === "valid" || entry.agent
        ? [{ agent: entry.agent!, ownershipState: entry.state }]
        : [],
    );
    const visible = instances.filter(
      ({ agent }) => agent.activeTurnId !== null || !["revoked", "released"].includes(agent.status),
    );
    // Active/uncertain turns take precedence over idle conversations in bounded context.
    visible.sort(
      (left, right) =>
        Number(right.agent.activeTurnId !== null) - Number(left.agent.activeTurnId !== null),
    );
    const summaries = visible.slice(0, 20).flatMap(({ agent, ownershipState }) => {
      try {
        const assignment = this.assignment(runId, agent.assignmentId);
        return [
          {
            agentId: agent.agentId,
            agentGeneration: agent.agentGeneration,
            role: agent.role,
            purpose: assignment.purpose,
            taskId: assignment.taskId,
            status: agent.status,
            activeTurnId: agent.activeTurnId,
            workspaceId: agent.workspaceId,
            workspaceGeneration: agent.workspaceGeneration,
            backend: agent.contract.backend,
            runtime: agent.contract.runtime,
            ...(ownershipState === "valid" ? {} : { ownershipState }),
          },
        ];
      } catch {
        unreadableInstances += 1;
        return [];
      }
    });
    const integrity = assessments.flatMap((entry) =>
      entry.state === "valid" ? [] : [entry.incident],
    );
    return {
      omittedInstances: Math.max(0, visible.length - 20),
      unreadableInstances,
      isolatedUnreadableOwners: integrity.filter((incident) => incident.state === "isolated")
        .length,
      uncontainedUnreadableOwners: integrity.filter(
        (incident) => incident.state === "uncontained" && !incident.ownerRecordReadable,
      ).length,
      uncontainedReadableOwners: integrity.filter(
        (incident) => incident.state === "uncontained" && incident.ownerRecordReadable,
      ).length,
      instances: summaries,
    };
  }
  instance(runId: string, identity: AgentIdentity): AgentInstance {
    return this.read(
      AgentInstanceSchema,
      "SELECT record_json FROM agent_instances WHERE run_id = ? AND agent_id = ? AND generation = ?",
      [runId, identity.agentId, identity.agentGeneration],
      "unknown_agent",
    );
  }
  /** Existence is a relational fact, even when a transfer record cannot be decoded. */
  hasOpenConversationTransfers(runId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM agent_conversation_transfers WHERE run_id = ? AND status IN ('pending','claimed') LIMIT 1",
      )
      .get(runId);
  }

  private transferRecord(runId: string, transferId: string): AgentConversationTransfer {
    try {
      return this.read(
        AgentConversationTransferSchema,
        "SELECT record_json FROM agent_conversation_transfers WHERE run_id = ? AND transfer_id = ?",
        [runId, transferId],
        "unknown_conversation_transfer",
      );
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      throw new AgentCoordinationError(
        "conversation_transfer_unreadable",
        `Conversation transfer ${transferId} is unreadable; preserve its record and inspect status before recovery`,
      );
    }
  }

  /** A terminal acknowledgement does not depend on mutable source readability. */
  abandonedConversationTransfer(
    runId: string,
    transferId: string,
  ): AgentConversationTransfer | null {
    const transfer = this.transferRecord(runId, transferId);
    return transfer.status === "abandoned" ? transfer : null;
  }

  conversationTransfer(runId: string, transferId: string): AgentConversationTransfer {
    return this.validatedConversationTransfer(runId, transferId);
  }

  private validatedConversationTransfer(
    runId: string,
    transferId: string,
    ownership?: Map<string, AgentOwnershipAssessment>,
  ): AgentConversationTransfer {
    const transfer = this.transferRecord(runId, transferId);
    // Consuming a transfer is the durable ownership transition. Its source digest
    // was checked while the transfer was pending/claimed; later source damage may
    // invalidate historical evidence but cannot revoke the healthy successor.
    if (["abandoned", "consumed"].includes(transfer.status)) return transfer;
    const assessment = (ownership ?? this.ownershipInventory(runId)).get(
      agentIdentityKey({
        agentId: transfer.sourceAgentId,
        agentGeneration: transfer.sourceAgentGeneration,
      }),
    );
    if (!assessment)
      throw new AgentCoordinationError("unknown_agent", "Unknown agent ownership identity");
    if (assessment.state !== "valid")
      throw new AgentCoordinationError(
        "conversation_transfer_source_unreadable",
        `Conversation transfer ${transferId} has an unreadable source (${assessment.state}). Inspect status; abandon-conversation can settle unused continuity once all associated work is provably stopped.`,
      );
    const source = assessment.agent;
    if (
      digestJson(source) !== transfer.sourceDigest ||
      source.role !== "orchestrator" ||
      source.status !== "released" ||
      source.revokedReason !== null ||
      source.activeTurnId !== null ||
      source.provider?.backend !== "codex" ||
      source.provider.sessionId !== transfer.sessionId ||
      source.workspaceId !== transfer.workspaceId ||
      source.workspaceGeneration !== transfer.workspaceGeneration ||
      this.providerHome(source) !== transfer.providerHome
    )
      throw new AgentCoordinationError(
        "conversation_transfer_changed",
        "The source conversation or a derived transfer binding changed after handoff",
      );
    return transfer;
  }
  openConversationTransfers(runId: string): AgentConversationTransfer[] {
    const rows = this.db
      .prepare(
        "SELECT transfer_id FROM agent_conversation_transfers WHERE run_id = ? AND status IN ('pending','claimed') ORDER BY rowid",
      )
      .all(runId) as { transfer_id: string }[];
    return rows.map((row) => this.conversationTransfer(runId, row.transfer_id));
  }
  pendingCoordinatorConversationTransfer(
    runId: string,
    runtime: RuntimeKind,
  ): AgentConversationTransfer | null {
    const rows = this.db
      .prepare(
        "SELECT transfer_id FROM agent_conversation_transfers WHERE run_id = ? AND target_runtime = ? AND status = 'pending' ORDER BY rowid LIMIT 2",
      )
      .all(runId, runtime) as { transfer_id: string }[];
    if (rows.length > 1)
      throw new AgentCoordinationError(
        "conversation_transfer_ambiguous",
        "More than one coordinator conversation is pending for this runtime",
      );
    return rows[0] ? this.conversationTransfer(runId, rows[0].transfer_id) : null;
  }

  /** Called by the fenced operator transaction, never exposed as an agent capability. */
  abandonConversationTransfer(
    authority: ControllerAuthority,
    transferId: string,
    reason: string,
  ): AgentConversationTransfer {
    return this.access.transaction(authority, () => {
      const transfer = this.transferRecord(authority.runId, transferId);
      if (transfer.status === "abandoned") return transfer;
      if (transfer.status === "consumed")
        throw new AgentCoordinationError(
          "conversation_transfer_consumed",
          "Consumed conversation ownership cannot be abandoned",
        );
      const source = this.ownershipAssessment(authority.runId, {
        agentId: transfer.sourceAgentId,
        agentGeneration: transfer.sourceAgentGeneration,
      });
      if (source.state === "uncontained")
        throw new AgentCoordinationError(
          "agent_integrity_uncontained",
          "Conversation source stop cannot be proved",
        );
      if (source.state === "valid") this.conversationTransfer(authority.runId, transferId);
      // Recovery may retire authority without reconstructing an isolated owner's
      // execution contract. Its actual workspace remains a relational obligation.
      const binding = this.db
        .prepare(
          "SELECT workspace_id, workspace_generation FROM agent_instances WHERE run_id = ? AND agent_id = ? AND generation = ?",
        )
        .get(authority.runId, transfer.sourceAgentId, transfer.sourceAgentGeneration) as {
        workspace_id: string;
        workspace_generation: number;
      };
      if (
        binding.workspace_id !== transfer.workspaceId ||
        binding.workspace_generation !== transfer.workspaceGeneration
      )
        throw new AgentCoordinationError(
          "conversation_transfer_changed",
          "Transfer workspace differs from its relational source owner",
        );
      const workspace = this.workspace(authority.runId, transfer);
      if (workspace.activeTurnId || this.activeWorkspaceOperation(authority.runId, workspace))
        throw new AgentCoordinationError(
          "workspace_busy",
          "Conversation abandonment requires confirmed workspace I/O stop",
        );

      // Claims can only advance this relational agent identity. Read that lineage
      // strictly, including relinquished claims; unrelated isolated damage cannot
      // disable this operator recovery, and malformed claimants cannot disappear.
      let targets: AgentInstance[];
      try {
        targets = this.all(
          AgentInstanceSchema,
          "SELECT record_json FROM agent_instances WHERE run_id = ? AND conversation_transfer_id = ? ORDER BY rowid",
          [authority.runId, transferId],
        );
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error;
        throw new AgentCoordinationError(
          "conversation_transfer_claimant_unreadable",
          `Conversation transfer ${transferId} has an unreadable claim target; preserve its record and inspect the claimant before abandonment`,
        );
      }
      if (
        transfer.status === "claimed" &&
        !targets.some(
          (agent) =>
            agent.agentId === transfer.targetAgentId &&
            agent.agentGeneration === transfer.targetAgentGeneration,
        )
      )
        throw new AgentCoordinationError(
          "conversation_transfer_mismatch",
          "The exact claim target is missing",
        );
      const turns = targets.flatMap((agent) => this.validatedTurnsForAgent(authority.runId, agent));
      if (targets.some((agent) => agent.provider !== null))
        throw new AgentCoordinationError(
          "conversation_transfer_bound",
          "A target with provider identity cannot abandon its conversation",
        );
      // Retirement verifies all exact turns/launches and mailbox settlement. All
      // changes roll back together if any claimant cannot prove stop.
      for (const target of targets)
        this.retireStoppedAgentWithClaim(authority, target, undefined, "abandon");
      transfer.status = "abandoned";
      transfer.abandonment = {
        at: now(),
        reason: safeText(z.string().trim().min(1).max(4000).parse(reason), 4000),
        stoppedTurnIds: turns.map((turn) => turn.identity.turnId),
      };
      this.saveConversationTransfer(transfer);
      this.changed(
        authority,
        "agent.conversation_transfer_abandoned",
        `${transferId}: ${transfer.abandonment.reason}`,
      );
      return transfer;
    });
  }

  /** Bounded operator projection; never expose session IDs or provider homes. */
  conversationTransferSummaries(runId: string) {
    const rows = this.db
      .prepare(
        "SELECT transfer_id, status, target_runtime, record_json FROM agent_conversation_transfers WHERE run_id = ? ORDER BY rowid DESC LIMIT 20",
      )
      .all(runId) as {
      transfer_id: string;
      status: AgentConversationTransfer["status"];
      target_runtime: RuntimeKind;
      record_json: string;
    }[];
    return rows.map((row) => {
      const parsed = AgentConversationTransferSchema.safeParse(JSON.parse(row.record_json));
      return {
        transferId: row.transfer_id,
        status: row.status,
        targetRuntime: row.target_runtime,
        unreadable: !parsed.success,
        abandonment:
          parsed.success && parsed.data.abandonment
            ? {
                at: parsed.data.abandonment.at,
                reason: parsed.data.abandonment.reason,
                stoppedTurnCount: parsed.data.abandonment.stoppedTurnIds.length,
              }
            : null,
      };
    });
  }

  createCoordinatorConversationTransfer(
    authority: ControllerAuthority,
    identity: AgentIdentity,
    targetRuntime: RuntimeKind,
  ): AgentConversationTransfer {
    return this.access.transaction(authority, () => {
      const source = this.instance(authority.runId, identity);
      if (
        source.role !== "orchestrator" ||
        source.status !== "released" ||
        source.revokedReason !== null ||
        source.activeTurnId !== null ||
        source.provider?.sessionId == null
      )
        throw new AgentCoordinationError(
          "conversation_transfer_not_stopped",
          "Only a non-revoked, released stopped coordinator with a bound Codex session can transfer continuity",
        );
      if (
        this.db
          .prepare(
            "SELECT 1 FROM agent_conversation_transfers WHERE session_id = ? AND status IN ('pending','claimed')",
          )
          .get(source.provider.sessionId)
      )
        throw new AgentCoordinationError(
          "conversation_transfer_in_use",
          "This Codex conversation already has an open transfer",
        );
      const record = AgentConversationTransferSchema.parse({
        transferId: randomUUID(),
        runId: authority.runId,
        sourceAgentId: source.agentId,
        sourceAgentGeneration: source.agentGeneration,
        targetRuntime,
        sessionId: source.provider.sessionId,
        providerHome:
          source.conversationContinuation?.providerHome ??
          join(
            source.execution.runtimeRoot,
            authority.runId,
            `${source.agentId}-${source.agentGeneration}`,
            "provider",
          ),
        workspaceId: source.workspaceId,
        workspaceGeneration: source.workspaceGeneration,
        status: "pending",
        targetAgentId: null,
        targetAgentGeneration: null,
        sourceDigest: digestJson(source),
        createdAt: now(),
        claimedAt: null,
        consumedAt: null,
        abandonment: null,
      });
      this.db
        .prepare(
          "INSERT INTO agent_conversation_transfers(transfer_id, run_id, source_agent_id, source_agent_generation, target_agent_id, target_agent_generation, session_id, target_runtime, status, record_json) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)",
        )
        .run(
          record.transferId,
          record.runId,
          record.sourceAgentId,
          record.sourceAgentGeneration,
          record.sessionId,
          record.targetRuntime,
          record.status,
          JSON.stringify(record),
        );
      this.changed(
        authority,
        "agent.conversation_transfer_reserved",
        `${source.agentId}/${source.agentGeneration}: ${record.transferId}`,
      );
      return record;
    });
  }
  assignment(runId: string, assignmentId: string): AgentAssignment {
    return this.read(
      AgentAssignmentSchema,
      "SELECT record_json FROM agent_assignments WHERE run_id = ? AND assignment_id = ?",
      [runId, assignmentId],
      "unknown_assignment",
    );
  }
  messages(runId: string, identity: AgentIdentity): AgentMailboxMessage[] {
    this.instance(runId, identity);
    return this.all(
      AgentMailboxMessageSchema,
      "SELECT record_json FROM agent_messages WHERE run_id = ? AND agent_id = ? AND agent_generation = ? ORDER BY rowid",
      [runId, identity.agentId, identity.agentGeneration],
    );
  }
  turns(runId: string): TurnRecord[] {
    const cached = this.snapshotTurns?.get(runId);
    if (cached) return cached;
    const owners = new Map(this.instances(runId).map((agent) => [agentIdentityKey(agent), agent]));
    const turns = this.all(
      TurnRecordSchema,
      "SELECT record_json FROM agent_turns WHERE run_id = ? ORDER BY rowid",
      [runId],
    ).map((turn) =>
      this.validateTurnAgainstAgent(turn, owners.get(agentIdentityKey(turn.identity))),
    );
    if (this.snapshotTurns !== null) {
      freezeReadRecords(turns);
      this.snapshotTurns.set(runId, turns);
    }
    return turns;
  }
  operationalTurnEntries(runId: string): OperationalTurnEntry[] {
    const cached = this.snapshotOperationalTurns?.get(runId);
    if (cached) return cached;
    const ownership = this.ownershipEntries(runId);
    const assessments = [...ownership.values()].map((entry) => entry.assessment);
    const integrity = assessments.flatMap((entry) =>
      entry.state === "valid" ? [] : [entry.incident],
    );
    const uncontained = integrity.find((incident) => incident.state === "uncontained");
    if (uncontained)
      throw new AgentCoordinationError(
        "agent_integrity_uncontained",
        `Agent ${uncontained.identity.agentId}/${uncontained.identity.agentGeneration} has ownership or work whose stop cannot be proved`,
      );
    const entries: OperationalTurnEntry[] = [...ownership.values()]
      .flatMap((entry) =>
        entry.turns.map(({ rowId, turn }) => ({ rowId, turn, assessment: entry.assessment })),
      )
      .sort((left, right) => left.rowId - right.rowId)
      .map(({ turn: cachedTurn, assessment }): OperationalTurnEntry => {
        const turn = structuredClone(cachedTurn);
        if (assessment.state === "valid")
          return {
            turn,
            owner: { state: "valid" as const, role: assessment.agent.role },
          };
        if (assessment.state === "uncontained")
          throw new AgentCoordinationError(
            "agent_integrity_uncontained",
            `Agent ${assessment.incident.identity.agentId}/${assessment.incident.identity.agentGeneration} has ownership or work whose stop cannot be proved`,
          );
        // The intrinsic prompt digest remains a safe role-classification witness:
        // creation permits coordinators only for coordination assignments and forbids
        // that purpose for every worker role.
        return {
          turn: turn.resultEligible ? { ...turn, resultEligible: false } : turn,
          owner: {
            state: "isolated" as const,
            role: turn.prompt.assignment.purpose === "coordination" ? "orchestrator" : "worker",
          },
        };
      });
    if (this.snapshotOperationalTurns !== null) {
      freezeReadRecords(entries);
      this.snapshotOperationalTurns.set(runId, entries);
    }
    return entries;
  }
  operationalTurns(runId: string): TurnRecord[] {
    return this.operationalTurnEntries(runId).map(({ turn }) => turn);
  }
  /**
   * Startup recovery must isolate malformed persisted records. Ordinary turn
   * readers remain strict; this boundary only supplies independently parsed
   * rows so one corrupt owner cannot hide unrelated submitted work.
   */
  turnsForRecovery(runId: string): RecoveryTurn[] {
    return (
      this.db
        .prepare("SELECT rowid, record_json FROM agent_turns WHERE run_id = ? ORDER BY rowid")
        .all(runId) as {
        rowid: number;
        record_json: string;
      }[]
    ).map(({ rowid, record_json }) => this.recoveryTurn(runId, rowid, record_json));
  }

  /** Exact recovery lookup that can return settled history without decoding its owner. */
  turnForRecovery(runId: string, identity: TurnIdentity): RecoveryTurn {
    const row = this.db
      .prepare("SELECT rowid, record_json FROM agent_turns WHERE run_id = ? AND turn_id = ?")
      .get(runId, identity.turnId) as { rowid: number; record_json: string } | undefined;
    if (!row)
      throw new AgentCoordinationError(
        "unknown_turn",
        "Turn is missing, stale, or belongs to another run",
      );
    const recovered = this.recoveryTurn(runId, row.rowid, row.record_json);
    if (!recovered.identity || !sameTurn(recovered.identity, identity))
      return {
        ...recovered,
        turn: null,
        failure: new InvalidTurnRecordError(
          "Persisted turn identity differs from the requested recovery identity",
        ),
        ownerValidity: "unreadable",
      };
    return recovered;
  }

  /**
   * Queued mail has never entered a provider prompt. Once its exact owner is
   * unreadable but otherwise isolated, preserve the record and terminate its
   * delivery intent so it cannot strand the run or be silently retargeted.
   */
  supersedeQueuedMessagesForIsolatedOwners(authority: ControllerAuthority): string[] {
    return this.access.transaction(authority, () => {
      const isolated = new Set(
        [...this.ownershipInventory(authority.runId).values()].flatMap((assessment) =>
          assessment.state === "isolated" ? [agentIdentityKey(assessment.incident.identity)] : [],
        ),
      );
      if (isolated.size === 0) return [];
      const rows = this.db
        .prepare("SELECT record_json FROM agent_messages WHERE run_id = ? ORDER BY rowid")
        .all(authority.runId) as { record_json: string }[];
      const superseded: string[] = [];
      for (const row of rows) {
        const parsed = AgentMailboxMessageSchema.safeParse(JSON.parse(row.record_json));
        if (
          !parsed.success ||
          parsed.data.status !== "queued" ||
          !isolated.has(agentIdentityKey(parsed.data))
        )
          continue;
        parsed.data.status = "superseded";
        this.saveMessage(parsed.data);
        superseded.push(parsed.data.messageId);
      }
      if (superseded.length > 0)
        this.changed(
          authority,
          "agent.unreadable_owner_messages_superseded",
          `${superseded.length} queued message(s) retained but superseded because their exact owner is unreadable and isolated`,
        );
      return superseded;
    });
  }
  turn(runId: string, identity: TurnIdentity): TurnRecord {
    const turn = this.validateTurn(
      this.read(
        TurnRecordSchema,
        "SELECT record_json FROM agent_turns WHERE run_id = ? AND turn_id = ?",
        [runId, identity.turnId],
        "unknown_turn",
      ),
    );
    if (!sameTurn(turn.identity, TurnIdentitySchema.parse(identity)))
      throw new AgentCoordinationError(
        "stale_turn",
        "Turn identity does not match its persisted assignment and workspace",
      );
    return turn;
  }

  reserveAgent(
    authority: ControllerAuthority,
    input: NewAgent,
    expectedControlVersion: number,
  ): AgentInstance {
    return this.access.transaction(authority, () => {
      const control = this.active(authority, expectedControlVersion);
      const workspace = this.workspace(authority.runId, input);
      if (input.purpose !== "coordination") this.access.assertTrackerCommitIdle(authority.runId);
      // Final review is admitted by the evidence-bound review capability after task closure.
      // Its epic root is not an implementation task and must not acquire a fabricated claim.
      const epicRepair =
        input.purpose === "epic_repair"
          ? this.access.bindEpicRepair(authority.runId, input.taskId, input.candidateId, workspace)
          : undefined;
      const epicReview =
        ["review", "verification", "final_review"].includes(input.purpose) &&
        this.access.epicReviewTarget(authority.runId, input.taskId, input.candidateId);
      const trackerClaim =
        epicRepair || epicReview
          ? undefined
          : this.access.assertTaskOwned(authority.runId, input.taskId);
      if (workspace.purpose === "delivery")
        throw new AgentCoordinationError(
          "kernel_workspace",
          "Canonical delivery custody is never assigned to an agent",
        );
      if (this.access.publicationPending(authority.runId) && input.purpose !== "coordination")
        throw new AgentCoordinationError(
          "publication_unsettled",
          "Publication excludes new worker assignments",
        );
      if (
        workspace.status !== "ready" ||
        workspace.activeTurnId ||
        this.activeWorkspaceOperation(authority.runId, workspace)
      )
        throw new AgentCoordinationError(
          "workspace_unavailable",
          "Agent needs a ready, unoccupied workspace",
        );
      let identity: AgentIdentity = { agentId: randomUUID(), agentGeneration: 1 };
      let replaced: AgentInstance | null = null;
      if (input.replaces) {
        const old = this.instance(authority.runId, input.replaces);
        replaced = old;
        if (old.status !== "revoked" && old.status !== "released")
          throw new AgentCoordinationError(
            "agent_not_revoked",
            "Revoke the old instance before replacing it",
          );
        const oldWorkspace = this.workspace(authority.runId, old);
        if (old.activeTurnId && oldWorkspace.status !== "quarantined")
          throw new AgentCoordinationError(
            "agent_not_stopped",
            "Uncertain old work must be quarantined before replacement",
          );
        if (
          this.db
            .prepare(
              "SELECT 1 FROM agent_instances WHERE run_id = ? AND agent_id = ? AND generation > ? LIMIT 1",
            )
            .get(authority.runId, old.agentId, old.agentGeneration)
        )
          throw new AgentCoordinationError(
            "stale_generation",
            "This agent already has a replacement generation",
          );
        identity = { agentId: old.agentId, agentGeneration: old.agentGeneration + 1 };
      }
      const at = now();
      const assignment = AgentAssignmentSchema.parse({
        assignmentId: randomUUID(),
        runId: authority.runId,
        ...identity,
        purpose: input.purpose,
        taskId: input.taskId,
        candidateId: input.candidateId,
        instructions: safeText(input.instructions),
        ...(trackerClaim ? { trackerClaim } : {}),
        ...(epicRepair ? { epicRepair } : {}),
        createdAt: at,
      });
      const configuration = this.runConfiguration(authority.runId);
      if (!configuration)
        throw new AgentCoordinationError(
          "execution_unconfigured",
          "Agent reservation requires a configured Codex execution source",
        );
      const execution = AgentExecutionSchema.parse({
        executable: configuration.executable,
        runtimeRoot: configuration.runtimeRoot,
        turnTimeoutMs: configuration.turnTimeoutMs,
        herdr: configuration.herdr,
      });
      const binding = accountBinding(configuration.accounts, input.role, input.purpose);
      if (binding) validateAccountReservation(binding.source);
      if (
        input.contract.backend !== BackendKindSchema.value ||
        (input.contract.runtime === "herdr") !== (execution.herdr !== null)
      )
        throw new AgentCoordinationError(
          "execution_contract_mismatch",
          "Agent contract must match the admitted Codex backend and runtime endpoint",
        );
      const transfer = input.conversationTransferId
        ? this.conversationTransfer(authority.runId, input.conversationTransferId)
        : null;
      const transferSource = transfer
        ? this.instance(authority.runId, {
            agentId: transfer.sourceAgentId,
            agentGeneration: transfer.sourceAgentGeneration,
          })
        : null;
      if (
        transfer &&
        (transfer.status !== "pending" ||
          input.purpose !== "coordination" ||
          input.role !== "orchestrator" ||
          !replaced ||
          replaced.agentId !== transfer.sourceAgentId ||
          !(
            (replaced.agentGeneration === transfer.sourceAgentGeneration &&
              replaced.status === "released") ||
            (replaced.agentGeneration > transfer.sourceAgentGeneration &&
              ["revoked", "released"].includes(replaced.status) &&
              replaced.provider === null &&
              replaced.conversationContinuation?.transferId === transfer.transferId)
          ) ||
          input.contract.runtime !== transfer.targetRuntime ||
          workspace.workspaceId !== transfer.workspaceId ||
          workspace.workspaceGeneration !== transfer.workspaceGeneration ||
          digestJson(binding ?? null) !== digestJson(transferSource?.accountBinding ?? null))
      )
        throw new AgentCoordinationError(
          "conversation_transfer_mismatch",
          "Conversation transfer does not match the stopped coordinator replacement",
        );
      const isolatedTransferAncestors = new Set<string>();
      if (transferSource) {
        const lineage = this.conversationLineage(authority.runId, transferSource);
        for (const ancestor of lineage.identities) {
          const key = agentIdentityKey(ancestor);
          if (lineage.ownership?.get(key)?.state === "isolated") isolatedTransferAncestors.add(key);
        }
      }
      if (this.workspaceHasConflictingOwner(authority.runId, workspace, isolatedTransferAncestors))
        throw new AgentCoordinationError(
          "workspace_assigned",
          "Use a fresh workspace for each agent instance",
        );
      const agent = AgentInstanceSchema.parse({
        ...(binding ? { accountBinding: binding } : {}),
        schemaVersion: AGENT_INSTANCE_SCHEMA_VERSION,
        runId: authority.runId,
        ...identity,
        role: input.role,
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
        assignmentId: assignment.assignmentId,
        execution,
        contract: input.contract,
        confinementProfile: input.confinementProfile,
        conversationContinuation: transfer
          ? {
              transferId: transfer.transferId,
              sourceAgentId: transfer.sourceAgentId,
              sourceAgentGeneration: transfer.sourceAgentGeneration,
              sessionId: transfer.sessionId,
              providerHome: transfer.providerHome,
            }
          : null,
        provider: null,
        status: "reserved",
        activeTurnId: null,
        revokedReason: null,
        createdAt: at,
        updatedAt: at,
      });
      this.checkAssignment(agent, assignment, workspace, this.access.policy(control.runId));
      this.db
        .prepare(
          "INSERT INTO agent_instances(agent_id, generation, run_id, workspace_id, workspace_generation, assignment_id, conversation_transfer_id, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          agent.agentId,
          agent.agentGeneration,
          authority.runId,
          workspace.workspaceId,
          workspace.workspaceGeneration,
          assignment.assignmentId,
          transfer?.transferId ?? null,
          JSON.stringify(agent),
        );
      this.db
        .prepare(
          "INSERT INTO agent_assignments(assignment_id, run_id, agent_id, agent_generation, record_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          assignment.assignmentId,
          authority.runId,
          agent.agentId,
          agent.agentGeneration,
          JSON.stringify(assignment),
        );
      if (transfer) {
        transfer.status = "claimed";
        transfer.targetAgentId = agent.agentId;
        transfer.targetAgentGeneration = agent.agentGeneration;
        transfer.claimedAt = now();
        this.saveConversationTransfer(transfer);
      }
      this.changed(authority, "agent.reserved", `${agent.agentId}/${agent.agentGeneration}`);
      return agent;
    });
  }

  /** Native Herdr and resumed SDK identities are known before prompt submission. */
  bindProvider(
    authority: ControllerAuthority,
    identity: AgentIdentity,
    input: ProviderIdentityInput,
  ): AgentInstance {
    return this.access.transaction(authority, () => {
      const agent = this.instance(authority.runId, identity);
      if (!agent.provider && agent.status !== "reserved")
        throw new AgentCoordinationError("agent_not_reserved", "Agent is no longer reserved");
      return this.recordProvider(authority, agent, input);
    });
  }

  /** Runtime identity arrives after durable dispatch intent; native endpoints must already be bound. */
  bindTurnProvider(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    input: ProviderIdentityInput,
  ): AgentInstance {
    return this.access.transaction(authority, () => {
      const turn = this.turn(authority.runId, identity);
      const agent = this.instance(authority.runId, identity);
      if (
        agent.contract.runtime !== input.runtime ||
        agent.activeTurnId !== identity.turnId ||
        terminal(turn) ||
        turn.status === "prepared"
      )
        throw new AgentCoordinationError(
          "stale_turn",
          "Provider start event does not belong to the exact dispatched turn",
        );
      if (input.runtime === "herdr") {
        const native = turn.launch?.native;
        if (
          !native ||
          native.name !== input.name ||
          native.paneId !== input.paneId ||
          native.tabId !== input.tabId ||
          native.terminalId !== input.terminalId
        )
          throw new AgentCoordinationError(
            "wrong_native_endpoint",
            "Native provider does not match the bound launch endpoint",
          );
      }
      // Revoked instances may still reveal identity for cleanup; never restore their authority.
      return this.recordProvider(authority, agent, input, input.runtime === "herdr");
    });
  }

  private recordProvider(
    authority: ControllerAuthority,
    agent: AgentInstance,
    input: ProviderIdentityInput,
    nativeTurnBinding = false,
  ): AgentInstance {
    const provider = ProviderIdentitySchema.parse(input);
    if (provider.backend !== agent.contract.backend || provider.runtime !== agent.contract.runtime)
      throw new AgentCoordinationError(
        "wrong_provider",
        "Provider backend and runtime do not match the pinned agent contract",
      );
    if (
      agent.conversationContinuation &&
      provider.sessionId !== agent.conversationContinuation.sessionId
    )
      throw new AgentCoordinationError(
        "conversation_transfer_mismatch",
        "Transferred conversation must resume the exact stopped Codex session",
      );
    // Binding is an idempotent ownership operation, not a polling-time integrity
    // scan. The first bind validates the complete transfer lineage before saving.
    if (agent.provider && digestJson(agent.provider) === digestJson(provider)) return agent;
    const lineage = this.conversationLineage(authority.runId, agent);
    let ownership = lineage.ownership;
    const continuationOwners = new Set(lineage.identities.map(agentIdentityKey));
    if (agent.provider) {
      const initialNativeSession =
        agent.provider.runtime === "herdr" &&
        provider.runtime === "herdr" &&
        agent.provider.sessionId === null &&
        provider.sessionId !== null &&
        digestJson({ ...provider, sessionId: null }) === digestJson(agent.provider);
      const resumedNativeTerminal =
        nativeTurnBinding &&
        agent.provider.runtime === "herdr" &&
        provider.runtime === "herdr" &&
        (agent.provider.sessionId === null || provider.sessionId === agent.provider.sessionId) &&
        this.operationalTurns(authority.runId).every(
          (turn) =>
            turn.identity.agentId !== agent.agentId ||
            turn.identity.agentGeneration !== agent.agentGeneration ||
            turn.identity.turnId === agent.activeTurnId ||
            terminal(turn),
        );
      if (!initialNativeSession && !resumedNativeTerminal)
        throw new AgentCoordinationError(
          "provider_changed",
          "Provider identity cannot be replaced in place",
        );
    }
    const key =
      provider.runtime === "sdk"
        ? `${provider.backend}:${provider.runtime}:${provider.sessionId}`
        : `${provider.backend}:${provider.runtime}:${provider.terminalId}`;
    if (
      this.db
        .prepare(
          "SELECT 1 FROM agent_instances WHERE (provider_key = ? OR (provider_backend = ? AND provider_session_id = ?)) AND json_extract(record_json, '$.status') <> 'released' AND NOT (agent_id = ? AND generation = ?)",
        )
        .get(key, provider.backend, provider.sessionId, agent.agentId, agent.agentGeneration)
    )
      throw new AgentCoordinationError(
        "provider_in_use",
        "Provider is already bound to another agent generation",
      );
    const openTransfer = this.db
      .prepare(
        "SELECT record_json FROM agent_conversation_transfers WHERE session_id = ? AND status IN ('pending','claimed')",
      )
      .get(provider.sessionId) as { record_json: string } | undefined;
    if (openTransfer) {
      const transfer = AgentConversationTransferSchema.parse(JSON.parse(openTransfer.record_json));
      if (
        transfer.status !== "claimed" ||
        transfer.targetAgentId !== agent.agentId ||
        transfer.targetAgentGeneration !== agent.agentGeneration ||
        agent.conversationContinuation?.transferId !== transfer.transferId
      )
        throw new AgentCoordinationError(
          "conversation_transfer_in_use",
          "The Codex conversation is reserved for an explicit runtime handoff",
        );
    }
    if (provider.sessionId !== null) {
      const historical = this.db
        .prepare(
          "SELECT agent_id, generation, record_json FROM agent_instances WHERE provider_backend = ? AND provider_session_id = ? AND NOT (agent_id = ? AND generation = ?)",
        )
        .all(provider.backend, provider.sessionId, agent.agentId, agent.agentGeneration) as {
        agent_id: string;
        generation: number;
        record_json: string;
      }[];
      if (
        historical.some((row) => {
          const identity = { agentId: row.agent_id, agentGeneration: row.generation };
          if (!continuationOwners.has(agentIdentityKey(identity))) return true;
          const assessment = (ownership ??= this.ownershipInventory(authority.runId)).get(
            agentIdentityKey(identity),
          );
          if (!assessment)
            throw new AgentCoordinationError("unknown_agent", "Unknown agent ownership identity");
          return (
            assessment.state === "uncontained" ||
            (assessment.state === "valid" && assessment.agent.status !== "released")
          );
        })
      )
        throw new AgentCoordinationError(
          "conversation_transfer_required",
          "A historical Codex session can move only through its validated explicit runtime handoff lineage",
        );
    }
    agent.provider = provider;
    if (agent.status === "reserved") agent.status = "ready";
    this.saveAgent(agent, key);
    if (openTransfer) {
      const transfer = AgentConversationTransferSchema.parse(JSON.parse(openTransfer.record_json));
      transfer.status = "consumed";
      transfer.consumedAt = now();
      this.saveConversationTransfer(transfer);
    }
    this.event(authority, "agent.provider_bound", `${agent.agentId}/${agent.agentGeneration}`);
    return agent;
  }

  enqueueAgentMessage(
    authority: ControllerAuthority,
    identity: AgentIdentity,
    operationId: string,
    content: string,
  ): AgentMailboxMessage {
    return this.access.transaction(authority, () => {
      const agent = this.instance(authority.runId, identity);
      const text = safeText(content);
      const existing = this.all(
        AgentMailboxMessageSchema,
        "SELECT record_json FROM agent_messages WHERE operation_id = ?",
        [operationId],
      )[0];
      if (existing) {
        if (
          existing.runId !== authority.runId ||
          existing.agentId !== identity.agentId ||
          existing.agentGeneration !== identity.agentGeneration ||
          existing.content !== text
        )
          throw new AgentCoordinationError(
            "message_replay_mismatch",
            "Message operation was reused with different content or target",
          );
        return existing;
      }
      this.active(authority);
      if (["revoked", "released"].includes(agent.status))
        throw new AgentCoordinationError("agent_revoked", "Cannot message a retired generation");
      if (
        this.messages(authority.runId, identity).filter((message) => message.status === "queued")
          .length >= 100
      )
        throw new AgentCoordinationError(
          "mailbox_full",
          "Agent mailbox has 100 unconsumed messages",
        );
      const at = now();
      const message = AgentMailboxMessageSchema.parse({
        messageId: randomUUID(),
        runId: authority.runId,
        agentId: identity.agentId,
        agentGeneration: identity.agentGeneration,
        operationId,
        content: text,
        status: "queued",
        deliveryTurnId: null,
        acknowledgement: null,
        createdAt: at,
        updatedAt: at,
      });
      this.db
        .prepare(
          "INSERT INTO agent_messages(message_id, run_id, agent_id, agent_generation, operation_id, record_json) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          message.messageId,
          authority.runId,
          identity.agentId,
          identity.agentGeneration,
          operationId,
          JSON.stringify(message),
        );
      this.event(authority, "agent.message_queued", message.messageId);
      return message;
    });
  }

  prepareTurn(
    authority: ControllerAuthority,
    identity: AgentIdentity,
    operationId: string,
    instructions: string,
    outputSchema: unknown,
    expectedControlVersion: number,
    reviewContext?: JsonValue,
    reviewDiagnostic = false,
  ): TurnRecord {
    return this.access.transaction(authority, () => {
      const previous = this.all(
        TurnRecordSchema,
        "SELECT record_json FROM agent_turns WHERE operation_id = ?",
        [operationId],
      )[0];
      if (previous) {
        this.validateTurn(previous);
        if (
          previous.identity.runId !== authority.runId ||
          previous.identity.agentId !== identity.agentId ||
          previous.identity.agentGeneration !== identity.agentGeneration ||
          previous.prompt.instructions !==
            safeText(
              instructions,
              previous.prompt.assignment.purpose === "coordination" ? 98304 : 16000,
            ) ||
          digestJson(previous.outputSchema) !== digestJson(z.json().parse(outputSchema)) ||
          digestJson(previous.prompt.reviewContext ?? null) !== digestJson(reviewContext ?? null) ||
          (previous.prompt.diagnosticContext !== undefined) !== reviewDiagnostic
        )
          throw new AgentCoordinationError(
            "turn_replay_mismatch",
            "Turn operation was reused with different arguments or target",
          );
        return previous;
      }
      const control = this.active(authority, expectedControlVersion);
      const agent = this.instance(authority.runId, identity);
      const workspace = this.workspace(authority.runId, agent);
      const assignment = this.assignment(authority.runId, agent.assignmentId);
      if (
        reviewDiagnostic &&
        (agent.role !== "review" ||
          !["review", "verification", "final_review"].includes(assignment.purpose) ||
          agent.confinementProfile !== "epicd-isolated" ||
          workspace.sourceMode !== "immutable" ||
          reviewContext !== undefined ||
          digestJson(outputSchema) !== digestJson(AGENT_DIAGNOSTIC_OUTPUT_SCHEMA))
      )
        throw new AgentCoordinationError(
          "review_diagnostic_contract",
          "Reviewer conversation requires isolated immutable source and a diagnostic-only result contract, without review approval context",
        );
      if (assignment.epicRepair)
        this.access.assertEpicRepair(
          authority.runId,
          assignment.taskId,
          assignment.epicRepair,
          workspace,
          true,
        );
      else if (!(
        ["review", "verification", "final_review"].includes(assignment.purpose) &&
        this.access.epicReviewTarget(authority.runId, assignment.taskId, assignment.candidateId)
      ))
        this.access.assertTaskOwned(authority.runId, assignment.taskId);
      if (
        this.access.publicationPending(authority.runId) &&
        this.assignment(authority.runId, agent.assignmentId).purpose !== "coordination"
      )
        throw new AgentCoordinationError(
          "publication_unsettled",
          "Publication excludes new worker turns",
        );
      if (assignment.purpose !== "coordination")
        this.access.assertTrackerCommitIdle(authority.runId);
      const available =
        (agent.status === "ready" && agent.provider !== null) ||
        (agent.status === "reserved" && agent.provider === null);
      if (
        !available ||
        agent.activeTurnId ||
        workspace.status !== "ready" ||
        workspace.activeTurnId ||
        this.activeWorkspaceOperation(authority.runId, workspace)
      )
        throw new AgentCoordinationError(
          "agent_busy",
          "Turn requires a ready agent and exclusively owned workspace",
        );
      const active = this.operationalTurns(authority.runId).filter((turn) => !terminal(turn));
      if (
        reviewContext !== undefined &&
        !["review", "verification", "final_review"].includes(assignment.purpose)
      )
        throw new AgentCoordinationError(
          "review_context_role",
          "Only an independent review turn may carry review context",
        );
      const workers = active.filter(
        (turn) => this.instance(authority.runId, turn.identity).role !== "orchestrator",
      );
      if (
        agent.role !== "orchestrator" &&
        workers.length >= this.access.policy(authority.runId).budgets.maxWorkers
      )
        throw new AgentCoordinationError(
          "worker_budget",
          "Active worker limit reached; unknown stop states still consume slots",
        );
      if (
        ["implementation", "epic_repair"].includes(assignment.purpose) &&
        workers.some((turn) =>
          ["implementation", "epic_repair"].includes(turn.prompt.assignment.purpose),
        )
      )
        throw new AgentCoordinationError(
          "writer_busy",
          "Another implementation writer may still be running",
        );
      const at = now();
      const turnIdentity = TurnIdentitySchema.parse({
        runId: authority.runId,
        agentId: identity.agentId,
        agentGeneration: identity.agentGeneration,
        turnId: randomUUID(),
        operationId,
        assignmentId: agent.assignmentId,
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
      });
      const messages = this.messages(authority.runId, identity).filter(
        (message) => message.status === "queued",
      );
      const prompt = {
        schemaVersion: 1 as const,
        identity: turnIdentity,
        assignment,
        instructions: safeText(instructions, agent.role === "orchestrator" ? 98304 : 16000),
        messages: messages.map((message) => ({
          messageId: message.messageId,
          content: message.content,
        })),
        ...(reviewContext === undefined
          ? {}
          : { reviewContext: JsonValueSchema.parse(reviewContext) }),
        ...(reviewDiagnostic
          ? {
              diagnosticContext: {
                kind: "review_followup" as const,
                evidenceWarning:
                  "This turn answers a diagnostic question, not the assignment's formal review. Preserve source and answer using the diagnostic output schema. Do not issue an approval, resolve findings or claim kernel validation. Explain observations and uncertainty. Only a subsequent run_review can establish fresh approval; this conversation supersedes the prior review turn.",
              },
            }
          : {}),
        ...(assignment.epicRepair
          ? { repairContext: JsonValueSchema.parse(this.access.epicRepairContext(authority.runId)) }
          : {}),
      };
      if (
        Buffer.byteLength(JSON.stringify(prompt)) > (agent.role === "orchestrator" ? 131072 : 65536)
      )
        throw new AgentCoordinationError(
          "prompt_too_large",
          "Persisted prompt exceeds its role's byte limit; inspect and resolve queued messages first",
        );
      const turn = TurnRecordSchema.parse({
        identity: turnIdentity,
        launch: null,
        status: "prepared",
        prompt,
        promptDigest: digestJson(prompt),
        outputSchema,
        sdkUsage: null,
        policyDigest: control.policyDigest,
        controlVersion: control.controlVersion,
        submissionAcknowledgement: null,
        stopRequested: false,
        stopEvidence: null,
        result: null,
        resultEligible: false,
        createdAt: at,
        updatedAt: at,
      });
      this.db
        .prepare(
          "INSERT INTO agent_turns(turn_id, operation_id, run_id, agent_id, agent_generation, record_json) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          turnIdentity.turnId,
          operationId,
          authority.runId,
          identity.agentId,
          identity.agentGeneration,
          JSON.stringify(turn),
        );
      for (const message of messages) {
        message.status = "reserved";
        message.deliveryTurnId = turnIdentity.turnId;
        this.saveMessage(message);
      }
      agent.status = "busy";
      agent.activeTurnId = turnIdentity.turnId;
      workspace.activeTurnId = turnIdentity.turnId;
      this.saveAgent(agent);
      this.saveWorkspace(workspace);
      this.event(authority, "agent.turn_prepared", turnIdentity.turnId, turnIdentity);
      return turn;
    });
  }

  markSubmitting(authority: ControllerAuthority, identity: TurnIdentity): TurnRecord {
    return this.access.transaction(authority, () => {
      const turn = this.turn(authority.runId, identity);
      this.active(authority, turn.controlVersion);
      this.requireCurrent(turn);
      if (turn.prompt.assignment.epicRepair)
        this.access.assertEpicRepair(
          authority.runId,
          turn.prompt.assignment.taskId,
          turn.prompt.assignment.epicRepair,
          turn.identity,
          true,
        );
      if (turn.launch && turn.launch.controllerLeaseId !== authority.leaseId)
        throw new AgentCoordinationError(
          "stale_launch",
          "A previous controller's launch must be reconciled, not dispatched",
        );
      if (turn.status !== "prepared")
        throw new AgentCoordinationError(
          "turn_not_prepared",
          "A submitted or uncertain prompt cannot be sent again",
        );
      turn.status = "submitting";
      this.saveTurn(turn);
      this.event(authority, "agent.prompt_submitting", identity.turnId, identity);
      return turn;
    });
  }

  /** Reserve the process identity before materializing or invoking its launcher. */
  bindLaunch(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    input: CodexLaunch,
  ): TurnRecord {
    return this.access.transaction(authority, () => {
      const turn = this.turn(authority.runId, identity);
      this.active(authority, turn.controlVersion);
      this.requireCurrent(turn);
      const manifest = CodexLaunchSchema.parse(input);
      const manifestDigest = digestJson(manifest);
      if (turn.launch) {
        if (
          turn.launch.manifestDigest !== manifestDigest ||
          turn.launch.controllerLeaseId !== authority.leaseId
        )
          throw new AgentCoordinationError(
            "launch_conflict",
            "This turn already owns a different launch or controller generation",
          );
        return turn;
      }
      if (turn.status !== "prepared")
        throw new AgentCoordinationError("turn_not_prepared", "Bind a launch before dispatch");
      const agent = this.instance(authority.runId, identity);
      const workspace = this.workspace(authority.runId, identity);
      const lineage = this.conversationLineage(authority.runId, agent);
      const continuationOwners = new Set(lineage.identities.map(agentIdentityKey));
      const lineageClaims = new Map(
        [agent, ...lineage.readableAgents].flatMap((owner) =>
          owner.conversationContinuation
            ? [[owner.conversationContinuation.transferId, owner] as const]
            : [],
        ),
      );
      this.assertLaunchBinding(
        authority.runId,
        identity,
        agent,
        workspace,
        agent.contract.backend,
        agent.contract.runtime,
        manifest,
      );
      for (const other of this.operationalTurns(authority.runId)) {
        if (!other.launch) continue;
        const sameAgent =
          other.identity.agentId === identity.agentId &&
          other.identity.agentGeneration === identity.agentGeneration;
        for (const key of ["providerHome", "scratch", "artifacts"] as const) {
          const equal = other.launch.manifest.confinement[key] === manifest.confinement[key];
          let transferredProviderHome =
            key === "providerHome" && continuationOwners.has(agentIdentityKey(other.identity));
          if (
            key === "providerHome" &&
            !transferredProviderHome &&
            agent.conversationContinuation
          ) {
            try {
              const priorClaim = this.instance(authority.runId, other.identity);
              const successor = priorClaim.conversationContinuation
                ? lineageClaims.get(priorClaim.conversationContinuation.transferId)
                : undefined;
              transferredProviderHome =
                priorClaim.status === "released" &&
                priorClaim.provider === null &&
                priorClaim.conversationContinuation !== null &&
                successor !== undefined &&
                priorClaim.agentId === successor.agentId &&
                priorClaim.agentGeneration < successor.agentGeneration &&
                digestJson(priorClaim.conversationContinuation) ===
                  digestJson(successor.conversationContinuation) &&
                terminal(other) &&
                other.launch.stop !== null;
            } catch {
              // An unreadable owner can never authorize shared storage.
            }
          }
          if (sameAgent ? !equal : equal && !transferredProviderHome)
            throw new AgentCoordinationError(
              "launch_storage_conflict",
              "Private runtime storage belongs to exactly one agent generation",
            );
        }
      }
      turn.launch = {
        controllerLeaseId: authority.leaseId,
        backend: agent.contract.backend,
        runtime: agent.contract.runtime,
        manifest,
        manifestDigest,
        stop: null,
        native: null,
      };
      this.saveTurn(turn);
      this.event(authority, "agent.launch_reserved", identity.turnId, identity);
      return turn;
    });
  }

  /**
   * Validate a persisted launch against the exact agent generation that owns its
   * turn.  This is deliberately a read-only check: recovery may use it without
   * requiring a current executable, credentials, filesystem, or Herdr server.
   */
  validateLaunchBinding(runId: string, identity: TurnIdentity): TurnRecord {
    const turn = this.turn(runId, identity);
    if (!turn.launch)
      throw new AgentCoordinationError(
        "launch_missing",
        "Submitted turn has no durable launch identity",
      );
    const agent = this.instance(runId, identity);
    const workspace = this.workspace(runId, identity);
    this.assertLaunchBinding(
      runId,
      identity,
      agent,
      workspace,
      turn.launch.backend,
      turn.launch.runtime,
      turn.launch.manifest,
      turn.launch.native,
    );
    return turn;
  }

  /** Persist the observed owned terminal before issuing native agent start. */
  bindNativeLaunch(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    input: NativeLaunchEndpoint,
  ): TurnRecord {
    return this.access.transaction(authority, () => {
      const turn = this.turn(authority.runId, identity);
      const agent = this.instance(authority.runId, identity);
      const native = NativeLaunchEndpointSchema.parse(input);
      this.active(authority);
      this.requireCurrent(turn);
      if (
        agent.contract.runtime !== "herdr" ||
        !turn.launch ||
        turn.launch.controllerLeaseId !== authority.leaseId ||
        turn.status !== "submitting"
      )
        throw new AgentCoordinationError(
          "wrong_native_launch",
          "Native endpoint requires the current controlled Herdr launch",
        );
      this.assertNativeLaunchBinding(agent, native);
      if (turn.launch.native && digestJson(turn.launch.native) !== digestJson(native))
        throw new AgentCoordinationError(
          "native_endpoint_changed",
          "Native launch endpoint cannot be replaced",
        );
      if (!turn.launch.native) {
        if (
          this.db
            .prepare(
              "SELECT 1 FROM agent_turns WHERE json_extract(record_json, '$.launch.native.socketIdentity') = ? AND json_extract(record_json, '$.launch.native.terminalId') = ?",
            )
            .get(native.socketIdentity, native.terminalId)
        )
          throw new AgentCoordinationError(
            "native_endpoint_in_use",
            "Native terminal already belongs to another launch",
          );
        turn.launch.native = native;
        this.saveTurn(turn);
        this.event(authority, "agent.native_bound", identity.turnId, identity);
      }
      return turn;
    });
  }

  /** Trusted adapter only: supervisor receipt or same-controller proof the transport was never invoked; never model output. */
  recordLaunchStop(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    input: CodexLaunchStop,
  ): TurnRecord {
    return this.access.transaction(authority, () => {
      const turn = this.turn(authority.runId, identity);
      const stop = CodexLaunchStopSchema.parse(input);
      if (!turn.launch || stop.generation !== turn.launch.manifest.generation)
        throw new AgentCoordinationError(
          "wrong_launch",
          "Stop receipt does not belong to this turn's launcher",
        );
      if (turn.launch.stop && digestJson(turn.launch.stop) !== digestJson(stop))
        throw new AgentCoordinationError(
          "stop_conflict",
          "A launcher cannot acquire different stop evidence",
        );
      if (!turn.launch.stop) {
        turn.launch.stop = stop;
        this.saveTurn(turn);
        this.event(authority, "agent.launch_stopped", identity.turnId, identity);
      }
      return turn;
    });
  }

  /** Only the SDK adapter may report this; accounting grants no result or stop authority. */
  recordSdkUsage(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    launchGeneration: string,
    input: NonNullable<TurnRecord["sdkUsage"]>,
  ): TurnRecord {
    return this.access.transaction(authority, () => {
      const turn = this.turn(authority.runId, identity);
      const usage = TurnRecordSchema.shape.sdkUsage.unwrap().parse(input);
      if (
        this.instance(authority.runId, identity).contract.runtime !== "sdk" ||
        !turn.launch ||
        turn.launch.manifest.generation !== launchGeneration ||
        turn.launch.stop ||
        turn.stopEvidence ||
        !turn.submissionAcknowledgement
      )
        throw new AgentCoordinationError(
          "usage_not_current",
          "Usage needs the acknowledged, unstopped SDK launch",
        );
      this.requireCurrent(turn);
      if (turn.sdkUsage && digestJson(turn.sdkUsage) !== digestJson(usage))
        throw new AgentCoordinationError("usage_conflict", "Completed-turn usage is immutable");
      if (!turn.sdkUsage) {
        turn.sdkUsage = usage;
        this.saveTurn(turn);
        this.event(authority, "agent.sdk_usage", JSON.stringify(usage), identity);
      }
      return turn;
    });
  }

  /** Trusted provider adapters only: preserves the first exact-launch provider cause. */
  recordEssentialFailure(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    input: EssentialTurnFailure,
  ): TurnRecord {
    return this.access.transaction(authority, () => {
      const turn = this.turn(authority.runId, identity);
      const failure = EssentialTurnFailureSchema.parse(input);
      const agent = this.instance(authority.runId, identity);
      if (
        !sameTurn(failure.identity, identity) ||
        agent.contract.runtime !== "sdk" ||
        !turn.launch ||
        turn.launch.manifest.generation !== failure.launchGeneration ||
        turn.launch.stop ||
        turn.stopEvidence ||
        turn.status === "prepared" ||
        (failure.providerSessionId !== null &&
          (agent.provider?.runtime !== "sdk" ||
            agent.provider.sessionId !== failure.providerSessionId))
      )
        throw new AgentCoordinationError(
          "failure_not_current",
          "Provider failure needs the exact active unstopped SDK launch",
        );
      this.requireCurrent(turn);
      if (turn.essentialFailure && digestJson(turn.essentialFailure) !== digestJson(failure))
        throw new AgentCoordinationError(
          "failure_conflict",
          "The first provider failure for a turn is immutable",
        );
      if (!turn.essentialFailure) {
        turn.essentialFailure = failure;
        this.saveTurn(turn);
        this.event(
          authority,
          "agent.provider_failure",
          `${failure.category}/${failure.evidence} from ${failure.source}`,
          identity,
        );
      }
      return turn;
    });
  }

  acknowledgePrompt(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    promptDigest: string,
    evidence: string,
  ): TurnRecord {
    return this.access.transaction(authority, () => {
      const turn = this.turn(authority.runId, identity);
      if (turn.promptDigest !== promptDigest)
        throw new AgentCoordinationError(
          "prompt_mismatch",
          "Acknowledgement refers to a different prompt",
        );
      if (turn.submissionAcknowledgement) return turn;
      if (!["submitting", "running", "stop_requested", "indeterminate"].includes(turn.status))
        throw new AgentCoordinationError(
          "prompt_not_submitted",
          "No submitted prompt can be acknowledged",
        );
      turn.submissionAcknowledgement = safeText(evidence, 4000);
      if (turn.status === "submitting") turn.status = "running";
      this.saveTurn(turn);
      for (const message of this.messages(authority.runId, identity)) {
        if (
          message.deliveryTurnId === identity.turnId &&
          ["reserved", "indeterminate"].includes(message.status)
        ) {
          message.status = "acknowledged";
          message.acknowledgement = turn.submissionAcknowledgement;
          this.saveMessage(message);
        }
      }
      this.event(authority, "agent.prompt_acknowledged", identity.turnId, identity);
      return turn;
    });
  }

  requestStop(authority: ControllerAuthority, identity: TurnIdentity): TurnRecord {
    return this.access.transaction(authority, () => {
      const turn = this.turn(authority.runId, identity);
      if (terminal(turn) || turn.status === "stop_requested") return turn;
      if (turn.status === "prepared") return this.cancelPreparedTurn(authority, identity);
      turn.status = "stop_requested";
      turn.stopRequested = true;
      this.saveTurn(turn);
      this.changed(authority, "agent.stop_requested", identity.turnId, identity);
      return turn;
    });
  }

  cancelPreparedTurn(authority: ControllerAuthority, identity: TurnIdentity): TurnRecord {
    return this.access.transaction(authority, () => {
      const turn = this.turn(authority.runId, identity);
      if (turn.status !== "prepared")
        throw new AgentCoordinationError(
          "prompt_may_be_submitted",
          "Only a never-dispatched prompt may return messages to the queue",
        );
      for (const message of this.messages(authority.runId, identity)) {
        if (message.deliveryTurnId === identity.turnId && message.status === "reserved") {
          message.status = "queued";
          message.deliveryTurnId = null;
          this.saveMessage(message);
        }
      }
      return this.finishTurn(authority, identity, {
        status: "cancelled",
        result: null,
        stopEvidence: "Kernel cancelled the prepared turn before dispatch",
      });
    });
  }

  /** Recovery workspace authority comes from the turn owner's relational binding, not turn JSON. */
  private relationalOwnerWorkspaceForTurn(runId: string, turnId: string): WorkspaceRecord {
    const binding = this.db
      .prepare(
        `SELECT owner.workspace_id, owner.workspace_generation
         FROM agent_turns turn_record
         JOIN agent_instances owner
           ON owner.run_id = turn_record.run_id
             AND owner.agent_id = turn_record.agent_id
             AND owner.generation = turn_record.agent_generation
         WHERE turn_record.run_id = ? AND turn_record.turn_id = ?`,
      )
      .get(runId, turnId) as { workspace_id: string; workspace_generation: number } | undefined;
    if (!binding)
      throw new AgentCoordinationError(
        "unknown_turn",
        "Turn owner binding is missing, stale, or belongs to another run",
      );
    return this.workspace(runId, {
      workspaceId: binding.workspace_id,
      workspaceGeneration: binding.workspace_generation,
    });
  }

  /** Recovery-only cancellation whose no-launch proof is intrinsic to the turn row. */
  cancelPreparedTurnWithoutOwner(
    authority: ControllerAuthority,
    identity: TurnIdentity,
  ): TurnRecord {
    return this.access.transaction(authority, () => {
      this.access.control(authority.runId);
      const turn = this.read(
        TurnRecordSchema,
        "SELECT record_json FROM agent_turns WHERE run_id = ? AND turn_id = ?",
        [authority.runId, identity.turnId],
        "unknown_turn",
      );
      this.validateTurnIntrinsic(turn);
      if (
        !sameTurn(turn.identity, identity) ||
        turn.status !== "prepared" ||
        turn.launch !== null ||
        turn.submissionAcknowledgement !== null
      )
        throw new AgentCoordinationError(
          "prompt_may_be_submitted",
          "Owner-independent cancellation requires an intrinsically valid never-launched turn",
        );
      const workspace = this.relationalOwnerWorkspaceForTurn(authority.runId, identity.turnId);
      const messages = this.all(
        AgentMailboxMessageSchema,
        "SELECT record_json FROM agent_messages WHERE run_id = ? AND agent_id = ? AND agent_generation = ? ORDER BY rowid",
        [authority.runId, identity.agentId, identity.agentGeneration],
      );
      for (const message of messages)
        if (message.deliveryTurnId === identity.turnId && message.status === "reserved") {
          message.status = "superseded";
          this.saveMessage(message);
        }
      turn.status = "cancelled";
      turn.stopRequested = true;
      turn.result = null;
      turn.resultEligible = false;
      turn.stopEvidence = "Kernel cancelled the prepared turn before dispatch";
      this.saveTurnIntrinsic(turn);
      if (workspace.activeTurnId === identity.turnId) workspace.activeTurnId = null;
      if (!["retired", "disposed"].includes(workspace.status)) workspace.status = "quarantined";
      this.saveWorkspace(workspace);
      this.changed(
        authority,
        "agent.unreadable_owner_contained",
        `${identity.agentId}/${identity.agentGeneration}: prepared turn ${identity.turnId} never launched`,
        identity,
      );
      return turn;
    });
  }

  /** Recovery-only settlement from an intrinsic, generation-bound supervisor stop receipt. */
  settleStoppedTurnWithoutOwner(
    authority: ControllerAuthority,
    identity: TurnIdentity,
  ): TurnRecord {
    return this.access.transaction(authority, () => {
      this.access.control(authority.runId);
      const turn = this.read(
        TurnRecordSchema,
        "SELECT record_json FROM agent_turns WHERE run_id = ? AND turn_id = ?",
        [authority.runId, identity.turnId],
        "unknown_turn",
      );
      this.validateTurnIntrinsic(turn);
      if (!sameTurn(turn.identity, identity))
        throw new AgentCoordinationError(
          "wrong_turn",
          "Owner-independent settlement requires the exact relational turn identity",
        );
      if (terminal(turn)) return turn;
      const stop = turn.launch?.stop;
      if (!stop || stop.generation !== turn.launch?.manifest.generation)
        throw new AgentCoordinationError(
          "launch_not_stopped",
          "Owner-independent settlement requires the exact launch's trusted stop receipt",
        );
      const workspace = this.relationalOwnerWorkspaceForTurn(authority.runId, identity.turnId);
      const messages = this.all(
        AgentMailboxMessageSchema,
        "SELECT record_json FROM agent_messages WHERE run_id = ? AND agent_id = ? AND agent_generation = ? ORDER BY rowid",
        [authority.runId, identity.agentId, identity.agentGeneration],
      );
      for (const message of messages)
        if (message.deliveryTurnId === identity.turnId && message.status === "reserved") {
          message.status = "indeterminate";
          this.saveMessage(message);
        }
      turn.status = "cancelled";
      turn.stopRequested = true;
      turn.result = null;
      turn.resultEligible = false;
      turn.stopEvidence = JSON.stringify(stop);
      this.saveTurnIntrinsic(turn);
      if (workspace.activeTurnId === identity.turnId) workspace.activeTurnId = null;
      if (!["retired", "disposed"].includes(workspace.status)) workspace.status = "quarantined";
      this.saveWorkspace(workspace);
      this.changed(
        authority,
        "agent.unreadable_owner_contained",
        `${identity.agentId}/${identity.agentGeneration}: turn ${identity.turnId} settled from ${stop.kind} launch-stop proof; retained result invalidated`,
        identity,
      );
      return turn;
    });
  }

  markIndeterminate(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    reason: string,
  ): TurnRecord {
    return this.access.transaction(authority, () => {
      const turn = this.turn(authority.runId, identity);
      if (terminal(turn)) return turn;
      if (turn.status === "indeterminate") return turn;
      if (turn.status === "prepared") return this.cancelPreparedTurn(authority, identity);
      turn.status = "indeterminate";
      turn.resultEligible = false;
      this.saveTurn(turn);
      this.changed(authority, "agent.turn_indeterminate", safeText(reason, 4000), identity);
      return turn;
    });
  }

  /** Call only after the adapter's supervisor proves the exact turn's descendants stopped. */
  finishTurn(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    input: {
      status: "completed" | "failed" | "cancelled";
      result: unknown;
      stopEvidence: string;
    },
  ): TurnRecord {
    return this.access.transaction(authority, () => {
      const turn = this.turn(authority.runId, identity);
      const result = redactResult(JsonValueSchema.parse(input.result));
      if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
        throw new AgentCoordinationError("result_too_large", "Turn result exceeds one MiB");
      const stopEvidence = safeText(input.stopEvidence, 4000);
      if (terminal(turn)) {
        if (
          turn.status === input.status &&
          digestJson(turn.result) === digestJson(result) &&
          turn.stopEvidence === stopEvidence
        )
          return turn;
        throw new AgentCoordinationError(
          "turn_replay_mismatch",
          "A settled turn cannot acquire a different result",
        );
      }
      if (turn.status === "prepared" && input.status !== "cancelled")
        throw new AgentCoordinationError(
          "turn_not_submitted",
          "A prepared turn cannot produce a runtime result",
        );
      if (turn.launch && turn.status !== "prepared") {
        if (!turn.launch.stop)
          throw new AgentCoordinationError(
            "launch_not_stopped",
            "The exact launch requires a trusted stop receipt",
          );
        if (
          input.status === "completed" &&
          (turn.launch.controllerLeaseId !== authority.leaseId ||
            turn.launch.stop.kind !== "stopped" ||
            turn.launch.stop.code !== 0 ||
            turn.launch.stop.interrupted)
        )
          throw new AgentCoordinationError(
            "launch_result_ineligible",
            "An interrupted, failed, or old-controller launch cannot complete a turn",
          );
      }
      const agent = this.instance(authority.runId, identity);
      const workspace = this.workspace(authority.runId, identity);
      turn.resultEligible =
        input.status === "completed" &&
        !turn.stopRequested &&
        agent.status === "busy" &&
        agent.provider !== null &&
        agent.activeTurnId === identity.turnId &&
        workspace.status === "ready" &&
        workspace.activeTurnId === identity.turnId &&
        turn.policyDigest === this.access.control(authority.runId).policyDigest &&
        this.access.control(authority.runId).status === "active" &&
        turn.submissionAcknowledgement !== null &&
        result !== null;
      turn.status = input.status;
      turn.result = result;
      turn.stopEvidence = stopEvidence;
      this.saveTurn(turn);
      for (const message of this.messages(authority.runId, identity)) {
        if (message.deliveryTurnId === identity.turnId && message.status === "reserved") {
          message.status = "indeterminate";
          this.saveMessage(message);
        }
      }
      if (agent.activeTurnId === identity.turnId) {
        agent.activeTurnId = null;
        if (agent.status === "busy") agent.status = agent.provider ? "ready" : "reserved";
        this.saveAgent(agent);
      }
      if (workspace.activeTurnId === identity.turnId) {
        workspace.activeTurnId = null;
        this.saveWorkspace(workspace);
      }
      this.event(
        authority,
        "agent.turn_settled",
        `${identity.turnId}: ${turn.status}; eligible=${turn.resultEligible}`,
        identity,
      );
      return turn;
    });
  }

  revokeAgent(
    authority: ControllerAuthority,
    identity: AgentIdentity,
    reason: string,
  ): AgentInstance {
    return this.access.transaction(authority, () => {
      const agent = this.instance(authority.runId, identity);
      // A healthy conversation may have been retired during runtime handoff.
      // Retirement preserves evidence, but cannot shield it from later revocation.
      if (
        agent.status === "revoked" ||
        (agent.status === "released" && agent.revokedReason !== null)
      )
        return agent;
      agent.status = "revoked";
      agent.revokedReason = safeText(reason, 4000);
      this.saveAgent(agent);
      const workspace = this.workspace(authority.runId, agent);
      // Evidence revocation cannot restore a retired directory to an active namespace.
      if (!["retired", "disposed"].includes(workspace.status)) workspace.status = "quarantined";
      this.saveWorkspace(workspace);
      for (const turn of this.validatedTurnsForAgent(authority.runId, agent)) {
        if (
          turn.identity.agentId === identity.agentId &&
          turn.identity.agentGeneration === identity.agentGeneration
        ) {
          turn.resultEligible = false;
          this.saveTurn(turn);
        }
      }
      this.changed(
        authority,
        "agent.revoked",
        `${identity.agentId}/${identity.agentGeneration}: ${agent.revokedReason}`,
      );
      return agent;
    });
  }

  releaseAgent(authority: ControllerAuthority, identity: AgentIdentity): AgentInstance {
    return this.access.transaction(authority, () => {
      const agent = this.instance(authority.runId, identity);
      if (agent.status === "released") return agent;
      if (agent.status !== "revoked")
        throw new AgentCoordinationError(
          "agent_not_revoked",
          "Revoke authority before releasing provider resources",
        );
      if (agent.activeTurnId)
        throw new AgentCoordinationError(
          "agent_not_stopped",
          "Cannot release an instance whose turn may still be running",
        );
      agent.status = "released";
      this.saveAgent(agent);
      this.changed(authority, "agent.released", `${identity.agentId}/${identity.agentGeneration}`);
      return agent;
    });
  }

  /** End future conversation authority without revoking historical evidence or deleting resources. */
  retireStoppedAgent(
    authority: ControllerAuthority,
    identity: AgentIdentity,
    reason?: string,
  ): AgentInstance {
    return this.retireStoppedAgentWithClaim(authority, identity, reason, "relinquish");
  }

  private retireStoppedAgentWithClaim(
    authority: ControllerAuthority,
    identity: AgentIdentity,
    reason: string | undefined,
    claim: "relinquish" | "abandon",
  ): AgentInstance {
    return this.access.transaction(authority, () => {
      const agent = this.instance(authority.runId, identity);
      if (
        agent.activeTurnId ||
        this.validatedTurnsForAgent(authority.runId, agent).some(
          (turn) => !turn.stopEvidence || (turn.launch !== null && turn.launch.stop === null),
        )
      )
        throw new AgentCoordinationError(
          "agent_not_stopped",
          "Retirement needs every exact turn and launch stopped",
        );
      if (
        this.messages(authority.runId, identity).some(
          (message) => !["acknowledged", "superseded"].includes(message.status),
        )
      )
        throw new AgentCoordinationError(
          "mailbox_pending",
          "Retirement cannot discard pending instructions",
        );
      if (agent.status === "released") return agent;
      if (claim === "relinquish") this.relinquishUnboundConversationClaim(authority, agent);
      agent.status = "released";
      this.saveAgent(agent);
      this.changed(
        authority,
        "agent.retired",
        `${agent.agentId}/${agent.agentGeneration}: conversation retired; evidence and resources retained${reason ? `; ${safeText(reason, 4000)}` : ""}`,
      );
      return agent;
    });
  }

  /** Exact current-to-root ownership chain for one explicitly transferred conversation. */
  conversationLineageIdentities(runId: string, identity: AgentIdentity): AgentIdentity[] {
    const agent = this.instance(runId, identity);
    return [
      { agentId: agent.agentId, agentGeneration: agent.agentGeneration },
      ...this.conversationLineage(runId, agent).identities.map((owner) => ({ ...owner })),
    ];
  }

  /**
   * Resolve and validate the complete explicit ownership chain for a continued
   * conversation. No session or provider-home sharing is authorized by matching
   * strings alone; every historical owner must be connected by a durable transfer.
   */
  private conversationLineage(
    runId: string,
    agent: AgentInstance,
    ownership: Map<string, AgentOwnershipAssessment> | null = null,
  ): {
    identities: AgentIdentity[];
    readableAgents: AgentInstance[];
    ownership: Map<string, AgentOwnershipAssessment> | null;
  } {
    const identities: AgentIdentity[] = [];
    const readableAgents: AgentInstance[] = [];
    const visited = new Set<string>([agentIdentityKey(agent)]);
    let currentIdentity: AgentIdentity = agent;
    let continuation = agent.conversationContinuation;
    while (continuation) {
      ownership ??= this.ownershipInventory(runId);
      const transfer = this.validatedConversationTransfer(
        runId,
        continuation.transferId,
        ownership,
      );
      if (
        !["claimed", "consumed"].includes(transfer.status) ||
        transfer.targetAgentId !== currentIdentity.agentId ||
        transfer.targetAgentGeneration !== currentIdentity.agentGeneration ||
        digestJson(continuation) !==
          digestJson({
            transferId: transfer.transferId,
            sourceAgentId: transfer.sourceAgentId,
            sourceAgentGeneration: transfer.sourceAgentGeneration,
            sessionId: transfer.sessionId,
            providerHome: transfer.providerHome,
          })
      )
        throw new AgentCoordinationError(
          "conversation_transfer_mismatch",
          "Conversation continuation does not match its exact durable transfer",
        );
      const sourceIdentity = {
        agentId: transfer.sourceAgentId,
        agentGeneration: transfer.sourceAgentGeneration,
      };
      const key = agentIdentityKey(sourceIdentity);
      if (visited.has(key))
        throw new AgentCoordinationError(
          "conversation_transfer_cycle",
          "Conversation transfer lineage contains an ownership cycle",
        );
      visited.add(key);
      const assessment = (ownership ??= this.ownershipInventory(runId)).get(
        agentIdentityKey(sourceIdentity),
      );
      if (!assessment)
        throw new AgentCoordinationError("unknown_agent", "Unknown agent ownership identity");
      if (assessment.state === "uncontained")
        throw new AgentCoordinationError(
          "agent_integrity_uncontained",
          `Conversation ancestor ${sourceIdentity.agentId}/${sourceIdentity.agentGeneration} has work whose stop cannot be proved`,
        );
      identities.push(sourceIdentity);
      if (assessment.state === "valid") {
        const source = assessment.agent;
        if (
          source.status !== "released" ||
          source.activeTurnId !== null ||
          source.provider?.backend !== "codex" ||
          source.provider.sessionId !== transfer.sessionId ||
          source.workspaceId !== transfer.workspaceId ||
          source.workspaceGeneration !== transfer.workspaceGeneration ||
          this.providerHome(source) !== transfer.providerHome
        )
          throw new AgentCoordinationError(
            "conversation_transfer_changed",
            "A readable conversation ancestor no longer matches its consumed transfer",
          );
        readableAgents.push(source);
        continuation = source.conversationContinuation;
      } else {
        const row = this.db
          .prepare(
            "SELECT conversation_transfer_id FROM agent_instances WHERE run_id = ? AND agent_id = ? AND generation = ?",
          )
          .get(runId, sourceIdentity.agentId, sourceIdentity.agentGeneration) as
          { conversation_transfer_id: string | null } | undefined;
        if (!row)
          throw new AgentCoordinationError(
            "unknown_agent",
            "Conversation transfer source is missing from relational ownership history",
          );
        continuation = row.conversation_transfer_id
          ? (() => {
              const previous = this.transferRecord(runId, row.conversation_transfer_id);
              return {
                transferId: previous.transferId,
                sourceAgentId: previous.sourceAgentId,
                sourceAgentGeneration: previous.sourceAgentGeneration,
                sessionId: previous.sessionId,
                providerHome: previous.providerHome,
              };
            })()
          : null;
      }
      currentIdentity = sourceIdentity;
    }
    return { identities, readableAgents, ownership };
  }

  private validatedTurnsForAgent(runId: string, agent: AgentInstance): TurnRecord[] {
    return this.all(
      TurnRecordSchema,
      "SELECT record_json FROM agent_turns WHERE run_id = ? AND agent_id = ? AND agent_generation = ? ORDER BY rowid",
      [runId, agent.agentId, agent.agentGeneration],
    ).map((turn) => this.validateTurnAgainstAgent(turn, agent));
  }

  private providerHome(agent: AgentInstance): string {
    return (
      agent.conversationContinuation?.providerHome ??
      join(
        agent.execution.runtimeRoot,
        agent.runId,
        `${agent.agentId}-${agent.agentGeneration}`,
        "provider",
      )
    );
  }

  /** A stopped target that never acquired provider identity may yield the same durable transfer. */
  private relinquishUnboundConversationClaim(
    authority: ControllerAuthority,
    agent: AgentInstance,
  ): void {
    if (agent.provider !== null || !agent.conversationContinuation) return;
    const row = this.db
      .prepare(
        "SELECT record_json FROM agent_conversation_transfers WHERE run_id = ? AND transfer_id = ? AND status = 'claimed'",
      )
      .get(agent.runId, agent.conversationContinuation.transferId) as
      { record_json: string } | undefined;
    if (!row) return;
    const transfer = AgentConversationTransferSchema.parse(JSON.parse(row.record_json));
    if (
      transfer.targetAgentId !== agent.agentId ||
      transfer.targetAgentGeneration !== agent.agentGeneration
    )
      throw new AgentCoordinationError(
        "conversation_transfer_mismatch",
        "Only the exact stopped claim target may relinquish a conversation transfer",
      );
    transfer.status = "pending";
    transfer.targetAgentId = null;
    transfer.targetAgentGeneration = null;
    transfer.claimedAt = null;
    this.saveConversationTransfer(transfer);
    this.event(
      authority,
      "agent.conversation_transfer_relinquished",
      `${agent.agentId}/${agent.agentGeneration}: ${transfer.transferId}`,
    );
  }

  private runConfiguration(runId: string) {
    const row = this.db.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(runId) as {
      state_json: string;
    };
    return RunStateSchema.parse(JSON.parse(row.state_json)).runtimeConfiguration;
  }

  private checkAssignment(
    agent: AgentInstance,
    assignment: AgentAssignment,
    workspace: WorkspaceRecord,
    policy: RepositoryPolicy,
  ): void {
    if (!agent.contract.effective.model)
      throw new AgentCoordinationError(
        "model_not_pinned",
        "Adaptive instances require a concrete effective model",
      );
    if (agent.role === "orchestrator") {
      if (
        agent.contract.effective.model !== ORCHESTRATOR_MODEL ||
        agent.contract.requested.model !== ORCHESTRATOR_MODEL ||
        !policy.coordinator.reasoningEfforts.some(
          (effort) => effort === agent.contract.effective.reasoningEffort,
        )
      )
        throw new AgentCoordinationError(
          "invalid_coordinator_settings",
          "Coordinator contract must use policy-approved Astra settings",
        );
      if (
        assignment.purpose !== "coordination" ||
        workspace.purpose !== "coordinator" ||
        workspace.sourceMode !== "immutable"
      )
        throw new AgentCoordinationError(
          "invalid_assignment",
          "Coordinator requires an immutable coordination workspace",
        );
    } else if (assignment.purpose === "coordination")
      throw new AgentCoordinationError("invalid_assignment", "Only the coordinator may coordinate");
    if (
      ["implementation", "epic_repair"].includes(assignment.purpose) &&
      (agent.role !== "implementation" ||
        workspace.purpose !== "implementation" ||
        workspace.sourceMode !== "mutable" ||
        (assignment.purpose === "implementation" && !assignment.taskId))
    )
      throw new AgentCoordinationError(
        "invalid_assignment",
        "Implementation requires a task-scoped exclusive writer workspace",
      );
    if (
      ["review", "verification", "final_review"].includes(assignment.purpose) &&
      (agent.role !== "review" ||
        !["review", "verification"].includes(workspace.purpose) ||
        workspace.sourceMode !== "immutable" ||
        !assignment.candidateId)
    )
      throw new AgentCoordinationError(
        "invalid_assignment",
        "Independent review requires an immutable candidate workspace",
      );
    if (assignment.purpose === "specialist" && workspace.purpose !== "diagnostic")
      throw new AgentCoordinationError(
        "invalid_assignment",
        "Specialists require separate diagnostic workspaces",
      );
  }
  private requireCurrent(turn: TurnRecord): void {
    const agent = this.instance(turn.identity.runId, turn.identity);
    const workspace = this.workspace(turn.identity.runId, turn.identity);
    if (
      agent.status !== "busy" ||
      agent.activeTurnId !== turn.identity.turnId ||
      workspace.status !== "ready" ||
      workspace.activeTurnId !== turn.identity.turnId ||
      turn.policyDigest !== this.access.control(turn.identity.runId).policyDigest
    )
      throw new AgentCoordinationError("stale_turn", "Turn authority or workspace has changed");
  }
  private assertLaunchBinding(
    runId: string,
    identity: TurnIdentity,
    agent: AgentInstance,
    workspace: WorkspaceRecord,
    backend: string,
    runtime: RuntimeKind,
    manifest: CodexLaunch,
    native: NativeLaunchEndpoint | null = null,
  ): void {
    const home = join(
      agent.execution.runtimeRoot,
      runId,
      `${agent.agentId}-${agent.agentGeneration}`,
    );
    const expectedSourceMode =
      workspace.sourceMode === "immutable" ? "read-only" : "workspace-write";
    const expectedProviderHome =
      agent.conversationContinuation?.providerHome ?? join(home, "provider");
    if (
      backend !== agent.contract.backend ||
      runtime !== agent.contract.runtime ||
      (runtime === "herdr") !== (agent.execution.herdr !== null) ||
      manifest.confinement.executable !== agent.execution.executable ||
      manifest.confinement.providerHome !== expectedProviderHome ||
      manifest.confinement.scratch !== join(home, "scratch") ||
      manifest.confinement.artifacts !== join(home, "artifacts") ||
      manifest.controlDirectory !== join(home, "launches", identity.turnId) ||
      digestJson(agent.accountBinding ?? null) !== digestJson(manifest.accountBinding ?? null) ||
      manifest.authCachePath !== (agent.accountBinding?.source.authCachePath ?? null) ||
      manifest.confinement.workspace !== workspace.path ||
      manifest.confinement.sourceMode !== expectedSourceMode ||
      manifest.model !== agent.contract.effective.model ||
      manifest.reasoningEffort !== agent.contract.effective.reasoningEffort
    )
      throw new AgentCoordinationError(
        "launch_contract_mismatch",
        "Persisted launch does not match the assigned agent execution and account binding",
      );
    if (native !== null) this.assertNativeLaunchBinding(agent, native);
  }
  private assertNativeLaunchBinding(agent: AgentInstance, native: NativeLaunchEndpoint): void {
    const endpoint = agent.execution.herdr;
    if (
      !endpoint ||
      native.sessionName !== endpoint.sessionName ||
      native.workspaceId !== endpoint.workspaceId
    )
      throw new AgentCoordinationError(
        "native_endpoint_mismatch",
        "Native endpoint differs from the recorded Herdr execution",
      );
  }
  private recoveryTurn(runId: string, rowId: number, recordJson: string): RecoveryTurn {
    let raw: unknown;
    try {
      raw = JSON.parse(recordJson);
    } catch (failure) {
      return { rowId, identity: null, turn: null, failure, ownerValidity: "unreadable" };
    }
    const rawIdentity =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).identity
        : undefined;
    const parsedIdentity = TurnIdentitySchema.safeParse(rawIdentity);
    const identity =
      parsedIdentity.success && parsedIdentity.data.runId === runId ? parsedIdentity.data : null;
    const parsedTurn = TurnRecordSchema.safeParse(raw);
    if (!parsedTurn.success)
      return {
        rowId,
        identity,
        turn: null,
        failure: parsedTurn.error,
        ownerValidity: "unreadable",
      };
    if (parsedTurn.data.identity.runId !== runId)
      return {
        rowId,
        identity: null,
        turn: null,
        failure: new InvalidTurnRecordError("Persisted turn belongs to another run"),
        ownerValidity: "unreadable",
      };
    try {
      this.validateTurnIntrinsic(parsedTurn.data);
    } catch (failure) {
      return {
        rowId,
        identity: parsedTurn.data.identity,
        turn: null,
        failure,
        ownerValidity: "unreadable",
      };
    }
    if (parsedTurn.data.stopEvidence !== null)
      return {
        rowId,
        identity: parsedTurn.data.identity,
        turn: parsedTurn.data,
        failure: null,
        ownerValidity: "not_required",
      };
    try {
      this.validateTurn(parsedTurn.data);
      return {
        rowId,
        identity: parsedTurn.data.identity,
        turn: parsedTurn.data,
        failure: null,
        ownerValidity: "readable",
      };
    } catch (failure) {
      if (!expectedTurnRecoveryFailure(failure)) throw failure;
      if (parsedTurn.data.launch?.stop)
        return {
          rowId,
          identity: parsedTurn.data.identity,
          turn: parsedTurn.data,
          failure,
          ownerValidity: "not_required",
        };
      if (parsedTurn.data.status === "prepared")
        return {
          rowId,
          identity: parsedTurn.data.identity,
          turn: parsedTurn.data,
          failure,
          ownerValidity: "unreadable",
        };
      return {
        rowId,
        identity: parsedTurn.data.identity,
        turn: null,
        failure,
        ownerValidity: "unreadable",
      };
    }
  }

  private validateTurn(turn: TurnRecord): TurnRecord {
    const agent = this.instance(turn.identity.runId, turn.identity);
    return this.validateTurnAgainstAgent(turn, agent);
  }
  private validateTurnAgainstAgent(turn: TurnRecord, agent: AgentInstance | undefined): TurnRecord {
    this.validateTurnIntrinsic(turn);
    if (!agent) throw new InvalidTurnRecordError("Persisted turn has no readable owning agent");
    if (
      turn.launch &&
      (turn.launch.backend !== agent.contract.backend ||
        turn.launch.runtime !== agent.contract.runtime)
    )
      throw new InvalidTurnRecordError(
        "Persisted turn launch differs from its owning agent contract",
      );
    return turn;
  }
  private validateTurnIntrinsic(turn: TurnRecord): TurnRecord {
    if (
      !sameTurn(turn.identity, turn.prompt.identity) ||
      digestJson(turn.prompt) !== turn.promptDigest ||
      (turn.launch &&
        (digestJson(turn.launch.manifest) !== turn.launch.manifestDigest ||
          (turn.launch.stop && turn.launch.stop.generation !== turn.launch.manifest.generation))) ||
      (turn.essentialFailure !== undefined &&
        (!sameTurn(turn.identity, turn.essentialFailure.identity) ||
          !turn.launch ||
          turn.essentialFailure.launchGeneration !== turn.launch.manifest.generation)) ||
      turn.prompt.assignment.assignmentId !== turn.identity.assignmentId ||
      terminal(turn) !== ["completed", "failed", "cancelled"].includes(turn.status) ||
      (turn.resultEligible &&
        (turn.status !== "completed" || turn.result === null || !turn.submissionAcknowledgement)) ||
      (turn.prompt.diagnosticContext !== undefined &&
        (!["review", "verification", "final_review"].includes(turn.prompt.assignment.purpose) ||
          turn.prompt.reviewContext !== undefined ||
          digestJson(turn.outputSchema) !== digestJson(AGENT_DIAGNOSTIC_OUTPUT_SCHEMA) ||
          (turn.launch && turn.launch.manifest.confinement.sourceMode !== "read-only")))
    )
      throw new InvalidTurnRecordError(
        "Persisted turn identity, prompt digest, or terminal evidence is inconsistent",
      );
    return turn;
  }
  private active(authority: ControllerAuthority, expectedVersion?: number): ControlState {
    const control = this.access.control(authority.runId);
    if (control.status !== "active")
      throw new AgentCoordinationError("run_not_active", `Run is ${control.status}`);
    if (expectedVersion !== undefined && control.controlVersion !== expectedVersion)
      throw new AgentCoordinationError(
        "stale_control",
        "Control facts changed before agent operation",
      );
    return control;
  }
  private changed(
    authority: ControllerAuthority,
    kind: string,
    summary: string,
    identity: TurnIdentity | null = null,
  ): void {
    this.db
      .prepare(
        "UPDATE orchestration_runs SET control_version = control_version + 1 WHERE run_id = ?",
      )
      .run(authority.runId);
    this.event(authority, kind, summary, identity);
  }
  private event(
    authority: ControllerAuthority,
    kind: string,
    summary: string,
    identity: TurnIdentity | null = null,
  ): void {
    this.access.observe(authority, {
      source: "agent-journal",
      sourceEventId: randomUUID(),
      kind,
      summary: redactSensitiveText(summary, 7999),
      identity,
      artifactIds: [],
      wakesOrchestrator: true,
    });
    this.db
      .prepare(
        "INSERT INTO events(run_id, at, level, kind, message, detail) VALUES (?, ?, 'info', ?, ?, NULL)",
      )
      .run(authority.runId, now(), kind, redactSensitiveText(summary, 7999));
  }
  private saveWorkspace(record: WorkspaceRecord): void {
    record.updatedAt = now();
    this.db
      .prepare(
        "UPDATE workspaces SET record_json = ? WHERE run_id = ? AND workspace_id = ? AND generation = ?",
      )
      .run(
        JSON.stringify(WorkspaceRecordSchema.parse(record)),
        record.runId,
        record.workspaceId,
        record.workspaceGeneration,
      );
  }
  private saveAgent(record: AgentInstance, providerKey?: string): void {
    record.updatedAt = now();
    this.db
      .prepare(
        `UPDATE agent_instances SET record_json = ?, conversation_transfer_id = ?, provider_backend = ?, provider_runtime = ?, provider_session_id = ?${providerKey === undefined ? "" : ", provider_key = ?"} WHERE run_id = ? AND agent_id = ? AND generation = ?`,
      )
      .run(
        JSON.stringify(AgentInstanceSchema.parse(record)),
        record.conversationContinuation?.transferId ?? null,
        record.provider?.backend ?? null,
        record.provider?.runtime ?? null,
        record.provider?.sessionId ?? null,
        ...(providerKey === undefined ? [] : [providerKey]),
        record.runId,
        record.agentId,
        record.agentGeneration,
      );
  }
  private saveConversationTransfer(record: AgentConversationTransfer): void {
    const transfer = AgentConversationTransferSchema.parse(record);
    this.db
      .prepare(
        "UPDATE agent_conversation_transfers SET target_agent_id = ?, target_agent_generation = ?, status = ?, record_json = ? WHERE run_id = ? AND transfer_id = ?",
      )
      .run(
        transfer.targetAgentId,
        transfer.targetAgentGeneration,
        transfer.status,
        JSON.stringify(transfer),
        transfer.runId,
        transfer.transferId,
      );
  }
  private saveTurn(record: TurnRecord): void {
    record.updatedAt = now();
    this.validateTurn(record);
    this.db
      .prepare("UPDATE agent_turns SET record_json = ? WHERE run_id = ? AND turn_id = ?")
      .run(
        JSON.stringify(TurnRecordSchema.parse(record)),
        record.identity.runId,
        record.identity.turnId,
      );
  }
  private saveTurnIntrinsic(record: TurnRecord): void {
    record.updatedAt = now();
    this.validateTurnIntrinsic(record);
    this.db
      .prepare("UPDATE agent_turns SET record_json = ? WHERE run_id = ? AND turn_id = ?")
      .run(
        JSON.stringify(TurnRecordSchema.parse(record)),
        record.identity.runId,
        record.identity.turnId,
      );
  }
  private saveMessage(record: AgentMailboxMessage): void {
    record.updatedAt = now();
    this.db
      .prepare("UPDATE agent_messages SET record_json = ? WHERE run_id = ? AND message_id = ?")
      .run(JSON.stringify(AgentMailboxMessageSchema.parse(record)), record.runId, record.messageId);
  }
  private read<T>(schema: z.ZodType<T>, sql: string, args: (string | number)[], code: string): T {
    const row = this.db.prepare(sql).get(...args) as { record_json: string } | undefined;
    if (!row)
      throw new AgentCoordinationError(code, "Record is missing, stale, or belongs to another run");
    return schema.parse(JSON.parse(row.record_json));
  }
  private all<T>(schema: z.ZodType<T>, sql: string, args: (string | number)[]): T[] {
    return (this.db.prepare(sql).all(...args) as { record_json: string }[]).map((row) =>
      schema.parse(JSON.parse(row.record_json)),
    );
  }
}
