import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve, parse as parsePath } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AgentAssignmentSchema,
  AgentInstanceSchema,
  AgentMailboxMessageSchema,
  ProviderIdentitySchema,
  TurnRecordSchema,
  WorkspaceRecordSchema,
  type AgentAssignment,
  type AgentIdentity,
  type AgentInstance,
  type AgentMailboxMessage,
  type ProviderIdentity,
  type TurnRecord,
  type WorkspaceIdentity,
  type WorkspaceRecord,
} from "../domain/agents.js";
import {
  sameTurn,
  TurnIdentitySchema,
  type ControllerAuthority,
  type ControlState,
  type ObservationInput,
  type TurnIdentity,
} from "../domain/orchestration.js";
import { ORCHESTRATOR_MODEL, type AgentRole, type AgentSessionContract } from "../domain/types.js";
import { digestJson, type RepositoryPolicy } from "../domain/repository-policy.js";
import { redactSensitiveText } from "../util/redact.js";
import { WorkspaceOperationSchema, type WorkspaceOperation } from "../domain/workspaces.js";
import {
  CodexLaunchSchema,
  CodexLaunchStopSchema,
  type CodexLaunch,
  type CodexLaunchStop,
  NativeLaunchEndpointSchema,
  type NativeLaunchEndpoint,
} from "../domain/codex-launch.js";

export const AGENT_TABLES = [
  "workspaces",
  "workspace_operations",
  "agent_instances",
  "agent_assignments",
  "agent_turns",
  "agent_messages",
] as const;

export function createAgentsSchema(db: Database.Database): void {
  db.exec(`
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
      provider_key TEXT UNIQUE, provider_session_id TEXT UNIQUE, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      PRIMARY KEY(agent_id, generation), UNIQUE(run_id, agent_id, generation),
      FOREIGN KEY(run_id, workspace_id, workspace_generation) REFERENCES workspaces(run_id, workspace_id, generation),
      CHECK(json_extract(record_json, '$.agentId') = agent_id AND json_extract(record_json, '$.agentGeneration') = generation AND
        json_extract(record_json, '$.runId') = run_id AND json_extract(record_json, '$.workspaceId') = workspace_id AND
        json_extract(record_json, '$.workspaceGeneration') = workspace_generation AND json_extract(record_json, '$.assignmentId') = assignment_id)
    ) STRICT;
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
  `);
}

type Access = {
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
  };
const terminal = (turn: TurnRecord) => turn.stopEvidence !== null;
const now = () => new Date().toISOString();
const JsonValueSchema = z.json();
type JsonValue = z.infer<typeof JsonValueSchema>;
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

/** Durable coordination only. Provider calls and filesystem effects occur outside these transactions. */
export class AgentJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly access: Access,
  ) {}

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

  /** Synchronous admission shares the same transaction as agent turn admission. */
  beginWorkspaceOperation(
    authority: ControllerAuthority,
    identity: WorkspaceIdentity,
    kind: WorkspaceOperation["kind"],
    expectedControlVersion: number,
  ): WorkspaceOperation {
    return this.access.transaction(authority, () => {
      if (kind !== "inspect_materialization") this.active(authority, expectedControlVersion);
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
      if (operation.controllerLeaseId !== authority.leaseId)
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
  instances(runId: string): AgentInstance[] {
    return this.all(
      AgentInstanceSchema,
      "SELECT record_json FROM agent_instances WHERE run_id = ? ORDER BY rowid",
      [runId],
    );
  }
  summaries(runId: string) {
    const instances = this.instances(runId).filter(
      (agent) => agent.activeTurnId !== null || !["revoked", "released"].includes(agent.status),
    );
    // Active/uncertain turns take precedence over idle conversations in bounded context.
    instances.sort(
      (left, right) => Number(right.activeTurnId !== null) - Number(left.activeTurnId !== null),
    );
    return {
      omittedInstances: Math.max(0, instances.length - 20),
      instances: instances.slice(0, 20).map((agent) => {
        const assignment = this.assignment(runId, agent.assignmentId);
        return {
          agentId: agent.agentId,
          agentGeneration: agent.agentGeneration,
          role: agent.role,
          purpose: assignment.purpose,
          taskId: assignment.taskId,
          status: agent.status,
          activeTurnId: agent.activeTurnId,
          workspaceId: agent.workspaceId,
          workspaceGeneration: agent.workspaceGeneration,
          runtime: agent.contract.runtime,
        };
      }),
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
    return this.all(
      TurnRecordSchema,
      "SELECT record_json FROM agent_turns WHERE run_id = ? ORDER BY rowid",
      [runId],
    ).map((turn) => this.validateTurn(turn));
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
      if (
        this.instances(authority.runId).some(
          (agent) => agent.workspaceId === workspace.workspaceId && agent.status !== "released",
        )
      )
        throw new AgentCoordinationError(
          "workspace_assigned",
          "Use a fresh workspace for each agent instance",
        );
      let identity: AgentIdentity = { agentId: randomUUID(), agentGeneration: 1 };
      if (input.replaces) {
        const old = this.instance(authority.runId, input.replaces);
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
          this.instances(authority.runId).some(
            (agent) => agent.agentId === old.agentId && agent.agentGeneration > old.agentGeneration,
          )
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
      const agent = AgentInstanceSchema.parse({
        schemaVersion: 1,
        runId: authority.runId,
        ...identity,
        role: input.role,
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
        assignmentId: assignment.assignmentId,
        contract: input.contract,
        confinementProfile: input.confinementProfile,
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
          "INSERT INTO agent_instances(agent_id, generation, run_id, workspace_id, workspace_generation, assignment_id, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          agent.agentId,
          agent.agentGeneration,
          authority.runId,
          workspace.workspaceId,
          workspace.workspaceGeneration,
          assignment.assignmentId,
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
      this.changed(authority, "agent.reserved", `${agent.agentId}/${agent.agentGeneration}`);
      return agent;
    });
  }

  /** Native Herdr and resumed SDK identities are known before prompt submission. */
  bindProvider(
    authority: ControllerAuthority,
    identity: AgentIdentity,
    input: ProviderIdentity,
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
    input: ProviderIdentity,
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
    input: ProviderIdentity,
    nativeTurnBinding = false,
  ): AgentInstance {
    const provider = ProviderIdentitySchema.parse(input);
    if (provider.runtime !== agent.contract.runtime)
      throw new AgentCoordinationError(
        "wrong_runtime",
        "Provider identity does not match the pinned runtime",
      );
    if (agent.provider) {
      if (digestJson(agent.provider) === digestJson(provider)) return agent;
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
        this.turns(authority.runId).every(
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
      provider.runtime === "sdk" ? `sdk:${provider.sessionId}` : `herdr:${provider.terminalId}`;
    if (
      this.db
        .prepare(
          "SELECT 1 FROM agent_instances WHERE (provider_key = ? OR (? IS NOT NULL AND provider_session_id = ?)) AND NOT (agent_id = ? AND generation = ?)",
        )
        .get(key, provider.sessionId, provider.sessionId, agent.agentId, agent.agentGeneration)
    )
      throw new AgentCoordinationError(
        "provider_in_use",
        "Provider is already bound to another agent generation",
      );
    agent.provider = provider;
    if (agent.status === "reserved") agent.status = "ready";
    this.saveAgent(agent, key);
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
          digestJson(previous.prompt.reviewContext ?? null) !== digestJson(reviewContext ?? null)
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
      const active = this.turns(authority.runId).filter((turn) => !terminal(turn));
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
      if (
        manifest.confinement.workspace !== workspace.path ||
        manifest.confinement.sourceMode !==
          (workspace.sourceMode === "immutable" ? "read-only" : "workspace-write") ||
        manifest.model !== agent.contract.effective.model ||
        manifest.reasoningEffort !== agent.contract.effective.reasoningEffort
      )
        throw new AgentCoordinationError(
          "launch_contract_mismatch",
          "Launch must preserve the assigned workspace, source permissions, and model contract",
        );
      for (const other of this.turns(authority.runId)) {
        if (!other.launch) continue;
        const sameAgent =
          other.identity.agentId === identity.agentId &&
          other.identity.agentGeneration === identity.agentGeneration;
        for (const key of ["providerHome", "scratch", "artifacts"] as const) {
          const equal = other.launch.manifest.confinement[key] === manifest.confinement[key];
          if (sameAgent ? !equal : equal)
            throw new AgentCoordinationError(
              "launch_storage_conflict",
              "Private runtime storage belongs to exactly one agent generation",
            );
        }
      }
      turn.launch = {
        controllerLeaseId: authority.leaseId,
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
      workspace.status = "quarantined";
      this.saveWorkspace(workspace);
      for (const turn of this.turns(authority.runId)) {
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
    return this.access.transaction(authority, () => {
      const agent = this.instance(authority.runId, identity);
      if (
        agent.activeTurnId ||
        this.turns(authority.runId).some(
          (turn) =>
            turn.identity.agentId === agent.agentId &&
            turn.identity.agentGeneration === agent.agentGeneration &&
            (!turn.stopEvidence || (turn.launch !== null && turn.launch.stop === null)),
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
  private validateTurn(turn: TurnRecord): TurnRecord {
    if (
      !sameTurn(turn.identity, turn.prompt.identity) ||
      digestJson(turn.prompt) !== turn.promptDigest ||
      (turn.launch &&
        (digestJson(turn.launch.manifest) !== turn.launch.manifestDigest ||
          (turn.launch.stop && turn.launch.stop.generation !== turn.launch.manifest.generation))) ||
      turn.prompt.assignment.assignmentId !== turn.identity.assignmentId ||
      terminal(turn) !== ["completed", "failed", "cancelled"].includes(turn.status) ||
      (turn.resultEligible &&
        (turn.status !== "completed" || turn.result === null || !turn.submissionAcknowledgement))
    )
      throw new Error(
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
        `UPDATE agent_instances SET record_json = ?, provider_session_id = ?${providerKey === undefined ? "" : ", provider_key = ?"} WHERE run_id = ? AND agent_id = ? AND generation = ?`,
      )
      .run(
        JSON.stringify(AgentInstanceSchema.parse(record)),
        record.provider?.sessionId ?? null,
        ...(providerKey === undefined ? [] : [providerKey]),
        record.runId,
        record.agentId,
        record.agentGeneration,
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
