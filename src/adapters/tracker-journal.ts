import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  TrackerBindingSchema,
  TrackerOperationSchema,
  TrackerSnapshotSchema,
  claimable,
  trackerActor,
  type TrackerBinding,
  type TrackerOperation,
  type TrackerGraph,
  type TrackerSnapshot,
  type TaskClaimBinding,
  type TrackerClosure,
} from "../domain/tracker.js";
import type {
  ActionRecord,
  ControllerAuthority,
  ControlState,
  ObservationInput,
} from "../domain/orchestration.js";
import { RunStateSchema } from "../domain/types.js";
import { digestJson } from "../domain/repository-policy.js";
import { redactSensitiveText } from "../util/redact.js";
import { DeliveryError } from "./delivery-journal.js";

export const TRACKER_TABLES = ["tracker_roots", "tracker_operations", "tracker_snapshots"] as const;
export function createTrackerSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS tracker_roots (
    run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
    binding_json TEXT CHECK(binding_json IS NULL OR json_valid(binding_json))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS tracker_operations (
    tracker_operation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES tracker_roots(run_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL UNIQUE REFERENCES actions(operation_id),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    CHECK(json_extract(record_json, '$.trackerOperationId') = tracker_operation_id AND
      json_extract(record_json, '$.runId') = run_id AND json_extract(record_json, '$.operationId') = operation_id)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS one_pending_tracker_operation ON tracker_operations(run_id)
    WHERE json_extract(record_json, '$.outcome') IS NULL;
  CREATE TABLE IF NOT EXISTS tracker_snapshots (
    snapshot_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES tracker_roots(run_id) ON DELETE CASCADE,
    tracker_operation_id TEXT NOT NULL REFERENCES tracker_operations(tracker_operation_id),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    CHECK(json_extract(record_json, '$.snapshotId') = snapshot_id AND json_extract(record_json, '$.runId') = run_id)
  ) STRICT;`);
}
type Access = {
  transaction<T>(authority: ControllerAuthority, body: () => T): T;
  control(runId: string): ControlState;
  action(runId: string, actionId: string): ActionRecord | null;
  observe(authority: ControllerAuthority, input: ObservationInput): unknown;
  assertPublicationIdle(runId: string): void;
  closurePublication(
    runId: string,
    taskId: string,
    revision: string,
    claim: TaskClaimBinding,
  ): import("../domain/publication.js").PublicationRecord;
};
const fail = (message: string): never => {
  throw new DeliveryError("tracker_authority", message);
};
const at = () => new Date().toISOString();
export class TrackerJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly access: Access,
  ) {}
  configured(runId: string) {
    return !!this.db.prepare("SELECT 1 FROM tracker_roots WHERE run_id = ?").get(runId);
  }
  run(runId: string) {
    const row = this.db.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(runId) as
      { state_json: string } | undefined;
    if (!row) return fail("Run baseline is missing");
    return RunStateSchema.parse(JSON.parse(row.state_json));
  }
  binding(runId: string): TrackerBinding | null {
    const row = this.db
      .prepare("SELECT binding_json FROM tracker_roots WHERE run_id = ?")
      .get(runId) as { binding_json: string | null } | undefined;
    return row?.binding_json ? TrackerBindingSchema.parse(JSON.parse(row.binding_json)) : null;
  }
  reserve(authority: ControllerAuthority, actionId: string): TrackerOperation {
    return this.access.transaction(authority, () => {
      this.access.assertPublicationIdle(authority.runId);
      if (this.pending(authority.runId))
        return fail("Reconcile the pending tracker operation before starting another");
      const action = this.access.action(authority.runId, actionId),
        control = this.access.control(authority.runId);
      if (
        !action ||
        action.status !== "running" ||
        control.status !== "active" ||
        action.policyDigest !== control.policyDigest
      )
        return fail("Tracker operation needs its current admitted action");
      const input = action.request.action;
      if (input.kind !== "refresh_tracker" && input.kind !== "request_beads_transition")
        return fail("Not a tracker action");
      if (
        input.kind === "request_beads_transition" &&
        (!(["claim", "adopt", "close_task"] as string[]).includes(input.transition) ||
          (input.transition === "close_task" ? input.revision === null : input.revision !== null))
      )
        return fail(
          "Claim/adopt need no revision; task closure needs an exact verified publication. Container/epic closure requires its own completion proof",
        );
      let closure: TrackerClosure | undefined;
      if (input.kind === "request_beads_transition" && input.transition === "close_task") {
        const claim = this.assertTaskOwned(authority.runId, input.taskId);
        if (!claim)
          return fail("Closure requires a recorded task claim, not unconfigured component state");
        const publication = this.access.closurePublication(
          authority.runId,
          input.taskId,
          input.revision!,
          claim,
        );
        if (
          this.operations(authority.runId).some(
            (record) =>
              record.outcome === "closed" &&
              record.closure?.claim.trackerOperationId === claim.trackerOperationId,
          )
        )
          return fail("This claim already has a closed operation; do not close it again");
        closure = {
          publicationId: publication.publicationId,
          revision: publication.revision,
          reviewEvidenceId: publication.reviewEvidenceId,
          claim,
          reason: `epicd run ${authority.runId}; operation ${action.operationId}; verified revision ${publication.revision}; publication ${publication.publicationId}`,
          refsVerified: false,
          intervention: false,
        };
      }
      this.db.prepare("INSERT OR IGNORE INTO tracker_roots VALUES (?, NULL)").run(authority.runId);
      const record = TrackerOperationSchema.parse({
        schemaVersion: 1,
        trackerOperationId: randomUUID(),
        runId: authority.runId,
        actionId,
        operationId: action.operationId,
        controllerLeaseId: authority.leaseId,
        ioLeaseId: authority.leaseId,
        policyDigest: control.policyDigest,
        kind: input.kind === "refresh_tracker" ? "refresh" : input.transition,
        ...(closure ? { closure } : {}),
        taskId: input.kind === "refresh_tracker" ? null : input.taskId,
        dispatched: false,
        mutationDispatched: false,
        ioStopped: false,
        beforeSnapshotId: null,
        afterSnapshotId: null,
        outcome: null,
        failure: null,
        createdAt: at(),
        finishedAt: null,
      });
      this.db
        .prepare("INSERT INTO tracker_operations VALUES (?, ?, ?, ?)")
        .run(record.trackerOperationId, record.runId, record.operationId, JSON.stringify(record));
      this.changed(authority, "tracker.reserved", record.trackerOperationId);
      return record;
    });
  }
  start(authority: ControllerAuthority, id: string) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, id);
      if (record.dispatched) return fail("Tracker dispatch is write-once; reconcile it instead");
      record.dispatched = true;
      this.save(record);
      return this.assertWritable(authority, id);
    });
  }
  assertIOOwned(authority: ControllerAuthority, id: string) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, id);
      if (record.outcome || record.ioStopped || record.ioLeaseId !== authority.leaseId)
        return fail("Tracker I/O is not owned by this controller");
      return record;
    });
  }
  assertWritable(authority: ControllerAuthority, id: string) {
    const record = this.assertIOOwned(authority, id),
      control = this.access.control(authority.runId);
    if (
      !record.dispatched ||
      record.controllerLeaseId !== authority.leaseId ||
      control.status !== "active" ||
      control.policyDigest !== record.policyDigest ||
      this.access.action(authority.runId, record.actionId)?.status !== "running"
    )
      return fail("Tracker mutation authority changed");
    this.access.assertPublicationIdle(authority.runId);
    if (record.closure) {
      const publication = this.access.closurePublication(
        record.runId,
        record.taskId!,
        record.closure.revision,
        record.closure.claim,
      );
      if (
        publication.publicationId !== record.closure.publicationId ||
        publication.reviewEvidenceId !== record.closure.reviewEvidenceId
      )
        return fail("Closure's exact publication or review changed");
    }
    return record;
  }
  bind(authority: ControllerAuthority, id: string, binding: TrackerBinding) {
    this.access.transaction(authority, () => {
      this.assertIOOwned(authority, id);
      const existing = this.binding(authority.runId);
      if (
        binding.repository.path !== this.run(authority.runId).repoPath ||
        (existing && digestJson(binding) !== digestJson(existing))
      )
        return fail("Tracker cannot rebind its repository or storage identity");
      this.db
        .prepare("UPDATE tracker_roots SET binding_json = ? WHERE run_id = ?")
        .run(JSON.stringify(TrackerBindingSchema.parse(binding)), authority.runId);
    });
  }
  recordSnapshot(
    authority: ControllerAuthority,
    id: string,
    graph: TrackerGraph,
    stage: "before" | "after",
  ) {
    return this.access.transaction(authority, () => {
      const record = this.assertIOOwned(authority, id);
      if (graph.epicId !== this.run(authority.runId).epicId)
        return fail("Tracker snapshot belongs to another epic");
      const safe = structuredClone(graph);
      for (const issue of safe.issues)
        for (const field of [
          "title",
          "description",
          "acceptanceCriteria",
          "instructions",
          "closeReason",
        ] as const) {
          if (issue[field] !== null && issue[field] !== undefined)
            issue[field] = redactSensitiveText(issue[field]!, field === "title" ? 1023 : 32767);
        }
      const snapshot = TrackerSnapshotSchema.parse({
        snapshotId: randomUUID(),
        runId: authority.runId,
        operationId: record.operationId,
        digest: digestJson(safe),
        graph: safe,
      });
      this.db
        .prepare("INSERT INTO tracker_snapshots VALUES (?, ?, ?, ?)")
        .run(snapshot.snapshotId, snapshot.runId, id, JSON.stringify(snapshot));
      if (stage === "before") {
        if (record.beforeSnapshotId || record.mutationDispatched)
          return fail("Tracker precondition snapshot is immutable");
        record.beforeSnapshotId = snapshot.snapshotId;
      } else record.afterSnapshotId = snapshot.snapshotId;
      this.save(record);
      this.changed(authority, "tracker.observed", snapshot.snapshotId);
      return snapshot;
    });
  }
  mutation(authority: ControllerAuthority, id: string) {
    this.access.transaction(authority, () => {
      const record = this.assertWritable(authority, id);
      if (
        record.kind === "refresh" ||
        record.mutationDispatched ||
        !record.beforeSnapshotId ||
        !record.taskId
      )
        return fail("Tracker mutation needs an unused gate and its exact precondition snapshot");
      const graph = this.snapshot(authority.runId, record.beforeSnapshotId).graph;
      if (record.kind === "close_task") {
        const claim = this.claimBinding(authority.runId, record.taskId, graph);
        if (digestJson(claim) !== digestJson(record.closure!.claim))
          return fail("Closure task claim changed");
        const task = graph.issues.find((issue) => issue.id === record.taskId)!;
        if (
          task.dependents.some((edge) => edge.type === "parent-child" && edge.status !== "closed")
        )
          return fail("Task closure cannot hide unfinished children");
      } else claimable(graph, record.taskId, record.kind);
      record.mutationDispatched = true;
      this.save(record);
      this.changed(
        authority,
        record.closure ? "tracker.close_dispatched" : "tracker.claim_dispatched",
        id,
      );
    });
  }
  stopIO(authority: ControllerAuthority, id: string, failure: string | null) {
    this.access.transaction(authority, () => {
      const record = this.assertIOOwned(authority, id);
      record.ioStopped = true;
      if (failure) record.failure = redactSensitiveText(failure, 3999);
      this.save(record);
      this.changed(authority, "tracker.io_stopped", id);
    });
  }
  beginInspection(authority: ControllerAuthority, id: string) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, id);
      if (record.outcome) return record;
      if (!record.ioStopped && record.dispatched)
        return fail("Independently prove earlier tracker I/O stopped before reconciliation");
      // An unused durable start gate proves no filesystem or child I/O began.
      record.dispatched = true;
      record.ioStopped = false;
      record.ioLeaseId = authority.leaseId;
      this.save(record);
      return record;
    });
  }
  closureReport(authority: ControllerAuthority, id: string, report: unknown) {
    this.access.transaction(authority, () => {
      const record = this.assertIOOwned(authority, id);
      if (!record.closure) return fail("Not a closure operation");
      record.closure.commandReport = redactSensitiveText(
        JSON.stringify(report) ?? "No structured report",
        3999,
      );
      this.save(record);
      this.changed(authority, "tracker.close_reported", id);
    });
  }
  closureRefs(authority: ControllerAuthority, id: string, verified: boolean, intervention = false) {
    this.access.transaction(authority, () => {
      const record = this.assertIOOwned(authority, id);
      if (!record.closure) return fail("Not a closure operation");
      record.closure.refsVerified = verified;
      record.closure.intervention ||= intervention;
      this.save(record);
    });
  }
  finish(authority: ControllerAuthority, id: string) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, id);
      if (record.outcome) return record;
      if (!record.ioStopped) return fail("Tracker outcome needs confirmed I/O stop");
      const after = record.afterSnapshotId
        ? this.snapshot(authority.runId, record.afterSnapshotId).graph
        : null;
      if (record.mutationDispatched && !after) return record; // External effect still needs inspection.
      if (
        record.mutationDispatched &&
        record.closure &&
        this.access.control(authority.runId).status !== "active"
      )
        return record; // Preserve the stopped effect until an active controller can inspect it.
      if (
        record.mutationDispatched &&
        record.closure &&
        !record.closure.refsVerified &&
        !record.closure.intervention
      )
        return record; // A lost ref-inspection result needs reconciliation, not a second close.
      if (record.kind === "refresh") record.outcome = after ? "observed" : "failed";
      else if (!record.mutationDispatched)
        record.outcome = record.closure ? "not_closed" : "not_claimed";
      else {
        const task = after!.issues.find((issue) => issue.id === record.taskId);
        const before = this.snapshot(authority.runId, record.beforeSnapshotId!).graph.issues.find(
          (issue) => issue.id === record.taskId,
        )!;
        const root = after!.issues.find((issue) => issue.id === after!.epicId)!;
        const unchangedWork = task?.workDigest === before.workDigest;
        if (record.closure) {
          let approved = false;
          try {
            const publication = this.access.closurePublication(
              record.runId,
              record.taskId!,
              record.closure.revision,
              record.closure.claim,
            );
            approved =
              publication.publicationId === record.closure.publicationId &&
              publication.reviewEvidenceId === record.closure.reviewEvidenceId &&
              record.policyDigest === this.access.control(record.runId).policyDigest;
          } catch (error) {
            if (!(error instanceof DeliveryError)) throw error;
          }
          record.outcome =
            task?.status === "closed" &&
            task.closedAt &&
            task.closedBySession === record.operationId &&
            task.closeReason === record.closure.reason &&
            task.assignee === before.assignee &&
            unchangedWork &&
            !["closed", "tombstone"].includes(root.status) &&
            approved &&
            record.closure.refsVerified &&
            !record.closure.intervention
              ? "closed"
              : task && digestJson(task) === digestJson(before)
                ? "not_closed"
                : "conflict";
        } else
          record.outcome =
            task?.status === "in_progress" &&
            task.assignee?.trim() === trackerActor(record.runId) &&
            unchangedWork &&
            !["closed", "tombstone"].includes(root.status)
              ? "claimed"
              : task && digestJson(task) === digestJson(before)
                ? "not_claimed"
                : "conflict";
      }
      record.finishedAt = at();
      this.save(record);
      this.changed(authority, `tracker.${record.outcome}`, id);
      return record;
    });
  }
  pending(runId: string) {
    return this.operations(runId).find((record) => !record.outcome) ?? null;
  }
  assertIdle(runId: string) {
    if (this.pending(runId)) return fail("Tracker I/O or outcome is unsettled");
  }
  operations(runId: string): TrackerOperation[] {
    return (
      this.db
        .prepare("SELECT record_json FROM tracker_operations WHERE run_id = ? ORDER BY rowid")
        .all(runId) as { record_json: string }[]
    ).map((row) => TrackerOperationSchema.parse(JSON.parse(row.record_json)));
  }
  record(runId: string, id: string) {
    const row = this.db
      .prepare(
        "SELECT record_json FROM tracker_operations WHERE run_id = ? AND tracker_operation_id = ?",
      )
      .get(runId, id) as { record_json: string } | undefined;
    if (!row) return fail("Tracker operation is missing or belongs to another run");
    return TrackerOperationSchema.parse(JSON.parse(row.record_json));
  }
  snapshot(runId: string, id?: string): TrackerSnapshot {
    const row = id
      ? this.db
          .prepare("SELECT record_json FROM tracker_snapshots WHERE run_id = ? AND snapshot_id = ?")
          .get(runId, id)
      : this.db
          .prepare(
            "SELECT record_json FROM tracker_snapshots WHERE run_id = ? ORDER BY rowid DESC LIMIT 1",
          )
          .get(runId);
    if (!row) return fail("Tracker snapshot is missing; refresh the epic graph");
    const record = TrackerSnapshotSchema.parse(
      JSON.parse((row as { record_json: string }).record_json),
    );
    if (record.digest !== digestJson(record.graph)) return fail("Tracker snapshot digest changed");
    return record;
  }
  summary(runId: string) {
    if (!this.configured(runId)) return { configured: false as const };
    const row = this.db
      .prepare(
        "SELECT snapshot_id FROM tracker_snapshots WHERE run_id = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(runId) as { snapshot_id: string } | undefined;
    const snapshot = row ? this.snapshot(runId, row.snapshot_id) : null;
    const pending = this.pending(runId);
    return {
      configured: true as const,
      snapshotId: snapshot?.snapshotId ?? null,
      capturedAt: snapshot?.graph.capturedAt ?? null,
      epicId: this.run(runId).epicId,
      epic:
        snapshot?.graph.issues.find((issue) => issue.id === snapshot.graph.epicId)?.title ?? null,
      issueCount: snapshot?.graph.issues.length ?? 0,
      readyIds: snapshot?.graph.readyIds.slice(0, 50) ?? [],
      omittedReadyIds: Math.max(0, (snapshot?.graph.readyIds.length ?? 0) - 50),
      pending: pending
        ? {
            trackerOperationId: pending.trackerOperationId,
            kind: pending.kind,
            ioStopped: pending.ioStopped,
          }
        : null,
      warning:
        "Graph is a captured observation, not an atomic permission grant; inspect details and refresh before choosing work",
    };
  }
  assertTaskOwned(runId: string, taskId: string | null): TaskClaimBinding | undefined {
    // Unconfigured compositions are component-test/legacy scaffolding, never adaptive admission.
    if (!this.configured(runId) || taskId === null) return;
    this.assertIdle(runId);
    return this.claimBinding(runId, taskId, this.snapshot(runId).graph);
  }
  private claimBinding(runId: string, taskId: string, graph: TrackerGraph): TaskClaimBinding {
    const task = graph.issues.find((issue) => issue.id === taskId);
    const epic = graph.issues.find((issue) => issue.id === graph.epicId)!;
    const claim = this.operations(runId).findLast(
      (record) => record.taskId === taskId && record.outcome === "claimed",
    );
    const claimedTask = claim?.afterSnapshotId
      ? this.snapshot(runId, claim.afterSnapshotId).graph.issues.find(
          (issue) => issue.id === taskId,
        )
      : null;
    if (
      !claimedTask ||
      task?.status !== "in_progress" ||
      task.assignee?.trim() !== trackerActor(runId) ||
      ["closed", "tombstone"].includes(epic.status) ||
      task.workDigest !== claimedTask.workDigest
    )
      return fail("Task lacks this run's recorded claim in the latest observed epic graph");
    return {
      trackerOperationId: claim!.trackerOperationId,
      snapshotId: claim!.afterSnapshotId!,
      workDigest: claimedTask.workDigest,
    };
  }
  private save(record: TrackerOperation) {
    this.db
      .prepare(
        "UPDATE tracker_operations SET record_json = ? WHERE run_id = ? AND tracker_operation_id = ?",
      )
      .run(
        JSON.stringify(TrackerOperationSchema.parse(record)),
        record.runId,
        record.trackerOperationId,
      );
  }
  private changed(authority: ControllerAuthority, kind: string, id: string) {
    this.db
      .prepare(
        "UPDATE orchestration_runs SET control_version = control_version + 1 WHERE run_id = ?",
      )
      .run(authority.runId);
    this.access.observe(authority, {
      source: "tracker-journal",
      sourceEventId: randomUUID(),
      kind,
      summary: `${kind}: ${id}`,
      artifactIds: [],
      identity: null,
      wakesOrchestrator: true,
    });
  }
}
