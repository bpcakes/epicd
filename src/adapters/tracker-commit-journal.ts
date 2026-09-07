import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ControllerAuthority } from "../domain/orchestration.js";
import { TrackerCommitRecordSchema, type TrackerCommitRecord } from "../domain/tracker-commits.js";
import { digestJson } from "../domain/repository-policy.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { DeliveryError } from "./delivery-journal.js";
import { redactSensitiveText } from "../util/redact.js";
import { WorkspaceOperationSchema } from "../domain/workspaces.js";
import type { WorkspaceSnapshot } from "../domain/workspaces.js";

export const TRACKER_COMMIT_TABLES = ["tracker_commits"] as const;
export function createTrackerCommitSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS tracker_commits (
    tracker_commit_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL UNIQUE REFERENCES actions(operation_id),
    export_operation_id TEXT NOT NULL REFERENCES tracker_exports(tracker_operation_id),
    parent_publication_id TEXT NOT NULL REFERENCES publications(publication_id),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    CHECK(json_extract(record_json, '$.trackerCommitId') = tracker_commit_id AND
      json_extract(record_json, '$.runId') = run_id AND json_extract(record_json, '$.operationId') = operation_id AND
      json_extract(record_json, '$.exportOperationId') = export_operation_id AND
      json_extract(record_json, '$.parentPublicationId') = parent_publication_id)
  ) STRICT;`);
}
const fail = (message: string): never => {
  throw new DeliveryError("tracker_commit", message);
};

export class TrackerCommitJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly journal: OrchestrationJournal,
    private readonly transaction: <T>(authority: ControllerAuthority, body: () => T) => T,
  ) {}

  records(runId: string): TrackerCommitRecord[] {
    return (
      this.db
        .prepare("SELECT record_json FROM tracker_commits WHERE run_id = ? ORDER BY rowid")
        .all(runId) as { record_json: string }[]
    ).map((row) => TrackerCommitRecordSchema.parse(JSON.parse(row.record_json)));
  }
  record(runId: string, id: string): TrackerCommitRecord {
    return (
      this.records(runId).find((record) => record.trackerCommitId === id) ??
      fail("Tracker commit is missing or belongs to another run")
    );
  }
  pending(runId: string) {
    const published = new Set(
      this.journal.publications
        .records(runId)
        .filter((entry) => entry.outcome === "published" && entry.provenance.kind === "tracker")
        .map((entry) =>
          entry.provenance.kind === "tracker" ? entry.provenance.trackerCommitId : null,
        ),
    );
    return (
      this.records(runId).find(
        (entry) => entry.status !== "failed" && !published.has(entry.trackerCommitId),
      ) ?? null
    );
  }
  assertIdle(runId: string) {
    if (this.pending(runId))
      fail("Settle and publish the pending tracker commit before other delivery mutations");
  }
  reserve(authority: ControllerAuthority, actionId: string) {
    return this.transaction(authority, () => {
      this.assertIdle(authority.runId);
      this.journal.publications.assertIdle(authority.runId);
      this.journal.tracker.assertIdle(authority.runId);
      const action = this.journal.action(authority.runId, actionId),
        control = this.journal.control(authority.runId);
      if (
        !action ||
        action.status !== "running" ||
        action.request.action.kind !== "request_tracker_commit" ||
        control.status !== "active" ||
        action.policyDigest !== control.policyDigest
      )
        return fail("Tracker commit needs its current admitted action");
      const request = action.request.action,
        repository = this.journal.publications.repository(authority.runId);
      if (
        !repository?.workspace ||
        !repository.lastPublishedId ||
        repository.lastPublishedId !== request.publicationId ||
        repository.privateRevision !== repository.publishedRevision
      )
        return fail("Tracker commit must extend the exact current settled publication");
      const parent = this.journal.publications.record(authority.runId, request.publicationId);
      const application = this.journal.commits.record(authority.runId, parent.commitId);
      if (
        parent.outcome !== "published" ||
        !parent.ioStopped ||
        parent.intervention ||
        parent.revision !== repository.privateRevision ||
        application.status !== "created" ||
        !application.sourceIntact ||
        this.journal.commits.latestCreated(authority.runId)?.commitId !== application.commitId ||
        this.journal.commits
          .records(authority.runId)
          .some((entry) => ["preparing", "writing"].includes(entry.status))
      )
        return fail("Tracker parent lacks settled reviewed application ancestry");
      const exported = this.journal.tracker.record(authority.runId, request.trackerOperationId);
      if (exported.outcome !== "exported" || !exported.ioStopped || !exported.export?.metadata)
        return fail("Tracker commit requires a successful retained export");
      if (
        exported.export.metadata.scopeDigest !==
        this.journal.tracker.snapshot(authority.runId).rawScopeDigest
      )
        return fail("A later tracker observation supersedes this export; request a fresh export");
      this.journal.tracker.exportBytes(authority.runId, exported.trackerOperationId);
      const activeWorkers = this.journal.agents
        .turns(authority.runId)
        .some((turn) => !turn.stopEvidence && turn.prompt.assignment.purpose !== "coordination");
      if (activeWorkers)
        return fail("Stop active workers before constructing a tracker-only descendant");
      const operation = this.journal.agents.beginWorkspaceOperation(
        authority,
        repository.workspace,
        "commit",
        control.controlVersion,
      );
      const record = TrackerCommitRecordSchema.parse({
        schemaVersion: 1,
        trackerCommitId: randomUUID(),
        runId: authority.runId,
        operationId: action.operationId,
        controllerLeaseId: authority.leaseId,
        workspaceOperationId: operation.operationId,
        ...repository.workspace,
        policyDigest: control.policyDigest,
        dispatched: false,
        exportOperationId: exported.trackerOperationId,
        exportMetadata: exported.export.metadata,
        parentPublicationId: parent.publicationId,
        parentRevision: parent.revision,
        applicationCommitId: application.commitId,
        applicationRevision: application.revision!,
        applicationTree: application.applicationTree,
        fullTree: null,
        snapshot: null,
        objectContent: null,
        revision: null,
        status: "preparing",
        sourceIntact: false,
        failure: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      });
      this.db
        .prepare("INSERT INTO tracker_commits VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          record.trackerCommitId,
          record.runId,
          record.operationId,
          record.exportOperationId,
          record.parentPublicationId,
          JSON.stringify(record),
        );
      this.changed(authority, "tracker_commit.reserved", record.trackerCommitId);
      return record;
    });
  }
  assertParent(record: TrackerCommitRecord) {
    const repository = this.journal.publications.repository(record.runId);
    if (
      !repository ||
      repository.lastPublishedId !== record.parentPublicationId ||
      repository.privateRevision !== record.parentRevision ||
      repository.publishedRevision !== record.parentRevision ||
      this.journal.commits.latestCreated(record.runId)?.commitId !== record.applicationCommitId ||
      record.policyDigest !== this.journal.control(record.runId).policyDigest
    )
      return fail("Tracker commit parent, application tip or policy changed");
    const exported = this.journal.tracker.record(record.runId, record.exportOperationId);
    if (
      exported.outcome !== "exported" ||
      digestJson(exported.export?.metadata) !== digestJson(record.exportMetadata)
    )
      return fail("Tracker export binding changed");
    this.journal.tracker.exportBytes(record.runId, record.exportOperationId);
  }
  assertWritable(authority: ControllerAuthority, id: string) {
    this.journal.assertAuthority(authority);
    const record = this.record(authority.runId, id),
      control = this.journal.control(authority.runId);
    const operation = this.journal.agents.activeWorkspaceOperation(authority.runId, record);
    const action = this.journal
      .actions(authority.runId)
      .find((entry) => entry.operationId === record.operationId);
    if (
      control.status !== "active" ||
      record.controllerLeaseId !== authority.leaseId ||
      !["preparing", "writing"].includes(record.status) ||
      action?.status !== "running" ||
      operation?.operationId !== record.workspaceOperationId ||
      operation.controllerLeaseId !== authority.leaseId
    )
      return fail("Tracker commit authority or source exclusion changed");
    this.assertParent(record);
    return record;
  }
  start(authority: ControllerAuthority, id: string) {
    return this.transaction(authority, () => {
      const record = this.assertWritable(authority, id);
      if (record.dispatched) return fail("Tracker commit dispatch is one-use; reconcile instead");
      record.dispatched = true;
      this.save(record);
      return record;
    });
  }
  cancelUndispatched(authority: ControllerAuthority, id: string) {
    return this.transaction(authority, () => {
      const record = this.record(authority.runId, id);
      if (record.dispatched || record.status !== "preparing")
        return fail("Only an unused tracker commit gate proves no I/O began");
      const operation = this.journal.agents.workspaceOperation(
        authority.runId,
        record.workspaceOperationId,
      );
      if (
        operation.kind !== "commit" ||
        operation.workspaceId !== record.workspaceId ||
        operation.workspaceGeneration !== record.workspaceGeneration
      )
        return fail("Tracker commit exclusion does not match its unused gate");
      const stopped = WorkspaceOperationSchema.parse({
        ...operation,
        status: "failed",
        stopEvidence: "Kernel proved tracker commit never dispatched from its durable start gate",
        updatedAt: new Date().toISOString(),
      });
      this.db
        .prepare("UPDATE workspace_operations SET record_json=? WHERE run_id=? AND operation_id=?")
        .run(JSON.stringify(stopped), authority.runId, operation.operationId);
      return this.finish(authority, id, false, false, "Tracker commit was never dispatched");
    });
  }
  prepareWrite(
    authority: ControllerAuthority,
    id: string,
    snapshot: WorkspaceSnapshot,
    objectContent: string,
  ) {
    return this.transaction(authority, () => {
      const record = this.assertWritable(authority, id);
      if (!record.dispatched || record.status !== "preparing")
        return fail("Tracker commit write requires its one-use dispatch");
      record.fullTree = snapshot.fullTree;
      record.snapshot = snapshot;
      record.objectContent = objectContent;
      record.revision = snapshot.snapshotRevision;
      record.status = "writing";
      this.save(record);
      this.changed(authority, "tracker_commit.writing", id);
      return record;
    });
  }
  finish(
    authority: ControllerAuthority,
    id: string,
    created: boolean,
    sourceIntact: boolean,
    failure: string | null,
  ) {
    return this.transaction(authority, () => {
      const record = this.record(authority.runId, id);
      if (["created", "failed"].includes(record.status)) return record;
      if (
        !this.journal.agents.workspaceOperation(authority.runId, record.workspaceOperationId)
          .stopEvidence
      )
        return fail("Tracker commit outcome requires independently confirmed I/O stop");
      record.status = created ? "created" : "failed";
      record.sourceIntact = sourceIntact;
      record.failure = failure ? redactSensitiveText(failure, 3999) : null;
      record.finishedAt = new Date().toISOString();
      this.save(record);
      this.changed(authority, `tracker_commit.${record.status}`, id);
      return record;
    });
  }
  summaries(runId: string) {
    return this.records(runId)
      .slice(-10)
      .map((record) => ({
        trackerCommitId: record.trackerCommitId,
        exportOperationId: record.exportOperationId,
        revision: record.revision,
        applicationRevision: record.applicationRevision,
        parentRevision: record.parentRevision,
        status: record.status,
        sourceIntact: record.sourceIntact,
        warning:
          "Kernel tracker-only object; not an independent review of this SHA or a published branch",
      }));
  }
  private save(record: TrackerCommitRecord) {
    this.db
      .prepare("UPDATE tracker_commits SET record_json=? WHERE tracker_commit_id=? AND run_id=?")
      .run(
        JSON.stringify(TrackerCommitRecordSchema.parse(record)),
        record.trackerCommitId,
        record.runId,
      );
  }
  private changed(authority: ControllerAuthority, kind: string, id: string) {
    this.db
      .prepare("UPDATE orchestration_runs SET control_version=control_version+1 WHERE run_id=?")
      .run(authority.runId);
    this.journal.appendObservation(authority, {
      source: "tracker-commit-journal",
      sourceEventId: randomUUID(),
      kind,
      summary: `${kind}: ${id}`,
      artifactIds: [],
      identity: null,
      wakesOrchestrator: true,
    });
  }
}
