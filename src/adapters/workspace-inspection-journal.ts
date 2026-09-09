import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import type { WorkspaceIdentity } from "../domain/agents.js";
import {
  WorkspaceInspectionSchema,
  WorkspaceInspectionTargetSchema,
  WorkspaceInspectionResultSchema,
  workspaceInspectionScope,
  workspaceInspectionSummary,
  workspaceInspectionObservationDetail,
  type WorkspaceInspection,
  type WorkspaceInspectionTarget,
  type WorkspaceInspectionResult,
  type CommitInspectionTarget,
} from "../domain/workspace-inspection.js";
import {
  CommandLifetimeSchema,
  CommandStopSchema,
  assertCommandStop,
  type CommandLifetime,
  type CommandStop,
} from "../domain/command-lifetime.js";
import { digestJson } from "../domain/repository-policy.js";
import { redactSensitiveText } from "../util/redact.js";

export function createWorkspaceInspectionSchema(db: Database.Database) {
  db.exec(`CREATE TABLE workspace_inspections (
    inspection_id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL, workspace_generation INTEGER NOT NULL,
    workspace_operation_id TEXT NOT NULL UNIQUE REFERENCES workspace_operations(operation_id),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    FOREIGN KEY(run_id, workspace_id, workspace_generation) REFERENCES workspaces(run_id, workspace_id, generation) ON DELETE CASCADE,
    CHECK(json_extract(record_json, '$.inspectionId') = inspection_id AND json_extract(record_json, '$.runId') = run_id AND
      json_extract(record_json, '$.workspaceId') = workspace_id AND json_extract(record_json, '$.workspaceGeneration') = workspace_generation AND
      json_extract(record_json, '$.workspaceOperationId') = workspace_operation_id)
  ) STRICT;
  CREATE INDEX workspace_inspection_history ON workspace_inspections(run_id, workspace_id, workspace_generation);
  CREATE UNIQUE INDEX one_pending_workspace_inspection ON workspace_inspections(run_id, workspace_id, workspace_generation)
    WHERE json_extract(record_json, '$.outcome') IS NULL;`);
}

/** Exact stopped observations, never a strategy choice or permission to repeat a writer. */
export class WorkspaceInspectionJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly journal: OrchestrationJournal,
    private readonly transaction: <T>(authority: ControllerAuthority, body: () => T) => T,
  ) {}
  records(runId: string): WorkspaceInspection[] {
    return (
      this.db
        .prepare("SELECT record_json FROM workspace_inspections WHERE run_id=? ORDER BY rowid")
        .all(runId) as { record_json: string }[]
    ).map((row) => WorkspaceInspectionSchema.parse(JSON.parse(row.record_json)));
  }
  /** Recovery discovers durable ownership independently of parent actions and current settings. */
  unsettled(runId: string): WorkspaceInspection[] {
    return (
      this.db
        .prepare(
          "SELECT record_json FROM workspace_inspections WHERE run_id=? AND json_extract(record_json, '$.outcome') IS NULL ORDER BY rowid",
        )
        .all(runId) as { record_json: string }[]
    ).map((row) => WorkspaceInspectionSchema.parse(JSON.parse(row.record_json)));
  }
  get(runId: string, inspectionId: string) {
    const record = this.find(runId, inspectionId);
    if (!record) throw new Error("No such workspace inspection in this run");
    return record;
  }
  find(runId: string, inspectionId: string) {
    const row = this.db
      .prepare("SELECT record_json FROM workspace_inspections WHERE run_id=? AND inspection_id=?")
      .get(runId, inspectionId) as { record_json: string } | undefined;
    return row ? WorkspaceInspectionSchema.parse(JSON.parse(row.record_json)) : undefined;
  }
  forWorkspace(runId: string, identity: WorkspaceIdentity) {
    return (
      this.db
        .prepare(
          "SELECT record_json FROM workspace_inspections WHERE run_id=? AND workspace_id=? AND workspace_generation=? ORDER BY rowid",
        )
        .all(runId, identity.workspaceId, identity.workspaceGeneration) as { record_json: string }[]
    ).map((row) => WorkspaceInspectionSchema.parse(JSON.parse(row.record_json)));
  }
  pending(runId: string, identity: WorkspaceIdentity) {
    const row = this.db
      .prepare(
        "SELECT record_json FROM workspace_inspections WHERE run_id=? AND workspace_id=? AND workspace_generation=? AND json_extract(record_json, '$.outcome') IS NULL",
      )
      .get(runId, identity.workspaceId, identity.workspaceGeneration) as
      { record_json: string } | undefined;
    return row ? WorkspaceInspectionSchema.parse(JSON.parse(row.record_json)) : null;
  }
  /** Settlement releases custody, not the association between an attempt and its commitment. */
  latestForCommit(runId: string, identity: WorkspaceIdentity, target: CommitInspectionTarget) {
    const row = this.db
      .prepare(
        `SELECT record_json FROM workspace_inspections
        WHERE run_id=? AND workspace_id=? AND workspace_generation=?
          AND json_extract(record_json, '$.target.kind')=?
          AND coalesce(json_extract(record_json, '$.target.commitId'), json_extract(record_json, '$.target.trackerCommitId'))=?
        ORDER BY rowid DESC LIMIT 1`,
      )
      .get(
        runId,
        identity.workspaceId,
        identity.workspaceGeneration,
        target.kind,
        target.kind === "application_commit" ? target.commitId : target.trackerCommitId,
      ) as { record_json: string } | undefined;
    return row ? WorkspaceInspectionSchema.parse(JSON.parse(row.record_json)) : null;
  }
  /** Bound diagnostic reads, never the number of times recovery may inspect a long-lived copy. */
  historyPreview(runId: string, identity: WorkspaceIdentity) {
    const rows = this.db
      .prepare(
        "SELECT record_json FROM workspace_inspections WHERE run_id=? AND workspace_id=? AND workspace_generation=? ORDER BY rowid DESC LIMIT 10",
      )
      .all(runId, identity.workspaceId, identity.workspaceGeneration) as { record_json: string }[];
    const { count } = this.db
      .prepare(
        "SELECT count(*) AS count FROM workspace_inspections WHERE run_id=? AND workspace_id=? AND workspace_generation=?",
      )
      .get(runId, identity.workspaceId, identity.workspaceGeneration) as { count: number };
    return {
      inspections: rows
        .reverse()
        .map((row) =>
          workspaceInspectionSummary(WorkspaceInspectionSchema.parse(JSON.parse(row.record_json))),
        ),
      omittedInspections: count - rows.length,
    };
  }
  /** Mutable completion fields are excluded; exact object and workspace identity remain pinned. */
  private targetDigest(
    runId: string,
    identity: WorkspaceIdentity,
    target: WorkspaceInspectionTarget,
  ) {
    const workspace = this.journal.agents.workspace(runId, identity);
    let object: unknown = null;
    if (target.kind !== "materialization") {
      const record =
        target.kind === "application_commit"
          ? this.journal.commits.record(runId, target.commitId)
          : this.journal.trackerCommits.record(runId, target.trackerCommitId);
      if (
        record.workspaceId !== identity.workspaceId ||
        record.workspaceGeneration !== identity.workspaceGeneration
      )
        throw new Error("Inspection commit has different workspace custody");
      const writer = this.journal.agents.workspaceOperation(runId, record.workspaceOperationId);
      if (
        !writer.stopEvidence ||
        writer.kind !== "commit" ||
        writer.workspaceId !== identity.workspaceId ||
        writer.workspaceGeneration !== identity.workspaceGeneration
      )
        throw new Error("Independently stop the original commit writer before inspection");
      const {
        status: _status,
        failure: _failure,
        finishedAt: _finished,
        sourceIntact: _intact,
        ...binding
      } = record;
      object = binding;
    }
    return digestJson({
      workspaceId: workspace.workspaceId,
      workspaceGeneration: workspace.workspaceGeneration,
      path: workspace.path,
      purpose: workspace.purpose,
      sourceMode: workspace.sourceMode,
      baselineRevision: workspace.baselineRevision,
      creationOperationId: workspace.creationOperationId,
      target,
      object,
    });
  }
  reserve(
    authority: ControllerAuthority,
    root: string,
    identity: WorkspaceIdentity,
    input: WorkspaceInspectionTarget,
  ) {
    return this.transaction(authority, () => {
      const target = WorkspaceInspectionTargetSchema.parse(input);
      const workspace = this.journal.agents.workspace(authority.runId, identity);
      if (workspace.path !== join(resolve(root), authority.runId, workspace.workspaceId))
        throw new Error("Inspection workspace root differs from registered custody");
      // Each request owns one timed worker; retries belong to its caller's policy.
      // Historical successes or failures must never prevent settling a stopped writer.
      const targetDigest = this.targetDigest(authority.runId, identity, target);
      const operation = this.journal.agents.beginWorkspaceOperation(
        authority,
        identity,
        "inspect_materialization",
        this.journal.control(authority.runId).controlVersion,
      );
      const record = WorkspaceInspectionSchema.parse({
        inspectionId: randomUUID(),
        runId: authority.runId,
        controllerLeaseId: authority.leaseId,
        workspaceRoot: resolve(root),
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
        workspaceOperationId: operation.operationId,
        target,
        targetDigest,
        execution: null,
        stop: null,
        workerResult: null,
        outcome: null,
        detail: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      });
      this.db
        .prepare("INSERT INTO workspace_inspections VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          record.inspectionId,
          record.runId,
          record.workspaceId,
          record.workspaceGeneration,
          record.workspaceOperationId,
          JSON.stringify(record),
        );
      this.observe(authority, record, "reserved");
      return record;
    });
  }
  private member(record: WorkspaceInspection) {
    const operation = this.journal.agents.workspaceOperation(
      record.runId,
      record.workspaceOperationId,
    );
    if (
      operation.kind !== "inspect_materialization" ||
      operation.workspaceId !== record.workspaceId ||
      operation.workspaceGeneration !== record.workspaceGeneration ||
      operation.controllerLeaseId !== record.controllerLeaseId ||
      operation.execution ||
      operation.executionStop
    )
      throw new Error("Inspection exclusion differs from its original ownership");
    return operation;
  }
  assertOwned(authority: ControllerAuthority, inspectionId: string) {
    // Recovery reads remain available while delivery is inactive. Original authority,
    // target and exclusion ownership fence this worker; delivery status fences new writes.
    this.journal.assertAuthority(authority);
    const record = this.get(authority.runId, inspectionId);
    if (
      record.outcome ||
      record.stop ||
      record.workerResult ||
      record.controllerLeaseId !== authority.leaseId ||
      this.member(record).stopEvidence ||
      this.targetDigest(authority.runId, record, record.target) !== record.targetDigest
    )
      throw new Error("Inspection differs from its live admitted target");
    return record;
  }
  bind(authority: ControllerAuthority, inspectionId: string, input: CommandLifetime) {
    return this.transaction(authority, () => {
      const record = this.assertOwned(authority, inspectionId),
        execution = CommandLifetimeSchema.parse(input);
      if (record.execution || execution.scopeDigest !== workspaceInspectionScope(record))
        throw new Error("Inspection requires its original unused execution");
      record.execution = execution;
      this.save(record);
      this.observe(authority, record, "bound");
      return record;
    });
  }
  recordResult(
    authority: ControllerAuthority,
    inspectionId: string,
    input: WorkspaceInspectionResult,
  ) {
    return this.transaction(authority, () => {
      const record = this.get(authority.runId, inspectionId);
      if (
        !record.execution ||
        record.stop ||
        record.outcome ||
        record.controllerLeaseId !== authority.leaseId ||
        this.member(record).stopEvidence
      )
        throw new Error("Inspection result has no bound running worker");
      // Worker diagnostics are unbounded input. Normalize them before validating
      // the bounded durable record, including the failure path of observation recording.
      const normalized =
        input.status === "failed"
          ? { ...input, detail: redactSensitiveText(input.detail, 3999) }
          : input.observation.kind !== "materialization" && input.observation.detail !== null
            ? {
                ...input,
                observation: {
                  ...input.observation,
                  detail: redactSensitiveText(input.observation.detail, 3999),
                },
              }
            : input;
      const result = WorkspaceInspectionResultSchema.parse(normalized);
      if (record.workerResult) {
        if (digestJson(record.workerResult) !== digestJson(result))
          throw new Error("Inspection result conflict");
        return record;
      }
      if (result.status === "observed") {
        if (
          result.observation.kind !== record.target.kind ||
          this.targetDigest(authority.runId, record, record.target) !== record.targetDigest
        )
          throw new Error("Inspection result differs from its exact target");
        if (
          result.observation.kind === "materialization" &&
          result.observation.ready &&
          this.journal.agents.workspace(authority.runId, record).status === "reserved"
        )
          this.journal.agents.markWorkspaceReady(authority, record, result.observation.fingerprint);
      }
      record.workerResult = result;
      this.save(record);
      this.observe(authority, record, "result_retained");
      return record;
    });
  }
  recordStop(authority: ControllerAuthority, inspectionId: string, input: CommandStop) {
    return this.transaction(authority, () => {
      const record = this.get(authority.runId, inspectionId),
        stop = CommandStopSchema.parse(input);
      if (!record.execution) throw new Error("Inspection has no bound execution");
      assertCommandStop(record.execution, stop);
      if (record.stop && digestJson(record.stop) !== digestJson(stop))
        throw new Error("Inspection stop conflict");
      record.stop = stop;
      this.save(record);
      this.observe(authority, record, "stopped");
      return record;
    });
  }
  finish(authority: ControllerAuthority, inspectionId: string) {
    return this.transaction(authority, () => {
      const record = this.get(authority.runId, inspectionId);
      if (record.outcome) return record;
      const operation = this.member(record);
      if (record.execution && !record.stop)
        throw new Error("Inspection worker stop remains unproven");
      record.outcome = record.workerResult?.status === "observed" ? "observed" : "failed";
      record.detail =
        record.workerResult?.status === "failed"
          ? record.workerResult.detail
          : record.workerResult?.status === "observed"
            ? workspaceInspectionObservationDetail(record.workerResult.observation)
            : "Inspection stopped without a retained observation; request a new inspection if useful";
      if (
        record.outcome === "observed" &&
        this.targetDigest(authority.runId, record, record.target) !== record.targetDigest
      ) {
        record.outcome = "failed";
        record.detail =
          "Inspection target changed; retained observations cannot settle its current commitment";
      }
      record.finishedAt = new Date().toISOString();
      this.save(record);
      this.journal.agents.finishWorkspaceOperation(
        authority,
        operation.operationId,
        record.outcome === "observed" ? "succeeded" : "failed",
        record.execution
          ? "Independent complete-inspection worker stop retained"
          : "Inspection atomically cancelled before worker binding; no observation inferred",
      );
      const result = record.workerResult;
      if (
        record.outcome === "observed" &&
        result?.status === "observed" &&
        result.observation.kind !== "materialization"
      ) {
        const observed = result.observation;
        if (record.target.kind === "application_commit")
          this.journal.commits.finish(
            authority,
            record.target.commitId,
            observed.created,
            observed.sourceIntact,
            observed.detail,
          );
        else if (record.target.kind === "tracker_commit")
          this.journal.trackerCommits.finish(
            authority,
            record.target.trackerCommitId,
            observed.created,
            observed.sourceIntact,
            observed.detail,
          );
      }
      this.observe(authority, record, "settled");
      return record;
    });
  }
  permitsMemberStop(runId: string, operationId: string): boolean | null {
    const row = this.db
      .prepare(
        "SELECT inspection_id FROM workspace_inspections WHERE run_id=? AND workspace_operation_id=?",
      )
      .get(runId, operationId) as { inspection_id: string } | undefined;
    if (!row) return null;
    const record = this.get(runId, row.inspection_id);
    this.member(record);
    return (
      record.outcome !== null &&
      (record.execution ? record.stop !== null : record.workerResult === null)
    );
  }
  private save(record: WorkspaceInspection) {
    this.db
      .prepare("UPDATE workspace_inspections SET record_json=? WHERE run_id=? AND inspection_id=?")
      .run(
        JSON.stringify(WorkspaceInspectionSchema.parse(record)),
        record.runId,
        record.inspectionId,
      );
  }
  private observe(authority: ControllerAuthority, record: WorkspaceInspection, phase: string) {
    this.journal.appendObservation(authority, {
      source: "kernel",
      sourceEventId: randomUUID(),
      kind: `workspace.inspection_${phase}`,
      summary: `${record.inspectionId}: ${record.target.kind}; ${record.workspaceId}; ${record.outcome ?? "pending"}${record.detail ? `; ${record.detail}` : ""}`,
      artifactIds: [],
      identity: null,
      wakesOrchestrator: true,
    });
  }
}
