import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import type { WorkspaceIdentity, WorkspaceRecord } from "../domain/agents.js";
import {
  WorkspaceCreationSchema,
  WorkspaceCreationSourceSchema,
  WorkspaceCreationResultSchema,
  workspaceCreationScope,
  type WorkspaceCreation,
  type WorkspaceCreationSource,
  type WorkspaceCreationResult,
} from "../domain/workspace-creation.js";
import {
  CommandLifetimeSchema,
  CommandStopSchema,
  assertCommandStop,
  type CommandLifetime,
  type CommandStop,
} from "../domain/command-lifetime.js";
import { digestJson } from "../domain/repository-policy.js";
import { redactSensitiveText } from "../util/redact.js";

export function createWorkspaceCreationSchema(db: Database.Database) {
  db.exec(`CREATE TABLE workspace_creations (
    creation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL, workspace_generation INTEGER NOT NULL,
    workspace_operation_id TEXT NOT NULL UNIQUE REFERENCES workspace_operations(operation_id),
    source_operation_id TEXT UNIQUE REFERENCES workspace_operations(operation_id),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    UNIQUE(run_id, workspace_id, workspace_generation),
    FOREIGN KEY(run_id, workspace_id, workspace_generation) REFERENCES workspaces(run_id, workspace_id, generation) ON DELETE CASCADE,
    CHECK(json_extract(record_json, '$.creationId') = creation_id AND json_extract(record_json, '$.runId') = run_id AND
      json_extract(record_json, '$.workspaceId') = workspace_id AND json_extract(record_json, '$.workspaceGeneration') = workspace_generation AND
      json_extract(record_json, '$.workspaceOperationId') = workspace_operation_id AND
      json_extract(record_json, '$.sourceOperationId') IS source_operation_id)
  ) STRICT;`);
}

/** One supervisor owns the complete creation, including both sides of a managed copy. */
export class WorkspaceCreationJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly journal: OrchestrationJournal,
    private readonly transaction: <T>(authority: ControllerAuthority, body: () => T) => T,
  ) {}

  private read(sql: string, params: string[]): WorkspaceCreation | null {
    const row = this.db.prepare(sql).get(...params) as { record_json: string } | undefined;
    return row ? WorkspaceCreationSchema.parse(JSON.parse(row.record_json)) : null;
  }
  get(runId: string, creationId: string): WorkspaceCreation {
    const record = this.read(
      "SELECT record_json FROM workspace_creations WHERE run_id=? AND creation_id=?",
      [runId, creationId],
    );
    if (!record) throw new Error("No such workspace creation in this run");
    return record;
  }
  forWorkspace(runId: string, identity: WorkspaceIdentity): WorkspaceCreation | null {
    return this.read(
      "SELECT record_json FROM workspace_creations WHERE run_id=? AND workspace_id=? AND workspace_generation=?",
      [runId, identity.workspaceId, String(identity.workspaceGeneration)],
    );
  }
  forWorkspaceOperation(runId: string, operationId: string): WorkspaceCreation | null {
    return this.read(
      "SELECT record_json FROM workspace_creations WHERE run_id=? AND (workspace_operation_id=? OR source_operation_id=?)",
      [runId, operationId, operationId],
    );
  }
  reserve(
    authority: ControllerAuthority,
    input: {
      root: string;
      revision: string;
      purpose: WorkspaceRecord["purpose"];
      source: WorkspaceCreationSource;
      creationOperationId: string | null;
    },
  ): WorkspaceCreation {
    return this.transaction(authority, () => {
      const source = WorkspaceCreationSourceSchema.parse(input.source);
      const control = this.journal.control(authority.runId);
      const workspace = this.journal.agents.reserveWorkspace(
        authority,
        {
          root: resolve(input.root),
          purpose: input.purpose,
          sourceMode: ["coordinator", "review", "verification", "delivery"].includes(input.purpose)
            ? "immutable"
            : "mutable",
          baselineRevision: input.revision,
          ...(input.creationOperationId ? { creationOperationId: input.creationOperationId } : {}),
        },
        control.controlVersion,
      );
      const destination = this.journal.agents.beginWorkspaceOperation(
        authority,
        workspace,
        "materialize",
        this.journal.control(authority.runId).controlVersion,
      );
      const sourceOperation =
        source.kind === "repository"
          ? null
          : this.journal.agents.beginWorkspaceOperation(
              authority,
              source,
              "copy_source",
              this.journal.control(authority.runId).controlVersion,
            );
      const action = input.creationOperationId
        ? this.journal.actionForOperation(authority.runId, input.creationOperationId)
        : null;
      if (action && action.status !== "running") throw new Error("Creation action is not running");
      const record = WorkspaceCreationSchema.parse({
        creationId: randomUUID(),
        runId: authority.runId,
        controllerLeaseId: authority.leaseId,
        creationOperationId: input.creationOperationId,
        actionId: action?.actionId ?? null,
        policyDigest: control.policyDigest,
        workspaceRoot: resolve(input.root),
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
        revision: input.revision,
        purpose: input.purpose,
        source,
        workspaceOperationId: destination.operationId,
        sourceOperationId: sourceOperation?.operationId ?? null,
        execution: null,
        stop: null,
        workerResult: null,
        outcome: null,
        detail: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      });
      this.db
        .prepare("INSERT INTO workspace_creations VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          record.creationId,
          record.runId,
          record.workspaceId,
          record.workspaceGeneration,
          record.workspaceOperationId,
          record.sourceOperationId,
          JSON.stringify(record),
        );
      this.observe(authority, record, "reserved");
      return record;
    });
  }
  members(record: WorkspaceCreation) {
    const destination = this.journal.agents.workspaceOperation(
      record.runId,
      record.workspaceOperationId,
    );
    const source = record.sourceOperationId
      ? this.journal.agents.workspaceOperation(record.runId, record.sourceOperationId)
      : null;
    if (
      destination.kind !== "materialize" ||
      destination.workspaceId !== record.workspaceId ||
      destination.workspaceGeneration !== record.workspaceGeneration ||
      (source &&
        (record.source.kind === "repository" ||
          source.kind !== "copy_source" ||
          source.workspaceId !== record.source.workspaceId ||
          source.workspaceGeneration !== record.source.workspaceGeneration))
    )
      throw new Error("Creation workspace exclusions differ from their original identities");
    const operations = source ? [destination, source] : [destination];
    if (
      operations.some(
        (op) =>
          op.controllerLeaseId !== record.controllerLeaseId || op.execution || op.executionStop,
      )
    )
      throw new Error("Creation exclusion has conflicting execution ownership");
    return operations;
  }
  assertWritable(authority: ControllerAuthority, creationId: string) {
    this.journal.assertAuthority(authority);
    const record = this.get(authority.runId, creationId),
      control = this.journal.control(authority.runId);
    const workspace = this.journal.agents.workspace(authority.runId, record);
    if (
      record.outcome ||
      record.stop ||
      record.workerResult ||
      record.controllerLeaseId !== authority.leaseId ||
      control.status !== "active" ||
      control.policyDigest !== record.policyDigest ||
      workspace.status !== "reserved" ||
      workspace.path !== join(record.workspaceRoot, record.runId, record.workspaceId) ||
      workspace.sourceMode !==
        (["coordinator", "review", "verification", "delivery"].includes(record.purpose)
          ? "immutable"
          : "mutable") ||
      workspace.purpose !== record.purpose ||
      workspace.baselineRevision !== record.revision ||
      workspace.creationOperationId !== record.creationOperationId ||
      (record.actionId &&
        this.journal.action(authority.runId, record.actionId)?.status !== "running") ||
      this.members(record).some((op) => op.stopEvidence)
    )
      throw new Error("Workspace creation differs from its live admitted intent");
    return record;
  }
  bind(authority: ControllerAuthority, creationId: string, input: CommandLifetime) {
    return this.transaction(authority, () => {
      const record = this.assertWritable(authority, creationId),
        execution = CommandLifetimeSchema.parse(input);
      if (record.execution || execution.scopeDigest !== workspaceCreationScope(record))
        throw new Error("Workspace creation requires its original unused execution");
      record.execution = execution;
      this.save(record);
      this.observe(authority, record, "bound");
      return record;
    });
  }
  recordWorkerResult(
    authority: ControllerAuthority,
    creationId: string,
    input: WorkspaceCreationResult,
  ) {
    return this.transaction(authority, () => {
      const record = this.get(authority.runId, creationId);
      if (
        !record.execution ||
        record.stop ||
        record.outcome ||
        record.controllerLeaseId !== authority.leaseId ||
        this.members(record).some((op) => op.stopEvidence)
      )
        throw new Error("Creation result has no bound running worker");
      const result = WorkspaceCreationResultSchema.parse(input);
      if (result.status === "failed") result.detail = redactSensitiveText(result.detail, 3999);
      if (record.workerResult) {
        if (digestJson(record.workerResult) !== digestJson(result))
          throw new Error("Conflicting creation worker result");
        return record;
      }
      if (result.status === "created") {
        const workspace = this.journal.agents.workspace(authority.runId, record);
        if (
          workspace.status !== "ready" ||
          !workspace.directory ||
          !workspace.baselineFingerprint ||
          (record.source.kind === "snapshot" &&
            workspace.baselineFingerprint !== record.source.fingerprint)
        )
          throw new Error("Creation completion has no matching ready workspace");
      }
      record.workerResult = result;
      this.save(record);
      this.observe(authority, record, "result_retained");
      return record;
    });
  }
  /** Readiness, review binding and successful completion cannot become visible separately. */
  complete(authority: ControllerAuthority, creationId: string, fingerprint: string) {
    return this.transaction(authority, () => {
      const record = this.assertWritable(authority, creationId);
      if (!record.execution) throw new Error("Creation completion has no bound worker");
      const workspace = this.journal.agents.markWorkspaceReady(authority, record, fingerprint);
      const action = record.actionId ? this.journal.action(authority.runId, record.actionId) : null;
      if (action?.request.action.kind === "create_review_workspace")
        this.journal.delivery.bindReviewCopy(authority, action.actionId, workspace);
      return this.recordWorkerResult(authority, creationId, { status: "created" });
    });
  }
  recordStop(authority: ControllerAuthority, creationId: string, input: CommandStop) {
    return this.transaction(authority, () => {
      const record = this.get(authority.runId, creationId),
        stop = CommandStopSchema.parse(input);
      if (!record.execution) throw new Error("Creation has no bound execution");
      assertCommandStop(record.execution, stop);
      if (record.stop && digestJson(record.stop) !== digestJson(stop))
        throw new Error("Creation stop conflict");
      record.stop = stop;
      this.save(record);
      this.observe(authority, record, "stopped");
      return record;
    });
  }
  finish(authority: ControllerAuthority, creationId: string) {
    return this.transaction(authority, () => {
      const record = this.get(authority.runId, creationId);
      if (record.outcome) return record;
      const operations = this.members(record);
      if ((record.execution && !record.stop) || (!record.execution && record.workerResult))
        throw new Error(
          "Complete creation worker stop is unproven; preserve both workspace exclusions",
        );
      record.outcome = record.workerResult?.status === "created" ? "created" : "failed";
      record.detail =
        record.workerResult?.status === "failed"
          ? record.workerResult.detail
          : record.outcome === "created"
            ? "Original creation result and independent worker stop retained; no copy replayed"
            : "Creation stopped without a retained completion; preserve any copy and request a fresh workspace if useful";
      record.finishedAt = new Date().toISOString();
      this.save(record); // The same transaction makes this proof available to both exclusion gates.
      for (const operation of operations)
        this.journal.agents.finishWorkspaceOperation(
          authority,
          operation.operationId,
          record.outcome === "created" ? "succeeded" : "failed",
          record.execution
            ? "Independent complete-creation worker stop settles this exact member of the copy operation"
            : "Creation atomically cancelled before worker admission; later binding and launch are forbidden",
        );
      this.observe(authority, record, "settled");
      return record;
    });
  }
  /** null = not a creation member; false = still excluded; true = independently stopped/fenced. */
  permitsMemberStop(runId: string, operationId: string): boolean | null {
    const record = this.forWorkspaceOperation(runId, operationId);
    if (!record) return null;
    this.members(record);
    return (
      record.outcome !== null &&
      (record.execution
        ? record.stop !== null
        : record.workerResult === null && record.outcome === "failed")
    );
  }
  private save(record: WorkspaceCreation) {
    this.db
      .prepare("UPDATE workspace_creations SET record_json=? WHERE run_id=? AND creation_id=?")
      .run(JSON.stringify(WorkspaceCreationSchema.parse(record)), record.runId, record.creationId);
  }
  private observe(authority: ControllerAuthority, record: WorkspaceCreation, phase: string) {
    this.journal.appendObservation(authority, {
      source: "kernel",
      sourceEventId: randomUUID(),
      kind: `workspace.creation_${phase}`,
      summary: `${record.creationId}: ${record.workspaceId}; ${record.outcome ?? "pending"}${record.detail ? `; ${record.detail}` : ""}`,
      artifactIds: [],
      identity: null,
      wakesOrchestrator: true,
    });
  }
}
