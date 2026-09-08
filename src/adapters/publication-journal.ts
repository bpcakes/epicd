import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import {
  DeliveryRepositorySchema,
  PublicationRecordSchema,
  PublicationRefIntentSchema,
  type DeliveryRepository,
  type PublicationRecord,
  type PublicationRepository,
  type PublicationPack,
  concurrentWithPublication,
  PublicationIOAttemptSchema,
  PublicationIOResultSchema,
  type PublicationIOAttempt,
  type PublicationIOResult,
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
import {
  CommandLifetimeSchema,
  CommandStopSchema,
  assertCommandStop,
  type CommandLifetime,
  type CommandStop,
} from "../domain/command-lifetime.js";
import type { TrackerCommitRecord } from "../domain/tracker-commits.js";

export const PUBLICATION_TABLES = ["delivery_repositories", "publications"] as const;
export function createPublicationSchema(db: Database.Database) {
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
  assertTrackerCommitIdle(runId: string): void;
  trackerCommit(runId: string, id: string): TrackerCommitRecord;
  assertTrackerCommitParent(record: TrackerCommitRecord): void;
  workspaceCreationFailed(runId: string, workspace: WorkspaceRecord): boolean;
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
  reserve(
    authority: ControllerAuthority,
    actionId: string,
    workspaceRoot: string,
  ): PublicationRecord {
    return this.access.transaction(authority, () => {
      this.assertIdle(authority.runId);
      const configuredRoot = this.run(authority.runId).runtimeConfiguration?.workspaceRoot;
      if (configuredRoot && configuredRoot !== resolve(workspaceRoot))
        fail(
          "publication_root_changed",
          "Publication storage differs from the frozen run configuration",
        );
      const action = this.access.action(authority.runId, actionId);
      const control = this.access.control(authority.runId);
      if (
        !action ||
        action.status !== "running" ||
        !["request_publish", "request_publish_tracker"].includes(action.request.action.kind) ||
        control.status !== "active" ||
        action.policyDigest !== control.policyDigest
      )
        return fail("publication_action_stale", "Publication needs its current admitted action");
      const request = action.request.action;
      if (request.kind !== "request_publish" && request.kind !== "request_publish_tracker")
        return fail("publication_action", "Wrong publication action");
      if (request.kind === "request_publish") this.access.assertTrackerCommitIdle(authority.runId);
      const tracker =
        request.kind === "request_publish_tracker"
          ? this.access.trackerCommit(authority.runId, request.trackerCommitId)
          : null;
      if (tracker) {
        this.access.assertTrackerCommitParent(tracker);
        if (tracker.status !== "created" || !tracker.sourceIntact || !tracker.revision)
          return fail(
            "tracker_commit_unconfirmed",
            "Publish only a physically confirmed tracker object",
          );
      }
      const commit =
        request.kind === "request_publish"
          ? this.access.commits.exact(authority.runId, request, request.revision)
          : this.access.commits.record(authority.runId, tracker!.applicationCommitId);
      if (this.access.commits.latestCreated(authority.runId)?.commitId !== commit.commitId)
        fail("publication_tip_stale", "Only the latest confirmed private commit can be published");
      const review = tracker
        ? this.record(authority.runId, tracker.parentPublicationId).reviewEvidenceId
        : this.access.reviews.approval(authority.runId, commit, "exact_revision");
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
        !repository.workspace &&
        !repository.canonicalRepository &&
        !repository.privateRevision &&
        !repository.publishedRevision &&
        !repository.lastPublishedId
      ) {
        const abandoned = this.access.agents.workspaceForOperation(
          authority.runId,
          repository.creationOperationId,
        );
        if (abandoned && this.access.workspaceCreationFailed(authority.runId, abandoned)) {
          // A new model-requested publication may allocate new custody. Never rewrite the failed copy.
          repository.creationOperationId = randomUUID();
          this.saveRepository(repository);
        }
      }
      if (
        request.expectedPreviousRevision !==
        (repository.publishedRevision ?? repository.baseRevision)
      )
        fail(
          "publication_base_stale",
          "Expected previous revision must match the recorded published tip or frozen initial baseline",
        );
      const revision = request.kind === "request_publish" ? request.revision : tracker!.revision!;
      if (repository.publishedRevision === revision)
        fail(
          "publication_exists",
          "This revision already reached the delivery branch; inspect its recorded publication",
        );
      const operation = this.access.agents.beginWorkspaceOperation(
        authority,
        tracker ?? commit,
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
        provenance: tracker
          ? {
              kind: "tracker",
              trackerCommitId: tracker.trackerCommitId,
              reviewedRevision: tracker.applicationRevision,
            }
          : { kind: "application" },
        candidateId: commit.candidateId,
        candidateGeneration: commit.candidateGeneration,
        workspaceId: (tracker ?? commit).workspaceId,
        workspaceGeneration: (tracker ?? commit).workspaceGeneration,
        reviewEvidenceId: review,
        policyDigest: control.policyDigest,
        workspaceOperations: [operation.operationId],
        workspaceRoot: resolve(workspaceRoot),
        ioAttempts: [this.newAttempt(authority, "publish", [operation.operationId])],
        revision,
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
      const attempt = record.ioAttempts[0]!;
      if (
        record.dispatched ||
        attempt.settledAt ||
        attempt.stop ||
        attempt.result ||
        !attempt.execution
      )
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
      const attempt = record.ioAttempts[0]!;
      const control = this.access.control(authority.runId);
      const action = this.db
        .prepare("SELECT status FROM actions WHERE run_id = ? AND operation_id = ?")
        .get(authority.runId, record.operationId) as { status: string } | undefined;
      if (
        record.outcome ||
        record.ioAttempts.length !== 1 ||
        !attempt.execution ||
        attempt.result ||
        attempt.stop ||
        attempt.settledAt ||
        !record.dispatched ||
        record.ioStopped ||
        record.controllerLeaseId !== authority.leaseId ||
        control.status !== "active" ||
        record.policyDigest !== control.policyDigest ||
        action?.status !== "running" ||
        this.access.commits.latestCreated(authority.runId)?.commitId !== record.commitId ||
        (record.provenance.kind === "application" &&
          this.access.reviews.approval(authority.runId, record, "exact_revision") !==
            record.reviewEvidenceId)
      )
        fail(
          "publication_stale",
          "Publication authority, current private tip or exact-SHA evidence changed",
        );
      if (record.provenance.kind === "application")
        this.access.commits.exact(authority.runId, record, record.revision);
      else
        this.access.assertTrackerCommitParent(
          this.access.trackerCommit(authority.runId, record.provenance.trackerCommitId),
        );
      this.objectRecord(authority.runId, record);
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
      const sameSource =
        workspace.workspaceId === record.workspaceId &&
        workspace.workspaceGeneration === record.workspaceGeneration;
      const operation = this.access.agents.activeWorkspaceOperation(authority.runId, workspace);
      if (
        !operation ||
        !record.ioAttempts[0]!.workspaceOperations.includes(operation.operationId) ||
        operation.controllerLeaseId !== authority.leaseId ||
        (!sameSource && operation.kind !== "publication")
      )
        fail(
          "publication_custody_unowned",
          "Canonical custody needs the original publication exclusion",
        );
      repository.workspace = {
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
      };
      repository.canonicalRepository = binding;
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
  private newAttempt(
    authority: ControllerAuthority,
    phase: PublicationIOAttempt["phase"],
    operations: string[],
  ) {
    return PublicationIOAttemptSchema.parse({
      attemptId: randomUUID(),
      phase,
      controllerLeaseId: authority.leaseId,
      workspaceOperations: operations,
      execution: null,
      stop: null,
      result: null,
      settledAt: null,
    });
  }

  /** Reserve canonical custody before launch; all physical inspection remains inside the worker. */
  attachCanonicalWorkspace(
    authority: ControllerAuthority,
    publicationId: string,
    workspace: WorkspaceRecord,
  ) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId),
        attempt = record.ioAttempts[0]!;
      const repository = this.repository(authority.runId)!;
      const registered = this.access.agents.workspace(authority.runId, workspace);
      if (
        record.ioAttempts.length !== 1 ||
        attempt.execution ||
        attempt.settledAt ||
        record.dispatched ||
        record.controllerLeaseId !== authority.leaseId ||
        registered.status !== "ready" ||
        registered.purpose !== "delivery" ||
        registered.sourceMode !== "immutable" ||
        registered.creationOperationId !== repository.creationOperationId ||
        registered.baselineRevision !== repository.baseRevision ||
        (repository.workspace &&
          digestJson(repository.workspace) !==
            digestJson({
              workspaceId: workspace.workspaceId,
              workspaceGeneration: workspace.workspaceGeneration,
            }))
      )
        fail(
          "publication_custody_unowned",
          "Canonical custody differs from the unused publication intent",
        );
      const sameSource =
        workspace.workspaceId === record.workspaceId &&
        workspace.workspaceGeneration === record.workspaceGeneration;
      if (!sameSource) {
        if (attempt.workspaceOperations.length !== 1)
          fail("publication_custody_bound", "Canonical publication exclusion is write-once");
        const operation = this.access.agents.beginWorkspaceOperation(
          authority,
          workspace,
          "publication",
          this.access.control(authority.runId).controlVersion,
        );
        attempt.workspaceOperations.push(operation.operationId);
        record.workspaceOperations.push(operation.operationId);
      }
      repository.workspace = {
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
      };
      this.saveRepository(repository);
      this.save(record);
      return record;
    });
  }

  private members(record: PublicationRecord, attempt: PublicationIOAttempt) {
    return attempt.workspaceOperations.map((id) => {
      const operation = this.access.agents.workspaceOperation(record.runId, id);
      if (
        operation.controllerLeaseId !== attempt.controllerLeaseId ||
        operation.kind !==
          (attempt.phase === "publish" ? "publication" : "inspect_materialization") ||
        operation.execution ||
        operation.executionStop
      )
        fail(
          "publication_io_conflict",
          "Publication exclusion has conflicting execution ownership",
        );
      return operation;
    });
  }

  assertIOOwned(authority: ControllerAuthority, publicationId: string, attemptId: string) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      const attempt = record.ioAttempts.at(-1)!;
      if (
        record.outcome ||
        attempt.attemptId !== attemptId ||
        attempt.controllerLeaseId !== authority.leaseId ||
        attempt.result ||
        attempt.stop ||
        attempt.settledAt ||
        this.members(record, attempt).some((operation) => operation.stopEvidence)
      )
        fail("publication_io_unowned", "Publication worker differs from its live original attempt");
      if (attempt.phase === "publish") {
        const action = this.db
          .prepare("SELECT status FROM actions WHERE run_id=? AND operation_id=?")
          .get(authority.runId, record.operationId) as { status: string } | undefined;
        const control = this.access.control(authority.runId);
        if (
          action?.status !== "running" ||
          control.status !== "active" ||
          control.policyDigest !== record.policyDigest
        )
          fail("publication_io_stale", "Publication write admission is no longer current");
      }
      return { record, attempt };
    });
  }

  bindIO(
    authority: ControllerAuthority,
    publicationId: string,
    attemptId: string,
    input: CommandLifetime,
  ) {
    return this.access.transaction(authority, () => {
      const { record, attempt } = this.assertIOOwned(authority, publicationId, attemptId);
      if (attempt.execution) fail("publication_io_bound", "Publication execution is write-once");
      attempt.execution = CommandLifetimeSchema.parse(input);
      this.save(record);
      this.changed(authority, "publication.worker_bound", publicationId);
      return attempt;
    });
  }

  recordIOResult(
    authority: ControllerAuthority,
    publicationId: string,
    attemptId: string,
    input: PublicationIOResult,
  ) {
    return this.access.transaction(authority, () => {
      const { record, attempt } = this.assertIOOwned(authority, publicationId, attemptId);
      if (!attempt.execution)
        fail("publication_io_unbound", "Publication result has no bound worker");
      const result = PublicationIOResultSchema.parse(input);
      if (result.failure) result.failure = redactSensitiveText(result.failure, 3999);
      attempt.result = result;
      if (result.failure) record.failure = result.failure;
      record.intervention ||= result.intervention;
      this.save(record);
      this.changed(authority, "publication.worker_result", publicationId);
      return record;
    });
  }

  recordIOStop(
    authority: ControllerAuthority,
    publicationId: string,
    attemptId: string,
    input: CommandStop,
  ) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      const attempt = record.ioAttempts.find((item) => item.attemptId === attemptId);
      if (!attempt?.execution)
        return fail("publication_io_unbound", "Publication stop has no bound worker");
      const stop = CommandStopSchema.parse(input);
      assertCommandStop(attempt.execution, stop);
      if (attempt.stop && digestJson(attempt.stop) !== digestJson(stop))
        fail("publication_stop_conflict", "Publication stop acknowledgement is immutable");
      attempt.stop = stop;
      this.save(record);
      return record;
    });
  }

  noteIOFailure(authority: ControllerAuthority, publicationId: string, detail: string) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      if (!record.outcome) {
        record.failure = redactSensitiveText(detail, 3999);
        this.save(record);
        this.changed(authority, "publication.worker_error", publicationId);
      }
    });
  }

  /** Atomically settles this attempt's complete group; physical publication is a separate result. */
  settleIO(authority: ControllerAuthority, publicationId: string, attemptId: string) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      const attempt = record.ioAttempts.at(-1)!;
      if (attempt.attemptId !== attemptId)
        return fail("publication_io_superseded", "Only the original current attempt can settle");
      if (attempt.settledAt) return record;
      if (attempt.execution && !attempt.stop)
        fail(
          "publication_io_unsettled",
          "Independently prove the complete publication worker stopped",
        );
      if (
        !attempt.execution &&
        (attempt.result ||
          (attempt.phase === "publish" &&
            (record.dispatched ||
              record.publicRef ||
              record.canonicalRef ||
              record.lock ||
              record.packs.length)))
      )
        fail("publication_io_conflict", "Unbound publication attempt has unexplained effects");
      const operations = this.members(record, attempt);
      attempt.settledAt = now();
      record.ioStopped = true;
      if (!attempt.result)
        record.failure ??=
          attempt.phase === "publish"
            ? "Publication worker stopped without a retained completion; inspect its exact effects"
            : "Inspection stopped without retained observations; a new requested inspection is required";
      this.save(record);
      for (const operation of operations)
        this.access.agents.finishWorkspaceOperation(
          authority,
          operation.operationId,
          attempt.result && !attempt.result.failure ? "succeeded" : "failed",
          attempt.execution
            ? "Independent complete publication-worker stop settles this exact operation member"
            : "Publication attempt atomically fenced before worker binding; delayed launch is forbidden",
        );
      this.changed(authority, "publication.io_stopped", publicationId);
      if (attempt.phase === "inspect" && attempt.result && !attempt.result.failure)
        return this.finish(authority, publicationId);
      return record;
    });
  }

  /** null = not a member; false = preserve exclusion; true = its exact worker stopped or was fenced. */
  permitsWorkspaceStop(runId: string, operationId: string): boolean | null {
    const row = this.db
      .prepare(
        "SELECT publication_id FROM publications, json_each(record_json, '$.workspaceOperations') AS member WHERE run_id=? AND member.value=?",
      )
      .get(runId, operationId) as { publication_id: string } | undefined;
    if (!row) return null;
    const record = this.record(runId, row.publication_id);
    const attempt = record.ioAttempts.find((item) =>
      item.workspaceOperations.includes(operationId),
    )!;
    this.members(record, attempt);
    return (
      attempt.settledAt !== null &&
      (attempt.execution ? attempt.stop !== null : attempt.result === null)
    );
  }

  /** Each explicit inspection has its own one-use execution and source/canonical exclusions. */
  beginInspection(authority: ControllerAuthority, publicationId: string) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      if (record.outcome)
        fail("publication_finished", "Publication already has a terminal observation");
      this.assertStopped(record);
      if (record.ioAttempts.length >= 31)
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
      const operations: string[] = [];
      for (const identity of identities.filter(
        (entry, index, all) =>
          all.findIndex(
            (other) =>
              other.workspaceId === entry.workspaceId &&
              other.workspaceGeneration === entry.workspaceGeneration,
          ) === index,
      )) {
        const operation = this.access.agents.beginWorkspaceOperation(
          authority,
          identity,
          "inspect_materialization",
          this.access.control(authority.runId).controlVersion,
        );
        operations.push(operation.operationId);
        record.workspaceOperations.push(operation.operationId);
      }
      record.ioAttempts.push(this.newAttempt(authority, "inspect", operations));
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
  private finish(authority: ControllerAuthority, publicationId: string) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, publicationId);
      if (record.outcome) return record;
      this.assertStopped(record);
      const attempt = record.ioAttempts.at(-1)!;
      if (attempt.phase !== "inspect" || !attempt.result || attempt.result.failure)
        return fail(
          "publication_observation_missing",
          "Publication settlement requires retained stopped inspection observations",
        );
      const { canonical, user } = attempt.result;
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
    const attempt = record.ioAttempts.at(-1)!;
    this.assertIOOwned(authority, record.publicationId, attempt.attemptId);
    if (attempt.phase !== "inspect" || !attempt.execution)
      fail("publication_inspection_unowned", "Lock cleanup needs a bound inspection worker");
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
        provenance: record.provenance,
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
    this.assertStopped(record);
    this.objectRecord(runId, record);
    return this.access.reviews.approval(runId, record, "exact_revision");
  }
  /** Exact physical object plus a validated chain to its reviewed application ancestor. */
  trackerDescendsFrom(runId: string, tipId: string, ancestorId: string): boolean {
    let current = this.record(runId, tipId);
    this.objectRecord(runId, current);
    const seen = new Set<string>();
    while (current.publicationId !== ancestorId) {
      if (current.provenance.kind !== "tracker" || seen.has(current.publicationId)) return false;
      seen.add(current.publicationId);
      current = this.record(
        runId,
        this.access.trackerCommit(runId, current.provenance.trackerCommitId).parentPublicationId,
      );
    }
    return current.outcome === "published" && current.ioStopped && !current.intervention;
  }
  objectRecord(runId: string, publication: PublicationRecord) {
    const application = this.access.commits.record(runId, publication.commitId);
    if (
      application.status !== "created" ||
      !application.sourceIntact ||
      application.policyDigest !== publication.policyDigest ||
      application.candidateId !== publication.candidateId ||
      application.candidateGeneration !== publication.candidateGeneration
    )
      return fail("publication_ancestry", "Publication has no intact application commitment");
    let current = publication;
    const seen = new Set<string>();
    while (current.provenance.kind === "tracker") {
      if (seen.has(current.publicationId) || seen.size >= 1024)
        return fail("publication_ancestry", "Invalid tracker ancestry");
      seen.add(current.publicationId);
      const tracker = this.access.trackerCommit(runId, current.provenance.trackerCommitId);
      const parent = this.record(runId, tracker.parentPublicationId);
      if (
        tracker.status !== "created" ||
        !tracker.sourceIntact ||
        tracker.applicationCommitId !== application.commitId ||
        tracker.applicationRevision !== application.revision ||
        tracker.applicationTree !== application.applicationTree ||
        tracker.revision !== current.revision ||
        current.provenance.reviewedRevision !== application.revision ||
        tracker.policyDigest !== publication.policyDigest ||
        parent.outcome !== "published" ||
        !parent.ioStopped ||
        parent.intervention ||
        parent.revision !== tracker.parentRevision ||
        current.expectedPreviousRevision !== tracker.parentRevision ||
        current.commitId !== parent.commitId ||
        current.reviewEvidenceId !== parent.reviewEvidenceId ||
        current.candidateId !== parent.candidateId ||
        current.candidateGeneration !== parent.candidateGeneration ||
        current.policyDigest !== parent.policyDigest ||
        current.workspaceId !== tracker.workspaceId ||
        current.workspaceGeneration !== tracker.workspaceGeneration
      )
        return fail(
          "publication_ancestry",
          "Tracker publication lost its exact application-only ancestry proof",
        );
      current = parent;
    }
    if (current.commitId !== application.commitId || current.revision !== application.revision)
      return fail(
        "publication_ancestry",
        "Tracker ancestry does not end at the reviewed application object",
      );
    return publication.provenance.kind === "tracker"
      ? this.access.trackerCommit(runId, publication.provenance.trackerCommitId)
      : application;
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
