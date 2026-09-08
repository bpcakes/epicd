import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { AgentCoordinationError } from "./agent-journal.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import type { WorkspaceIdentity } from "../domain/agents.js";
import {
  WorkspaceDisposalSchema,
  workspaceDisposalScope,
  type WorkspaceDisposal,
} from "../domain/workspace-disposal.js";
import { StateFileIdentitySchema, type StateFileIdentity } from "../domain/state-file-identity.js";
import {
  CommandLifetimeSchema,
  CommandStopSchema,
  assertCommandStop,
  type CommandLifetime,
  type CommandStop,
} from "../domain/command-lifetime.js";
import { digestJson } from "../domain/repository-policy.js";
import { redactSensitiveText } from "../util/redact.js";

export function createWorkspaceDisposalSchema(db: Database.Database) {
  db.exec(`CREATE TABLE workspace_disposals (
    disposal_id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL, workspace_generation INTEGER NOT NULL,
    operation_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    FOREIGN KEY(run_id, workspace_id, workspace_generation) REFERENCES workspaces(run_id, workspace_id, generation) ON DELETE CASCADE,
    CHECK(json_extract(record_json, '$.disposalId') = disposal_id AND
      json_extract(record_json, '$.runId') = run_id AND
      json_extract(record_json, '$.workspaceId') = workspace_id AND
      json_extract(record_json, '$.workspaceGeneration') = workspace_generation AND
      json_extract(record_json, '$.operationId') = operation_id)
  ) STRICT;
  CREATE UNIQUE INDEX one_pending_workspace_disposal ON workspace_disposals(workspace_id, workspace_generation)
    WHERE json_extract(record_json, '$.outcome') IS NULL;`);
}

export class WorkspaceDisposalJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly journal: OrchestrationJournal,
    private readonly transaction: <T>(authority: ControllerAuthority, body: () => T) => T,
  ) {}

  records(runId: string): WorkspaceDisposal[] {
    return (
      this.db
        .prepare("SELECT record_json FROM workspace_disposals WHERE run_id=? ORDER BY rowid")
        .all(runId) as { record_json: string }[]
    ).map((row) => WorkspaceDisposalSchema.parse(JSON.parse(row.record_json)));
  }
  get(runId: string, disposalId: string): WorkspaceDisposal {
    const row = this.db
      .prepare("SELECT record_json FROM workspace_disposals WHERE run_id=? AND disposal_id=?")
      .get(runId, disposalId) as { record_json: string } | undefined;
    if (!row) throw new AgentCoordinationError("unknown_disposal", "No such disposal in this run");
    return WorkspaceDisposalSchema.parse(JSON.parse(row.record_json));
  }
  forOperation(runId: string, operationId: string) {
    return this.records(runId).find((item) => item.operationId === operationId) ?? null;
  }
  forWorkspace(runId: string, identity: WorkspaceIdentity) {
    return this.records(runId).filter(
      (item) =>
        item.workspaceId === identity.workspaceId &&
        item.workspaceGeneration === identity.workspaceGeneration,
    );
  }
  reserve(
    authority: ControllerAuthority,
    actionId: string,
    archiveDirectory: StateFileIdentity,
  ): WorkspaceDisposal {
    return this.transaction(authority, () => {
      const action = this.journal.action(authority.runId, actionId);
      if (
        !action ||
        action.status !== "running" ||
        action.request.action.kind !== "dispose_workspace" ||
        action.request.expectedControlVersion !==
          this.journal.control(authority.runId).controlVersion
      )
        throw new AgentCoordinationError(
          "disposal_action",
          "Disposal needs its current admitted action",
        );
      if (
        this.forOperation(authority.runId, action.operationId) ||
        this.forWorkspace(authority.runId, action.request.action).some(
          (item) => item.outcome === null || item.outcome === "retained",
        )
      )
        throw new AgentCoordinationError(
          "disposal_exists",
          "Inspect or reconcile the original disposal instead of replaying it",
        );
      const workspace = this.journal.agents.retireWorkspace(authority, action.request.action);
      const record = WorkspaceDisposalSchema.parse({
        disposalId: randomUUID(),
        runId: authority.runId,
        operationId: action.operationId,
        controllerLeaseId: authority.leaseId,
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
        source: workspace.directory,
        archiveDirectory: StateFileIdentitySchema.parse(archiveDirectory),
        execution: null,
        stop: null,
        outcome: null,
        sourcePathOccupied: null,
        detail: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      });
      this.db
        .prepare("INSERT INTO workspace_disposals VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          record.disposalId,
          record.runId,
          record.workspaceId,
          record.workspaceGeneration,
          record.operationId,
          JSON.stringify(record),
        );
      this.observe(authority, record, "admitted");
      return record;
    });
  }
  bind(authority: ControllerAuthority, disposalId: string, input: CommandLifetime) {
    return this.transaction(authority, () => {
      const record = this.get(authority.runId, disposalId);
      const execution = CommandLifetimeSchema.parse(input);
      if (
        record.outcome ||
        record.execution ||
        record.controllerLeaseId !== authority.leaseId ||
        this.journal.control(authority.runId).status !== "active" ||
        execution.scopeDigest !== workspaceDisposalScope(record)
      )
        throw new AgentCoordinationError(
          "disposal_execution",
          "Disposal launch requires the original unused intent",
        );
      record.execution = execution;
      this.save(record);
      this.observe(authority, record, "bound");
      return record;
    });
  }
  recordStop(authority: ControllerAuthority, disposalId: string, input: CommandStop) {
    return this.transaction(authority, () => {
      const record = this.get(authority.runId, disposalId),
        stop = CommandStopSchema.parse(input);
      if (!record.execution) throw new Error("Disposal execution is not bound");
      assertCommandStop(record.execution, stop);
      if (record.stop && digestJson(record.stop) !== digestJson(stop))
        throw new Error("Disposal stop conflict");
      record.stop = stop;
      this.save(record);
      this.observe(authority, record, "stopped");
      return record;
    });
  }
  finish(
    authority: ControllerAuthority,
    disposalId: string,
    outcome: NonNullable<WorkspaceDisposal["outcome"]>,
    sourcePathOccupied: boolean | null,
    detail: string,
  ) {
    return this.transaction(authority, () => {
      const record = this.get(authority.runId, disposalId);
      if (record.outcome) return record;
      // An unbound settlement atomically fences a delayed original binder.
      if ((record.execution && !record.stop) || (!record.execution && outcome !== "not_moved"))
        throw new AgentCoordinationError(
          "disposal_unsettled",
          "Disposal needs independent stop or an atomic pre-launch fence",
        );
      record.outcome = outcome;
      record.sourcePathOccupied = sourcePathOccupied;
      record.detail = redactSensitiveText(detail, 3999);
      record.finishedAt = new Date().toISOString();
      this.save(record);
      if (outcome === "retained") this.journal.agents.finishWorkspaceDisposal(authority, record);
      this.observe(authority, record, outcome);
      return record;
    });
  }
  private save(record: WorkspaceDisposal) {
    this.db
      .prepare("UPDATE workspace_disposals SET record_json=? WHERE disposal_id=? AND run_id=?")
      .run(JSON.stringify(WorkspaceDisposalSchema.parse(record)), record.disposalId, record.runId);
  }
  private observe(authority: ControllerAuthority, record: WorkspaceDisposal, phase: string) {
    this.journal.appendObservation(authority, {
      source: "workspace-disposal",
      sourceEventId: `${record.disposalId}:${phase}`,
      kind: `workspace.disposal_${phase}`,
      summary: `Workspace ${record.workspaceId}: ${phase}. ${record.detail ?? "No permanent deletion or pane closure is authorized."}`,
      identity: null,
      artifactIds: [],
      wakesOrchestrator: true,
    });
  }
}
