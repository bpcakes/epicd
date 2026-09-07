import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { CommitRecordSchema, type CommitRecord } from "../domain/commits.js";
import type { CandidateIdentity } from "../domain/delivery.js";
import type {
  ControllerAuthority,
  ControlState,
  ActionRecord,
  ObservationInput,
} from "../domain/orchestration.js";
import type { AgentJournal } from "./agent-journal.js";
import type { ReviewJournal } from "./review-journal.js";
import { DeliveryError, type DeliveryJournal } from "./delivery-journal.js";
import { redactSensitiveText } from "../util/redact.js";
import { RunStateSchema } from "../domain/types.js";

export const COMMIT_TABLES = ["delivery_commits"] as const;
export function createCommitsSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS delivery_commits (
    commit_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL UNIQUE REFERENCES actions(operation_id),
    candidate_id TEXT NOT NULL, candidate_generation INTEGER NOT NULL,
    workspace_operation_id TEXT NOT NULL UNIQUE REFERENCES workspace_operations(operation_id),
    review_evidence_id TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    UNIQUE(run_id, candidate_id, candidate_generation),
    FOREIGN KEY(run_id, candidate_id, candidate_generation) REFERENCES candidates(run_id, candidate_id, generation),
    FOREIGN KEY(run_id, review_evidence_id) REFERENCES review_evidence(run_id, evidence_id),
    CHECK(json_extract(record_json, '$.commitId') = commit_id AND json_extract(record_json, '$.runId') = run_id AND
      json_extract(record_json, '$.operationId') = operation_id AND json_extract(record_json, '$.candidateId') = candidate_id AND
      json_extract(record_json, '$.candidateGeneration') = candidate_generation AND json_extract(record_json, '$.workspaceOperationId') = workspace_operation_id AND
      json_extract(record_json, '$.reviewEvidenceId') = review_evidence_id)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS one_pending_commit ON delivery_commits(run_id)
    WHERE json_extract(record_json, '$.status') IN ('preparing', 'writing');`);
}
type Access = {
  transaction<T>(authority: ControllerAuthority, body: () => T): T;
  control(runId: string): ControlState;
  action(runId: string, actionId: string): ActionRecord | null;
  observe(authority: ControllerAuthority, input: ObservationInput): unknown;
  agents: AgentJournal;
  delivery: DeliveryJournal;
  reviews: ReviewJournal;
  assertPublicationIdle(runId: string): void;
  deliveryRepository(runId: string): import("../domain/publication.js").DeliveryRepository | null;
};
const at = () => new Date().toISOString();

export class CommitJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly access: Access,
  ) {}
  reserve(authority: ControllerAuthority, actionId: string): CommitRecord {
    return this.access.transaction(authority, () => {
      this.access.assertPublicationIdle(authority.runId);
      const action = this.access.action(authority.runId, actionId);
      const control = this.access.control(authority.runId);
      if (
        !action ||
        action.status !== "running" ||
        action.request.action.kind !== "request_commit" ||
        control.status !== "active" ||
        action.policyDigest !== control.policyDigest
      )
        throw new DeliveryError("commit_action_stale", "Commit needs its current admitted action");
      const candidate = this.access.delivery.candidate(authority.runId, action.request.action);
      if (candidate.source.kind !== "implementation")
        throw new DeliveryError(
          "commit_source",
          "A published epic target is read-only; repairs need a separately reviewed implementation candidate",
        );
      const approved = this.access.reviews.approval(authority.runId, candidate);
      if (!approved || !candidate.snapshot)
        throw new DeliveryError(
          "commit_not_approved",
          "Commit requires current independent approval, passing pre-commit checks and no unresolved findings",
        );
      if (this.forCandidate(authority.runId, candidate))
        throw new DeliveryError(
          "commit_exists",
          "This candidate already has a commit intent; inspect/reconcile it, never blindly commit again",
        );
      if (
        this.records(authority.runId).some((item) => ["preparing", "writing"].includes(item.status))
      )
        throw new DeliveryError(
          "commit_unsettled",
          "An earlier private commit must be reconciled first",
        );
      if (
        candidate.snapshot.parentRevision !==
        this.implementationBase(
          authority.runId,
          this.latestCreated(authority.runId)?.commitId ?? null,
        ).revision
      )
        throw new DeliveryError(
          "commit_parent_stale",
          "The next commit must extend the latest private commit; create an implementation workspace at that base",
        );
      const exclusion = this.access.agents.beginWorkspaceOperation(
        authority,
        candidate,
        "commit",
        control.controlVersion,
      );
      const createdAt = at();
      const seconds = Math.floor(Date.parse(createdAt) / 1000);
      const subject = redactSensitiveText(action.request.action.subject, 256);
      if (/[\r\n\0]/.test(subject))
        throw new DeliveryError("commit_subject", "Commit subject must be one line");
      const snapshot = candidate.snapshot;
      const objectContent = `tree ${snapshot.fullTree}\nparent ${snapshot.parentRevision}\nauthor Epicd <epicd@epicd.local> ${seconds} +0000\ncommitter Epicd <epicd@epicd.local> ${seconds} +0000\n\n${subject}\n\nEpicd-Operation: ${action.operationId}\n`;
      const record = CommitRecordSchema.parse({
        schemaVersion: 1,
        runId: authority.runId,
        commitId: randomUUID(),
        operationId: action.operationId,
        controllerLeaseId: authority.leaseId,
        workspaceOperationId: exclusion.operationId,
        workspaceId: candidate.workspaceId,
        workspaceGeneration: candidate.workspaceGeneration,
        candidateId: candidate.candidateId,
        candidateGeneration: candidate.candidateGeneration,
        taskId: candidate.taskId,
        reviewEvidenceId: approved,
        validationPlanId: candidate.validationPlanId,
        policyDigest: candidate.policyDigest,
        parentRevision: snapshot.parentRevision,
        fullTree: snapshot.fullTree,
        applicationTree: snapshot.applicationTree,
        fingerprint: snapshot.fingerprint,
        objectContent,
        revision: null,
        status: "preparing",
        failure: null,
        sourceIntact: false,
        createdAt,
        finishedAt: null,
      });
      this.db
        .prepare("INSERT INTO delivery_commits VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          record.commitId,
          record.runId,
          record.operationId,
          record.candidateId,
          record.candidateGeneration,
          record.workspaceOperationId,
          approved,
          JSON.stringify(record),
        );
      this.changed(authority, "commit.reserved", record.commitId);
      return record;
    });
  }
  /** Rechecked immediately before any commit-object or ref write. */
  assertWritable(authority: ControllerAuthority, commitId: string): CommitRecord {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, commitId);
      const control = this.access.control(authority.runId);
      const operation = this.access.agents.activeWorkspaceOperation(authority.runId, record);
      const action = this.db
        .prepare("SELECT status FROM actions WHERE run_id = ? AND operation_id = ?")
        .get(authority.runId, record.operationId) as { status: string } | undefined;
      if (
        !["preparing", "writing"].includes(record.status) ||
        record.controllerLeaseId !== authority.leaseId ||
        control.status !== "active" ||
        control.policyDigest !== record.policyDigest ||
        action?.status !== "running" ||
        operation?.operationId !== record.workspaceOperationId ||
        operation.controllerLeaseId !== authority.leaseId ||
        this.access.reviews.approval(authority.runId, record) !== record.reviewEvidenceId
      )
        throw new DeliveryError(
          "commit_stale",
          "Commit authority, approval or source ownership changed",
        );
      return record;
    });
  }
  prepareWrite(authority: ControllerAuthority, commitId: string, revision: string) {
    return this.access.transaction(authority, () => {
      const record = this.assertWritable(authority, commitId);
      if (record.status !== "preparing")
        throw new DeliveryError("commit_dispatched", "Commit write intent already exists");
      record.revision = revision;
      record.status = "writing";
      this.save(record);
      this.changed(authority, "commit.writing", commitId);
      return record;
    });
  }
  /** Physical outcome, not publication authority. Preserve stale-but-created objects as facts. */
  finish(
    authority: ControllerAuthority,
    commitId: string,
    created: boolean,
    sourceIntact: boolean,
    detail: string | null,
  ) {
    return this.access.transaction(authority, () => {
      const record = this.record(authority.runId, commitId);
      if (["created", "failed"].includes(record.status)) return record;
      const operation = this.access.agents.workspaceOperation(
        authority.runId,
        record.workspaceOperationId,
      );
      if (!operation.stopEvidence)
        throw new DeliveryError(
          "commit_io_unsettled",
          "Commit I/O must be independently stopped before settlement",
        );
      if (created && !record.revision)
        throw new DeliveryError(
          "commit_unplanned_revision",
          "No revision was reserved before writing",
        );
      record.status = created ? "created" : "failed";
      record.sourceIntact = sourceIntact;
      record.failure = detail ? redactSensitiveText(detail, 3999) : null;
      record.finishedAt = at();
      this.save(record);
      this.changed(authority, `commit.${record.status}`, commitId);
      return record;
    });
  }
  record(runId: string, commitId: string): CommitRecord {
    const row = this.db
      .prepare("SELECT record_json FROM delivery_commits WHERE run_id = ? AND commit_id = ?")
      .get(runId, commitId) as { record_json: string } | undefined;
    if (!row)
      throw new DeliveryError("unknown_commit", "Commit is missing or belongs to another run");
    return CommitRecordSchema.parse(JSON.parse(row.record_json));
  }
  records(runId: string) {
    return (
      this.db
        .prepare("SELECT record_json FROM delivery_commits WHERE run_id = ? ORDER BY rowid")
        .all(runId) as { record_json: string }[]
    ).map((row) => CommitRecordSchema.parse(JSON.parse(row.record_json)));
  }
  forCandidate(runId: string, candidate: CandidateIdentity) {
    return (
      this.records(runId).find(
        (record) =>
          record.candidateId === candidate.candidateId &&
          record.candidateGeneration === candidate.candidateGeneration,
      ) ?? null
    );
  }
  exact(runId: string, candidate: CandidateIdentity, revision: string): CommitRecord {
    const record = this.forCandidate(runId, candidate);
    if (
      !record ||
      record.status !== "created" ||
      !record.sourceIntact ||
      record.revision !== revision ||
      record.policyDigest !== this.access.control(runId).policyDigest ||
      !this.access.delivery.candidateCurrent(runId, candidate)
    )
      throw new DeliveryError(
        "commit_not_current",
        "Exact verification requires the current, physically confirmed private commit",
      );
    return record;
  }
  latestCreated(runId: string) {
    return this.records(runId).findLast((record) => record.status === "created") ?? null;
  }
  implementationBase(
    runId: string,
    commitId: string | null,
  ): {
    revision: string;
    sourcePath: string;
    commit: CommitRecord | null;
    sourceWorkspace: import("../domain/agents.js").WorkspaceIdentity | null;
  } {
    this.access.assertPublicationIdle(runId);
    if (this.records(runId).some((record) => ["preparing", "writing"].includes(record.status)))
      throw new DeliveryError(
        "commit_unsettled",
        "Reconcile private commit I/O before choosing a new implementation base",
      );
    const latest = this.latestCreated(runId);
    if ((latest?.commitId ?? null) !== commitId)
      throw new DeliveryError(
        "implementation_base_stale",
        "New work must extend the latest private commit, never rewrite or fork completed work",
      );
    if (latest) {
      const custody = this.access.deliveryRepository(runId);
      const sourceWorkspace =
        custody?.workspace && custody.privateRevision === latest.revision
          ? custody.workspace
          : null;
      return {
        revision: latest.revision!,
        sourcePath: this.access.agents.workspace(runId, sourceWorkspace ?? latest).path,
        commit: latest,
        sourceWorkspace,
      };
    }
    const row = this.db.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(runId) as
      { state_json: string } | undefined;
    if (!row) throw new DeliveryError("unknown_run", "Run baseline is unavailable");
    const run = RunStateSchema.parse(JSON.parse(row.state_json));
    if (!run.epicBaseRevision)
      throw new DeliveryError("missing_baseline", "Run needs an exact initial baseline");
    return {
      revision: run.epicBaseRevision,
      sourcePath: run.repoPath,
      commit: null,
      sourceWorkspace: null,
    };
  }
  summaries(runId: string) {
    return this.records(runId)
      .slice(-10)
      .map((record) => ({
        commitId: record.commitId,
        candidateId: record.candidateId,
        status: record.status,
        revision: record.revision,
        sourceIntact: record.sourceIntact,
        warning: "Commit creation alone is not independent verification or publication",
      }));
  }
  private save(record: CommitRecord) {
    this.db
      .prepare("UPDATE delivery_commits SET record_json = ? WHERE run_id = ? AND commit_id = ?")
      .run(JSON.stringify(CommitRecordSchema.parse(record)), record.runId, record.commitId);
  }
  private changed(authority: ControllerAuthority, kind: string, commitId: string) {
    this.db
      .prepare(
        "UPDATE orchestration_runs SET control_version = control_version + 1 WHERE run_id = ?",
      )
      .run(authority.runId);
    this.access.observe(authority, {
      source: "commit-journal",
      sourceEventId: randomUUID(),
      kind,
      summary: commitId,
      artifactIds: [],
      identity: null,
      wakesOrchestrator: true,
    });
  }
}
