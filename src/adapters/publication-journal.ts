import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  DeliveryRepositorySchema,
  PublicationRecordSchema,
  PublicationRefIntentSchema,
  type DeliveryRepository,
  type PublicationRecord,
  type PublicationRepository,
  type PublicationPack,
  type PublicationRefObservation,
  concurrentWithPublication,
} from "../domain/publication.js";
import type { AgentJournal } from "./agent-journal.js";
import type { DeliveryJournal } from "./delivery-journal.js";
import type { ReviewJournal } from "./review-journal.js";
import type { CommitJournal } from "./commit-journal.js";
import { DeliveryError } from "./delivery-journal.js";
import type {
  ActionRecord,
  ControllerAuthority,
  ControlState,
  KernelAction,
  ObservationInput,
} from "../domain/orchestration.js";
import type { WorkspaceRecord } from "../domain/agents.js";
import { RunStateSchema } from "../domain/types.js";
import { digestJson } from "../domain/repository-policy.js";
import { redactSensitiveText } from "../util/redact.js";
import { WorkspaceOperationSchema } from "../domain/workspaces.js";

export const PUBLICATION_TABLES = ["delivery_repositories", "publications"] as const;
export function migratePublication(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS delivery_repositories (
    run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    CHECK(json_extract(record_json, '$.runId') = run_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS publications (
    publication_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES delivery_repositories(run_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL UNIQUE REFERENCES actions(operation_id),
    commit_id TEXT NOT NULL REFERENCES delivery_commits(commit_id),
    review_evidence_id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    FOREIGN KEY(run_id, review_evidence_id) REFERENCES review_evidence(run_id, evidence_id),
    CHECK(json_extract(record_json, '$.publicationId') = publication_id AND json_extract(record_json, '$.runId') = run_id AND
      json_extract(record_json, '$.operationId') = operation_id AND json_extract(record_json, '$.commitId') = commit_id AND
      json_extract(record_json, '$.reviewEvidenceId') = review_evidence_id)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS one_pending_publication ON publications(run_id)
    WHERE json_extract(record_json, '$.outcome') IS NULL;`);
}
type Access = {
  transaction<T>(authority: ControllerAuthority, body: () => T): T;
  control(runId: string): ControlState;
  action(runId: string, actionId: string): ActionRecord | null;
  observe(authority: ControllerAuthority, input: ObservationInput): unknown;
  agents: AgentJournal;
  delivery: DeliveryJournal;
  reviews: ReviewJournal;
  commits: CommitJournal;
  assertTrackerIdle(runId: string): void;
};
const fail = (code: string, message: string): never => {
  throw new DeliveryError(code, message);
};
const now = () => new Date().toISOString();

/** Durable authority and physical facts only; does not select the next delivery action. */
export class PublicationJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly access: Access,
  ) {}

  pending(runId: string) {
    return this.records(runId).find((record) => record.outcome === null) ?? null;
  }
  assertIdle(runId: string): void {
    if (this.pending(runId))
      fail(
        "publication_unsettled",
        "Publication I/O/evidence must settle before further mutations",
      );
  }
  assertActionAllowed(runId: string, kind: KernelAction["kind"]): void {
    if (!concurrentWithPublication(kind)) this.assertIdle(runId);
  }
  reserve(authority: ControllerAuthority, actionId: string): PublicationRecord {
    return this.access.transaction(authority, () => {
      this.assertIdle(authority.runId);
      const action = this.access.action(authority.runId, actionId);
      const control = this.access.control(authority.runId);
      if (
        !action ||
        action.status !== "running" ||
        action.request.action.kind !== "request_publish" ||
        control.status !== "active" ||
        action.policyDigest !== control.policyDigest
      )
        return fail("publication_action_stale", "Publication needs its current admitted action");
      const request = action.request.action;
      const commit = this.access.commits.exact(authority.runId, request, request.revision);
      if (this.access.commits.latestCreated(authority.runId)?.commitId !== commit.commitId)
        fail("publication_tip_stale", "Only the latest confirmed private commit can be published");
      const review = this.access.reviews.approval(authority.runId, request, "exact_revision");
      if (!review)
        return fail(
          "publication_not_verified",
          "Publication needs current independent exact-SHA approval and all required passing checks",
        );
      this.quiescent(authority.runId, action.operationId);
      if (this.records(authority.runId).some((record) => record.lock && !record.lock.released))
        fail(
          "publication_lock_unreleased",
          "An earlier publication still owns a repository lock; reconcile its cleanup first",
        );
      let repository = this.repository(authority.runId);
      if (!repository) {
        const run = this.run(authority.runId);
        repository = DeliveryRepositorySchema.parse({
          schemaVersion: 1,
          runId: authority.runId,
          baseRevision: run.epicBaseRevision,
          userRepository: null,
          creationOperationId: randomUUID(),
          workspace: null,
          canonicalRepository: null,
          privateRevision: null,
          publishedRevision: null,
          lastPublishedId: null,
        });
        this.db
          .prepare("INSERT INTO delivery_repositories VALUES (?, ?)")
          .run(authority.runId, JSON.stringify(repository));
      }
      if (
        request.expectedPreviousRevision !==
        (repository.publishedRevision ?? repository.baseRevision)
      )
        fail(
          "publication_base_stale",
          "Expected previous revision must match the recorded published tip or frozen initial baseline",
        );
      if (repository.publishedRevision === request.revision)
        fail(
          "publication_exists",
          "This revision already reached the delivery branch; inspect its recorded publication",
        );
      const operation = this.access.agents.beginWorkspaceOperation(
        authority,
        commit,
        "publication",
        control.controlVersion,
      );
      const record = PublicationRecordSchema.parse({
        schemaVersion: 1,
        publicationId: randomUUID(),
        runId: authority.runId,
        operationId: action.operationId,
        controllerLeaseId: authority.leaseId,
        commitId: commit.commitId,
        candidateId: commit.candidateId,
        candidateGeneration: commit.candidateGeneration,
        workspaceId: commit.workspaceId,
        workspaceGeneration: commit.workspaceGeneration,
        reviewEvidenceId: review,
        policyDigest: control.policyDigest,
        workspaceOperations: [operation.operationId],
        revision: request.revision,
        expectedPreviousRevision: request.expectedPreviousRevision,
        publicRef: null,
        canonicalRef: null,
        packs: [],
        lockNonce: randomUUID(),
        lock: null,
        dispatched: false,
        ioStopped: false,
        intervention: false,
        failure: null,
        outcome: null,
        canonicalApplied: false,
        publicApplied: false,
        createdAt: now(),
        finishedAt: null,
      });
      this.db
        .prepare("INSERT INTO publications VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          record.publicationId,
          record.runId,
          record.operationId,
          record.commitId,
          record.reviewEvidenceId,
          JSON.stringify(record),
        );
      this.changed(authority, "publication.reserved", record.publicationId);
      return record;
    });
  }

  start(authority: ControllerAuthority, publicationId: string) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      if (record.dispatched)
        fail(
          "publication_dispatched",
          "Publication dispatch is write-once; reconcile, never replay it",
        );
      record.dispatched = true;
      this.save(record);
      return this.assertWritable(authority, publicationId);
    });
  }
  assertWritable(authority: ControllerAuthority, publicationId: string): PublicationRecord {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      const control = this.access.control(authority.runId);
      const action = this.db
        .prepare("SELECT status FROM actions WHERE run_id = ? AND operation_id = ?")
        .get(authority.runId, record.operationId) as { status: string } | undefined;
      if (
        record.outcome ||
        !record.dispatched ||
        record.ioStopped ||
        record.controllerLeaseId !== authority.leaseId ||
        control.status !== "active" ||
        record.policyDigest !== control.policyDigest ||
        action?.status !== "running" ||
        this.access.commits.latestCreated(authority.runId)?.commitId !== record.commitId ||
        this.access.reviews.approval(authority.runId, record, "exact_revision") !==
          record.reviewEvidenceId
      )
        fail(
          "publication_stale",
          "Publication authority, current private tip or exact-SHA evidence changed",
        );
      this.access.commits.exact(authority.runId, record, record.revision);
      const source = this.access.agents.activeWorkspaceOperation(authority.runId, record);
      if (
        !source ||
        !record.workspaceOperations.includes(source.operationId) ||
        source.controllerLeaseId !== authority.leaseId
      )
        fail("publication_source_unowned", "Publication source I/O exclusion is no longer owned");
      return record;
    });
  }
  bindUser(authority: ControllerAuthority, publicationId: string, binding: PublicationRepository) {
    return this.access.transaction(authority, () => {
      const record = this.assertWritable(authority, publicationId);
      const repository = this.repository(authority.runId)!;
      if (
        binding.root.path !== this.run(authority.runId).repoPath ||
        (repository.userRepository && digestJson(repository.userRepository) !== digestJson(binding))
      )
        fail(
          "publication_repository_changed",
          "Publication cannot rebind the selected repository identity",
        );
      repository.userRepository = binding;
      record.publicRef = PublicationRefIntentSchema.parse({
        schemaVersion: 1,
        publicationId,
        runId: authority.runId,
        repository: binding,
        revision: record.revision,
        expectedRef: repository.publishedRevision,
      });
      this.saveRepository(repository);
      this.save(record);
      return record;
    });
  }
  bindCanonical(
    authority: ControllerAuthority,
    publicationId: string,
    workspace: WorkspaceRecord,
    binding: PublicationRepository,
  ) {
    return this.access.transaction(authority, () => {
      const record = this.assertWritable(authority, publicationId);
      const repository = this.repository(authority.runId)!;
      const registered = this.access.agents.workspace(authority.runId, workspace);
      if (
        registered.purpose !== "delivery" ||
        registered.sourceMode !== "immutable" ||
        registered.status !== "ready" ||
        registered.creationOperationId !== repository.creationOperationId ||
        registered.baselineRevision !== repository.baseRevision ||
        registered.path !== binding.root.path ||
        (repository.canonicalRepository &&
          digestJson(repository.canonicalRepository) !== digestJson(binding))
      )
        fail("publication_custody_changed", "Canonical delivery workspace identity changed");
      const operation = this.access.agents.beginWorkspaceOperation(
        authority,
        workspace,
        "publication",
        this.access.control(authority.runId).controlVersion,
      );
      repository.workspace = {
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
      };
      repository.canonicalRepository = binding;
      record.workspaceOperations.push(operation.operationId);
      record.canonicalRef = PublicationRefIntentSchema.parse({
        schemaVersion: 1,
        publicationId,
        runId: authority.runId,
        repository: binding,
        revision: record.revision,
        expectedRef: repository.privateRevision,
      });
      this.saveRepository(repository);
      this.save(record);
      return record;
    });
  }
  recordPack(
    authority: ControllerAuthority,
    publicationId: string,
    destination: "canonical" | "user",
    pack: PublicationPack,
    retained = false,
  ) {
    return this.access.transaction(authority, () => {
      const record = this.assertWritable(authority, publicationId);
      const existing = record.packs.find((item) => item.destination === destination);
      if (existing)
        fail("publication_pack_dispatched", "An import intent already exists for this destination");
      record.packs.push({ destination, record: pack, retained });
      this.save(record);
    });
  }
  markPackRetained(
    authority: ControllerAuthority,
    publicationId: string,
    destination: "canonical" | "user",
  ) {
    this.access.transaction(authority, () => {
      const record = this.assertWritable(authority, publicationId);
      const pack = record.packs.find((item) => item.destination === destination);
      if (!pack) fail("publication_pack_missing", "No import intent exists");
      pack!.retained = true;
      this.save(record);
    });
  }
  recordLock(authority: ControllerAuthority, publicationId: string, revision: string) {
    this.access.transaction(authority, () => {
      const record = this.assertWritable(authority, publicationId);
      if (record.lock) fail("publication_lock_exists", "Repository lock creation is write-once");
      record.lock = {
        revision,
        acquired: false,
        releaseRequested: false,
        released: false,
        releaseDisposition: null,
      };
      this.save(record);
    });
  }
  markLockAcquired(authority: ControllerAuthority, publicationId: string) {
    this.access.transaction(authority, () => {
      const record = this.assertWritable(authority, publicationId);
      if (!record.lock) fail("publication_lock_missing", "Lock acquisition intent is missing");
      record.lock!.acquired = true;
      this.save(record);
    });
  }
  /** Only after all original adapter I/O is awaited; old leases cannot assert their own stop. */
  stopIO(
    authority: ControllerAuthority,
    publicationId: string,
    failure: string | null,
    intervention: boolean,
  ) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      if (record.outcome) return record;
      for (const id of record.workspaceOperations) {
        const operation = this.access.agents.workspaceOperation(authority.runId, id);
        if (!operation.stopEvidence)
          this.access.agents.finishWorkspaceOperation(
            authority,
            id,
            failure ? "failed" : "succeeded",
            "Publication adapter awaited all filesystem operations and nested Git process closures",
          );
      }
      record.ioStopped = true;
      if (failure) record.failure = redactSensitiveText(failure, 3999);
      record.intervention ||= intervention;
      this.save(record);
      this.changed(authority, "publication.io_stopped", publicationId);
      return record;
    });
  }
  /** Read/cleanup reconciliation gets its own durable exclusion; it never redispatches publication. */
  cancelUndispatched(authority: ControllerAuthority, publicationId: string) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      if (
        record.dispatched ||
        record.outcome ||
        record.publicRef ||
        record.canonicalRef ||
        record.lock ||
        record.packs.length
      )
        fail(
          "publication_may_be_dispatched",
          "Only the unused durable publication gate proves no original I/O started",
        );
      for (const id of record.workspaceOperations) {
        const operation = this.access.agents.workspaceOperation(authority.runId, id);
        if (operation.stopEvidence) continue;
        if (
          operation.kind !== "publication" ||
          operation.workspaceId !== record.workspaceId ||
          operation.workspaceGeneration !== record.workspaceGeneration
        )
          fail(
            "publication_io_unsettled",
            "An unrelated I/O operation cannot use publication's never-started proof",
          );
        const stopped = WorkspaceOperationSchema.parse({
          ...operation,
          status: "failed",
          stopEvidence:
            "Kernel proved publication never started from its durable one-use dispatch gate",
          updatedAt: now(),
        });
        this.db
          .prepare(
            "UPDATE workspace_operations SET record_json = ? WHERE run_id = ? AND operation_id = ?",
          )
          .run(JSON.stringify(stopped), authority.runId, id);
      }
      record.ioStopped = true;
      record.failure = "Publication was never dispatched";
      this.save(record);
      this.changed(authority, "publication.never_dispatched", publicationId);
      return record;
    });
  }

  /** Read/cleanup reconciliation gets its own durable exclusion; it never redispatches publication. */
  beginInspection(authority: ControllerAuthority, publicationId: string) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      if (record.outcome)
        fail("publication_finished", "Publication already has a terminal observation");
      this.assertStopped(record);
      if (record.workspaceOperations.length > 60)
        fail(
          "publication_recovery_budget",
          "Publication inspection budget exhausted; request operator judgment",
        );
      const identities = [
        record,
        ...(this.repository(authority.runId)?.workspace
          ? [this.repository(authority.runId)!.workspace!]
          : []),
      ];
      for (const identity of identities) {
        const operation = this.access.agents.beginWorkspaceOperation(
          authority,
          identity,
          "inspect_materialization",
          this.access.control(authority.runId).controlVersion,
        );
        record.workspaceOperations.push(operation.operationId);
      }
      record.ioStopped = false;
      this.save(record);
      return record;
    });
  }
  requestLockRelease(authority: ControllerAuthority, publicationId: string) {
    this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      if (record.ioStopped || record.outcome || !record.lock)
        fail("publication_cleanup_unowned", "Lock release needs an active owned inspection");
      this.assertInspectionOwned(authority, record);
      record.lock!.releaseRequested = true;
      this.save(record);
    });
  }
  markLockReleased(
    authority: ControllerAuthority,
    publicationId: string,
    disposition: "removed" | "absent" | "other_owner",
    unexpected: boolean,
  ) {
    this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      this.assertInspectionOwned(authority, record);
      if (!record.lock?.releaseRequested)
        fail("publication_cleanup_unplanned", "Lock cleanup intent is missing");
      record.lock!.released = true;
      record.lock!.releaseDisposition = disposition;
      if (disposition === "removed") record.lock!.acquired = true;
      if (unexpected) {
        record.intervention = true;
        record.failure ??= "Publication lock ownership changed outside the recorded release";
      }
      this.save(record);
    });
  }
  finish(
    authority: ControllerAuthority,
    publicationId: string,
    canonical: PublicationRefObservation | null,
    user: PublicationRefObservation | null,
  ) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      if (record.outcome) return record;
      this.assertStopped(record);
      const repository = this.repository(authority.runId)!;
      record.canonicalApplied = canonical?.outcome === "applied";
      record.publicApplied = user?.outcome === "applied";
      if (record.canonicalApplied) repository.privateRevision = record.revision;
      if (record.publicApplied) {
        repository.publishedRevision = record.revision;
        repository.lastPublishedId = publicationId;
      }
      record.outcome =
        record.publicApplied && record.canonicalApplied && !record.intervention
          ? "published"
          : !record.publicApplied &&
              (user?.outcome === "not_applied" || !record.publicRef) &&
              !record.intervention
            ? "not_published"
            : "conflict";
      record.finishedAt = now();
      this.saveRepository(repository);
      this.save(record);
      this.changed(authority, `publication.${record.outcome}`, publicationId);
      return record;
    });
  }
  assertInspectionOwned(authority: ControllerAuthority, record: PublicationRecord) {
    const operation = this.access.agents.activeWorkspaceOperation(authority.runId, record);
    if (
      !operation ||
      !record.workspaceOperations.includes(operation.operationId) ||
      operation.controllerLeaseId !== authority.leaseId
    )
      fail(
        "publication_inspection_unowned",
        "Publication inspection I/O is not owned by this controller",
      );
  }
  private assertStopped(record: PublicationRecord) {
    if (
      !record.ioStopped ||
      record.workspaceOperations.some(
        (id) => !this.access.agents.workspaceOperation(record.runId, id).stopEvidence,
      )
    )
      fail(
        "publication_io_unsettled",
        "Independently prove all earlier publication I/O stopped before inspecting or releasing ownership",
      );
  }
  private quiescent(runId: string, operationId: string) {
    this.access.assertTrackerIdle(runId);
    const actions = this.db
      .prepare(
        "SELECT operation_id, request_json FROM actions WHERE run_id = ? AND status IN ('accepted', 'running', 'indeterminate')",
      )
      .all(runId) as { operation_id: string; request_json: string }[];
    if (
      actions.some(
        (row) =>
          row.operation_id !== operationId &&
          !concurrentWithPublication(JSON.parse(row.request_json).action.kind),
      ) ||
      this.access.agents
        .turns(runId)
        .some((turn) => !turn.stopEvidence && turn.prompt.assignment.purpose !== "coordination") ||
      this.db
        .prepare(
          "SELECT 1 FROM workspace_operations WHERE run_id = ? AND json_extract(record_json, '$.stopEvidence') IS NULL",
        )
        .get(runId)
    )
      fail(
        "publication_busy",
        "Settle worker turns, workspace I/O and mutating actions before publishing",
      );
  }
  repository(runId: string): DeliveryRepository | null {
    const row = this.db
      .prepare("SELECT record_json FROM delivery_repositories WHERE run_id = ?")
      .get(runId) as { record_json: string } | undefined;
    return row ? DeliveryRepositorySchema.parse(JSON.parse(row.record_json)) : null;
  }
  record(runId: string, publicationId: string): PublicationRecord {
    const row = this.db
      .prepare("SELECT record_json FROM publications WHERE run_id = ? AND publication_id = ?")
      .get(runId, publicationId) as { record_json: string } | undefined;
    if (!row)
      return fail("unknown_publication", "Publication is missing or belongs to another run");
    return PublicationRecordSchema.parse(JSON.parse(row.record_json));
  }
  records(runId: string) {
    return (
      this.db
        .prepare("SELECT record_json FROM publications WHERE run_id = ? ORDER BY rowid")
        .all(runId) as { record_json: string }[]
    ).map((row) => PublicationRecordSchema.parse(JSON.parse(row.record_json)));
  }
  summaries(runId: string) {
    return this.records(runId)
      .slice(-10)
      .map((record) => ({
        publicationId: record.publicationId,
        revision: record.revision,
        outcome: record.outcome,
        ioStopped: record.ioStopped,
        publicApplied: record.publicApplied,
        intervention: record.intervention,
        retainedPacks: record.packs.length,
        lockReleased: record.lock?.released ?? null,
        currentApproval: this.approval(runId, record.publicationId),
      }));
  }
  /** Derived journal eligibility, not a fresh external ref/Beads ownership check. */
  approval(runId: string, publicationId: string): string | null {
    const record = this.record(runId, publicationId);
    if (
      record.outcome !== "published" ||
      record.intervention ||
      !record.canonicalApplied ||
      !record.publicApplied ||
      record.policyDigest !== this.access.control(runId).policyDigest ||
      this.repository(runId)?.publishedRevision !== record.revision
    )
      return null;
    return this.access.reviews.approval(runId, record, "exact_revision");
  }
  run(runId: string) {
    const row = this.db.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(runId) as
      { state_json: string } | undefined;
    if (!row) return fail("unknown_run", "Run baseline is missing");
    return RunStateSchema.parse(JSON.parse(row.state_json));
  }
  private save(record: PublicationRecord) {
    this.db
      .prepare("UPDATE publications SET record_json = ? WHERE run_id = ? AND publication_id = ?")
      .run(
        JSON.stringify(PublicationRecordSchema.parse(record)),
        record.runId,
        record.publicationId,
      );
  }
  private saveRepository(record: DeliveryRepository) {
    this.db
      .prepare("UPDATE delivery_repositories SET record_json = ? WHERE run_id = ?")
      .run(JSON.stringify(DeliveryRepositorySchema.parse(record)), record.runId);
  }
  private changed(authority: ControllerAuthority, kind: string, publicationId: string) {
    this.db
      .prepare(
        "UPDATE orchestration_runs SET control_version = control_version + 1 WHERE run_id = ?",
      )
      .run(authority.runId);
    this.access.observe(authority, {
      source: "publication-journal",
      sourceEventId: randomUUID(),
      kind,
      summary: publicationId,
      artifactIds: [],
      identity: null,
      wakesOrchestrator: true,
    });
  }
}
