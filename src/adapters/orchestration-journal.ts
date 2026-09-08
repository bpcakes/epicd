import { randomUUID } from "node:crypto";
import { journalRecordView } from "./journal-records.js";
import { RunStateSchema } from "../domain/types.js";
import type { RuntimeHandoffTarget } from "../domain/runtime-handoff.js";
import { commitRuntimeHandoff } from "./runtime-handoff.js";
import type Database from "better-sqlite3";
import {
  ActionRecordSchema,
  ActionResultSchema,
  ControlStateSchema,
  MemoryInputSchema,
  ObservationInputSchema,
  ObservationSchema,
  OrchestratorDecisionSchema,
  type ActionRecord,
  type ActionResult,
  type ControllerAuthority,
  type ControlState,
  type DecisionTicket,
  type MemoryEntry,
  type MemoryInput,
  type Observation,
  type ObservationInput,
  type OrchestratorDecision,
  type ActionPayload,
} from "../domain/orchestration.js";
import {
  digestJson,
  RepositoryPolicySchema,
  type RepositoryPolicy,
} from "../domain/repository-policy.js";
import { redactSensitiveText } from "../util/redact.js";
import { AgentJournal, AGENT_TABLES, createAgentsSchema } from "./agent-journal.js";
import {
  WorkspaceDisposalJournal,
  createWorkspaceDisposalSchema,
} from "./workspace-disposal-journal.js";
import {
  DecisionJournal,
  DECISION_SOURCE_TABLES,
  createDecisionSourceSchema,
} from "./decision-journal.js";
import {
  DeliveryJournal,
  DeliveryError,
  DELIVERY_TABLES,
  createDeliverySchema,
} from "./delivery-journal.js";
import { ReviewJournal, REVIEW_TABLES, createReviewsSchema } from "./review-journal.js";
import { CommitJournal, COMMIT_TABLES, createCommitsSchema } from "./commit-journal.js";
import {
  TrackerCommitJournal,
  TRACKER_COMMIT_TABLES,
  createTrackerCommitSchema,
} from "./tracker-commit-journal.js";
import {
  PublicationJournal,
  PUBLICATION_TABLES,
  createPublicationSchema,
} from "./publication-journal.js";
import { concurrentWithPublication } from "../domain/publication.js";
import { TrackerJournal, TRACKER_TABLES, createTrackerSchema } from "./tracker-journal.js";
import { concurrentWithTracker, type CompletionResources } from "../domain/tracker.js";
import {
  DiagnosticJournal,
  DIAGNOSTIC_TABLES,
  createDiagnosticsSchema,
} from "./diagnostic-journal.js";

import { FixtureJournal, FIXTURE_TABLES, createFixturesSchema } from "./fixture-journal.js";
import { observeEpicDelivery, epicRequirements } from "./epic-delivery.js";
import { scopeClosure } from "./scope-closure.js";
import { bindEpicRepair, assertEpicRepair } from "./epic-repair.js";
import {
  RepositoryAdmissionJournal,
  REPOSITORY_ADMISSION_TABLES,
  createRepositoryAdmissionSchema,
} from "./repository-admission-journal.js";

export const ORCHESTRATION_SCHEMA_VERSION = 38;

export const ORCHESTRATION_TABLES = [
  "orchestration_runs",
  "decisions",
  "actions",
  "observations",
  "memory_entries",
  "escalations",
  ...DECISION_SOURCE_TABLES,
  ...AGENT_TABLES,
  "workspace_disposals",
  ...DELIVERY_TABLES,
  ...REVIEW_TABLES,
  ...COMMIT_TABLES,
  ...PUBLICATION_TABLES,
  ...TRACKER_TABLES,
  ...TRACKER_COMMIT_TABLES,
  ...DIAGNOSTIC_TABLES,
  ...FIXTURE_TABLES,
  ...REPOSITORY_ADMISSION_TABLES,
] as const;

/** Called only while initializing an empty StateStore. There is no migration path. */
export function createOrchestrationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestration_schema (version INTEGER PRIMARY KEY CHECK(version > 0)) STRICT;
    INSERT OR IGNORE INTO orchestration_schema(version) VALUES (${ORCHESTRATION_SCHEMA_VERSION});
    CREATE TABLE IF NOT EXISTS orchestration_runs (
      run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
      control_version INTEGER NOT NULL CHECK(control_version >= 0),
      policy_digest TEXT NOT NULL, policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
      status TEXT NOT NULL CHECK(status IN ('active','paused','awaiting_user','blocked','complete')),
      observation_cursor INTEGER NOT NULL DEFAULT 0 CHECK(observation_cursor >= 0),
      decisions_used INTEGER NOT NULL DEFAULT 0 CHECK(decisions_used >= 0),
      max_decisions INTEGER NOT NULL CHECK(max_decisions > 0)
    ) STRICT;
    CREATE TRIGGER control_status_projection AFTER UPDATE OF status ON orchestration_runs
      BEGIN UPDATE runs SET phase = NEW.status WHERE run_id = NEW.run_id; END;
    CREATE TABLE IF NOT EXISTS decisions (
      decision_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      observation_cursor INTEGER NOT NULL, control_version INTEGER NOT NULL, policy_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','cancelled')),
      decision_json TEXT, created_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_decision ON decisions(run_id) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS actions (
      action_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(decision_id),
      operation_id TEXT NOT NULL UNIQUE, policy_digest TEXT NOT NULL,
      request_json TEXT NOT NULL CHECK(json_valid(request_json)), request_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('accepted','running','succeeded','failed','rejected','cancelled','indeterminate')),
      result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS actions_by_run ON actions(run_id, created_at, action_id);
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      source TEXT NOT NULL, source_event_id TEXT NOT NULL, input_digest TEXT NOT NULL,
      observation_json TEXT NOT NULL CHECK(json_valid(observation_json)), at TEXT NOT NULL,
      wakes INTEGER NOT NULL CHECK(wakes IN (0,1)), UNIQUE(run_id, source, source_event_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS observations_by_run ON observations(run_id, id);
    CREATE TABLE IF NOT EXISTS memory_entries (
      memory_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      entry_json TEXT NOT NULL CHECK(json_valid(entry_json)), created_at TEXT NOT NULL,
      superseded_by TEXT REFERENCES memory_entries(memory_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS escalations (
      escalation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      question TEXT NOT NULL, reason TEXT NOT NULL, evidence_ids_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','answered','superseded')),
      response TEXT, created_at TEXT NOT NULL, answered_at TEXT
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_escalation ON escalations(run_id) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS quarantined_orchestration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES quarantined_runs(run_id) ON DELETE CASCADE,
      source_table TEXT NOT NULL, row_json TEXT NOT NULL
    ) STRICT;
  `);
  createAgentsSchema(db);
  createWorkspaceDisposalSchema(db);
  createDeliverySchema(db);
  createReviewsSchema(db);
  createCommitsSchema(db);
  createPublicationSchema(db);
  createTrackerSchema(db);
  createTrackerCommitSchema(db);
  createDecisionSourceSchema(db);
  createDiagnosticsSchema(db);
  createFixturesSchema(db);
  createRepositoryAdmissionSchema(db);
}

type ControlRow = {
  run_id: string;
  control_version: number;
  policy_digest: string;
  policy_json: string;
  status: ControlState["status"];
  observation_cursor: number;
  decisions_used: number;
  max_decisions: number;
};
type DecisionRow = {
  decision_id: string;
  observation_cursor: number;
  control_version: number;
  policy_digest: string;
  status: string;
};
type ActionRow = {
  action_id: string;
  run_id: string;
  decision_id: string;
  operation_id: string;
  policy_digest: string;
  request_json: string;
  request_digest: string;
  status: ActionRecord["status"];
  result_json: string | null;
  created_at: string;
  updated_at: string;
};
type ObservationRow = { id: number; input_digest: string; observation_json: string; at: string };

export type ActionAdmission =
  | { kind: "accepted" | "replayed"; action: ActionRecord }
  | { kind: "rejected"; result: Extract<ActionResult, { status: "rejected" }> };

export class DispatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchConflictError";
  }
}
export class MemoryReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryReferenceError";
  }
}

export class OrchestrationJournal {
  readonly agents: AgentJournal;
  readonly workspaceDisposals: WorkspaceDisposalJournal;
  readonly delivery: DeliveryJournal;
  readonly reviews: ReviewJournal;
  readonly commits: CommitJournal;
  readonly trackerCommits: TrackerCommitJournal;
  readonly publications: PublicationJournal;
  readonly tracker: TrackerJournal;
  readonly decisionSource: DecisionJournal;
  readonly diagnostics: DiagnosticJournal;
  readonly fixtures: FixtureJournal;
  readonly repositoryAdmission: RepositoryAdmissionJournal;

  constructor(
    private readonly db: Database.Database,
    private readonly assertStorage: () => import("../domain/state-file-identity.js").StateFileIdentity,
  ) {
    this.fixtures = new FixtureJournal(db, {
      transaction: (authority, body) => this.transaction(authority, body),
      action: (runId, actionId) => this.action(runId, actionId),
      actionForOperation: (runId, operationId) => this.actionForOperation(runId, operationId),
      control: (runId) => this.control(runId),
      policy: (runId) => this.policy(runId),
      operatorTransaction: (runId, version, body) =>
        this.db
          .transaction(() => {
            const control = this.control(runId);
            if (control.controlVersion !== version || control.status === "complete")
              throw new Error(
                "Control changed or run completed; inspect before changing fixture authority",
              );
            const result = body();
            this.noteSettingsChange(runId);
            return result;
          })
          .immediate(),
      note: (runId, kind, summary) => {
        this.recordObservation(runId, {
          source: [
            "fixture.granted",
            "fixture.grant_revoked",
            "fixture.validation_granted",
            "fixture.validation_revoked",
          ].includes(kind)
            ? "operator"
            : "fixture-kernel",
          sourceEventId: randomUUID(),
          kind,
          summary,
          identity: null,
          artifactIds: [],
          wakesOrchestrator: true,
        });
      },
    });
    this.diagnostics = new DiagnosticJournal(db, {
      transaction: (authority, body) => this.transaction(authority, body),
      budget: (runId) => this.policy(runId).budgets.artifactBytes,
      turn: (runId, identity) => this.agents.turn(runId, identity),
      observe: (authority, input) => this.appendObservation(authority, input),
      exhaust: (authority) => {
        if (this.control(authority.runId).status === "active")
          this.setEscalation(
            authority,
            "The run's retained diagnostic budget is exhausted. Preserve existing evidence; authorize a budget increase or end the run before further evidence-producing work.",
            "diagnostic_budget_exhausted",
            [],
          );
      },
    });
    this.decisionSource = new DecisionJournal(db, {
      transaction: (authority, body) => this.transaction(authority, body),
      control: (runId) => this.control(runId),
      pending: (runId) => this.pendingDecision(runId),
      observe: (authority, input) => this.appendObservation(authority, input),
      turn: (runId, identity) => this.agents.turn(runId, identity),
    });
    this.agents = new AgentJournal(db, {
      validationInterruptedBeforeLaunch: (runId, operationId) => {
        const evidence = this.delivery.validationForWorkspaceOperation(runId, operationId);
        return evidence?.status === "interrupted" && evidence.outcome === null;
      },
      transaction: (authority, body) => this.transaction(authority, body),
      control: (runId) => this.control(runId),
      policy: (runId) => this.policy(runId),
      observe: (authority, input) => this.appendObservation(authority, input),
      publicationPending: (runId) => this.publications.pending(runId),
      assertTrackerCommitIdle: (runId) => this.trackerCommits.assertIdle(runId),
      deliveryRepository: (runId) => this.publications.repository(runId),
      assertTaskOwned: (runId, taskId) => this.tracker.assertTaskOwned(runId, taskId),
      bindEpicRepair: (runId, taskId, candidateId, workspace) =>
        bindEpicRepair(this, runId, taskId, candidateId, workspace),
      assertEpicRepair: (runId, taskId, binding, workspace, requireLatestBase) =>
        assertEpicRepair(this, runId, taskId, binding, workspace, requireLatestBase),
      epicReviewTarget: (runId, taskId, candidateId) => {
        if (taskId !== this.runObjective(runId).epicId) return false;
        const candidate = this.delivery.latestCandidate(runId, taskId);
        if (
          !candidate ||
          candidate.candidateId !== candidateId ||
          !this.delivery.candidateCurrent(runId, candidate)
        )
          throw new DeliveryError(
            "epic_review_target",
            "Epic review requires its current evidence-bound candidate",
          );
        return true;
      },
      epicRepairContext: (runId) => {
        const { context, checks } = epicRequirements(this, runId);
        const candidate = this.delivery.latestCandidate(runId, this.runObjective(runId).epicId)!;
        const findings = this.reviews.openFindings(runId, candidate);
        return {
          ...context,
          checks,
          findings: findings.slice(0, 100),
          omittedFindings: Math.max(0, findings.length - 100),
          warning:
            "Repair only this epic in the assigned private workspace. Existing findings and checks remain binding. Implementation output cannot approve delivery; independent review and fresh whole-epic exact-revision verification are required.",
        };
      },
    });
    this.delivery = new DeliveryJournal(db, {
      transaction: (authority, body) => this.transaction(authority, body),
      control: (runId) => this.control(runId),
      policy: (runId) => this.policy(runId),
      action: (runId, actionId) => this.action(runId, actionId),
      observe: (authority, input) => this.appendObservation(authority, input),
      agents: this.agents,
      fixtures: this.fixtures,
      reviewChecks: (runId, taskId) => this.reviews.requiredChecks(runId, taskId),
      exactCommit: (runId, candidate, revision) => this.commits.exact(runId, candidate, revision),
      assertPublicationIdle: (runId) => {
        this.publications.assertIdle(runId);
        this.trackerCommits.assertIdle(runId);
      },
      epicTarget: (runId, operationId, reviewedPublicationId) =>
        observeEpicDelivery(this, runId, operationId, reviewedPublicationId),
      epicRequirements: (runId) => epicRequirements(this, runId),
      assertEpicRepair: (runId, taskId, binding, workspace) =>
        assertEpicRepair(this, runId, taskId, binding, workspace, false),
      epicId: (runId) => this.runObjective(runId).epicId,
    });
    this.reviews = new ReviewJournal(db, {
      transaction: (authority, body) => this.transaction(authority, body),
      control: (runId) => this.control(runId),
      action: (runId, actionId) => this.action(runId, actionId),
      observe: (authority, input) => this.appendObservation(authority, input),
      agents: this.agents,
      delivery: this.delivery,
      diagnostics: this.diagnostics,
      recordView: (runId, target) => journalRecordView(this, runId, target),
    });
    this.commits = new CommitJournal(db, {
      transaction: (authority, body) => this.transaction(authority, body),
      control: (runId) => this.control(runId),
      action: (runId, actionId) => this.action(runId, actionId),
      observe: (authority, input) => this.appendObservation(authority, input),
      agents: this.agents,
      delivery: this.delivery,
      reviews: this.reviews,
      assertPublicationIdle: (runId) => {
        this.publications.assertIdle(runId);
        this.trackerCommits.assertIdle(runId);
      },
      deliveryRepository: (runId) => this.publications.repository(runId),
      publishedObject: (runId, commitId, revision) => {
        const publication = this.publications
          .records(runId)
          .findLast(
            (entry) =>
              entry.revision === revision &&
              entry.commitId === commitId &&
              entry.outcome === "published" &&
              entry.ioStopped &&
              !entry.intervention,
          );
        return publication ? this.publications.objectRecord(runId, publication) : null;
      },
    });
    this.publications = new PublicationJournal(db, {
      transaction: (authority, body) => this.transaction(authority, body),
      control: (runId) => this.control(runId),
      action: (runId, actionId) => this.action(runId, actionId),
      observe: (authority, input) => this.appendObservation(authority, input),
      agents: this.agents,
      delivery: this.delivery,
      reviews: this.reviews,
      commits: this.commits,
      assertTrackerIdle: (runId) => this.tracker.assertIdle(runId),
      assertTrackerCommitIdle: (runId) => this.trackerCommits.assertIdle(runId),
      trackerCommit: (runId, id) => this.trackerCommits.record(runId, id),
      assertTrackerCommitParent: (record) => this.trackerCommits.assertParent(record),
    });
    this.tracker = new TrackerJournal(db, {
      transaction: (authority, body) => this.transaction(authority, body),
      control: (runId) => this.control(runId),
      action: (runId, actionId) => this.action(runId, actionId),
      observe: (authority, input) => this.appendObservation(authority, input),
      assertPublicationIdle: (runId) => {
        this.publications.assertIdle(runId);
        this.trackerCommits.assertIdle(runId);
      },
      scopeClosure: (runId, kind, taskId, revision, operationId) =>
        scopeClosure(this, runId, kind, taskId, revision, operationId),
      completionResources: (runId, operationId) => this.completionResources(runId, operationId),
      closurePublication: (runId, taskId, revision, claim) => {
        const id = this.publications.repository(runId)?.lastPublishedId;
        if (!id)
          throw new DeliveryError(
            "closure_not_published",
            "Task closure needs a verified published revision",
          );
        const publication = this.publications.record(runId, id);
        if (
          publication.revision !== revision ||
          this.publications.approval(runId, id) !== publication.reviewEvidenceId
        )
          throw new DeliveryError(
            "closure_not_verified",
            "Task closure needs current independent exact-SHA publication approval",
          );
        const commit = this.commits.exact(
          runId,
          publication,
          publication.provenance.kind === "tracker"
            ? publication.provenance.reviewedRevision
            : revision,
        );
        const candidate = this.delivery.candidate(runId, publication);
        if (candidate.source.kind !== "implementation")
          throw new DeliveryError(
            "closure_claim_mismatch",
            "Task closure requires an implementation candidate",
          );
        const assignment = this.agents.assignment(runId, candidate.source.assignmentId);
        if (
          commit.taskId !== taskId ||
          candidate.taskId !== taskId ||
          !assignment.trackerClaim ||
          digestJson(assignment.trackerClaim) !== digestJson(claim)
        )
          throw new DeliveryError(
            "closure_claim_mismatch",
            "Verified implementation did not originate under this exact task claim",
          );
        return publication;
      },
    });
    this.trackerCommits = new TrackerCommitJournal(db, this, (authority, body) =>
      this.transaction(authority, body),
    );
    this.repositoryAdmission = new RepositoryAdmissionJournal(db, this, (authority, body) =>
      this.transaction(authority, body),
    );
    this.workspaceDisposals = new WorkspaceDisposalJournal(db, this, (authority, body) =>
      this.transaction(authority, body),
    );
  }

  hasRun(runId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM orchestration_runs WHERE run_id = ?").get(runId) !== undefined
    );
  }

  /** Retention is explicit, not a claim that workspaces, panes or fixtures were deleted. */
  private completionResources(runId: string, ownOperationId: string): CompletionResources {
    const unfinished = (message: string): never => {
      throw new DeliveryError("completion_unsettled", message);
    };
    const terminal = this.tracker
      .operations(runId)
      .find((record) => record.operationId === ownOperationId);
    // The one live read-only reconciler and lost prior reader acknowledgements
    // settle with the original completion action. No unrelated action is exempt.
    const reconcilers = this.actions(runId).filter(
      (action) =>
        ["running", "indeterminate"].includes(action.status) &&
        action.request.action.kind === "reconcile_tracker_operation" &&
        action.request.action.trackerOperationId === terminal?.trackerOperationId,
    );
    if (
      reconcilers.filter((action) => action.status === "running").length > 1 ||
      this.actions(runId).some(
        (action) =>
          action.operationId !== ownOperationId &&
          !reconcilers.some((reconciler) => reconciler.actionId === action.actionId) &&
          ["accepted", "running", "indeterminate"].includes(action.status),
      )
    )
      unfinished("Settle all other actions before completing the run");
    if (
      this.agents.turns(runId).some((turn) => !turn.stopEvidence) ||
      this.decisionSource.unsettled(runId)
    )
      unfinished("Completion requires confirmed stop of every agent and coordinator request");
    if (
      this.db
        .prepare(
          `SELECT 1 FROM workspace_operations WHERE run_id = ? AND
      json_extract(record_json, '$.stopEvidence') IS NULL LIMIT 1`,
        )
        .get(runId)
    )
      unfinished("Completion requires confirmed stop of every workspace operation");
    const agents = this.agents.instances(runId);
    if (
      agents.some(
        (agent) =>
          agent.activeTurnId !== null ||
          this.agents
            .messages(runId, agent)
            .some((message) => !["acknowledged", "superseded"].includes(message.status)),
      )
    )
      unfinished("Deliver or supersede pending agent instructions before completion");
    const workspaces = this.db
      .prepare("SELECT workspace_id FROM workspaces WHERE run_id = ? ORDER BY workspace_id")
      .all(runId) as { workspace_id: string }[];
    if (this.workspaceDisposals.records(runId).some((record) => record.outcome === null))
      unfinished("Workspace disposal needs confirmed stop and physical reconciliation");
    if (
      this.db
        .prepare(
          `SELECT 1 FROM workspaces WHERE run_id = ? AND
      json_extract(record_json, '$.activeTurnId') IS NOT NULL LIMIT 1`,
        )
        .get(runId)
    )
      unfinished("A workspace still has an active turn");
    this.publications.assertIdle(runId);
    if (
      this.commits.records(runId).some((record) => ["preparing", "writing"].includes(record.status))
    )
      unfinished("A commit operation remains unsettled");
    const fixtures = this.fixtures.creations(runId);
    if (this.fixtures.validation.uses(runId).some((use) => !use.localStopped || !use.remoteStopped))
      unfinished("Fixture validation requires independent local and database stop evidence");
    if (
      fixtures.some(
        (fixture) =>
          !["owned", "not_created"].includes(fixture.status) ||
          (fixture.status === "owned" &&
            (!fixture.clientStopEvidence || !fixture.observation?.backendStopped)),
      )
    )
      unfinished("Fixture creation needs a settled outcome and confirmed client/backend stop");
    return {
      disposition: "retained_for_inspection",
      workspaceIds: workspaces.map((workspace) => workspace.workspace_id),
      workspaceDisposalIds: this.workspaceDisposals
        .records(runId)
        .map((record) => record.disposalId),
      workspaceOperationIds: (
        this.db
          .prepare(
            "SELECT operation_id FROM workspace_operations WHERE run_id=? ORDER BY operation_id",
          )
          .all(runId) as { operation_id: string }[]
      ).map((entry) => entry.operation_id),
      agentAssignmentIds: agents.map((agent) => agent.assignmentId).sort(),
      publicationIds: this.publications
        .records(runId)
        .map((record) => record.publicationId)
        .sort(),
      fixtureCreationIds: fixtures
        .filter((fixture) => fixture.status === "owned")
        .map((fixture) => fixture.creationId)
        .sort(),
      fixtureAccessIds: this.fixtures.validation
        .uses(runId)
        .map((use) => use.accessId)
        .sort(),
      trackerExportIds: this.tracker
        .operations(runId)
        .filter((entry) => entry.kind === "export")
        .map((entry) => entry.trackerOperationId)
        .sort(),
      detail:
        "All recorded work is stopped. Managed workspaces and their operation/complete-worker stop records, agent sessions, publication artifacts, tracker export copies, owned fixtures and fixture-command control/stop evidence are retained for inspection; no resource deletion or pane closure was performed.",
    };
  }

  runObjective(runId: string) {
    const row = this.db.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(runId) as
      { state_json: string } | undefined;
    const state = RunStateSchema.parse(row ? JSON.parse(row.state_json) : null);
    if (state.runId !== runId) throw new Error("Run identity mismatch");
    return {
      epicId: state.epicId,
      title: state.epicTitle,
      baselineRevision: state.epicBaseRevision,
      runtime: state.runtime,
    };
  }

  /** Creation is part of the parent StateStore.create transaction. */
  initialize(runId: string, policyInput: RepositoryPolicy, taskCount: number): void {
    if (!this.db.inTransaction)
      throw new Error("Adaptive initialization requires a creation transaction");
    const policy = RepositoryPolicySchema.parse(policyInput);
    const row = this.db.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(runId) as
      { state_json: string } | undefined;
    const state = RunStateSchema.parse(row ? JSON.parse(row.state_json) : null);
    if (state.runId !== runId) throw new Error("Run identity mismatch");
    const maxDecisions = policy.budgets.epicDecisions + policy.budgets.taskDecisions * taskCount;
    if (!Number.isSafeInteger(maxDecisions) || maxDecisions <= 0)
      throw new Error("Invalid adaptive decision budget");
    this.db
      .prepare(
        `INSERT INTO orchestration_runs(run_id, control_version, policy_digest, policy_json, status, max_decisions)
      VALUES (?, 0, ?, ?, 'active', ?)`,
      )
      .run(runId, digestJson(policy), JSON.stringify(policy), maxDecisions);
    // Configured delivery runs require tracker claims from their first action,
    // before the model chooses when to refresh the graph.
    if (state.runtimeConfiguration !== null)
      this.db.prepare("INSERT INTO tracker_roots VALUES (?, NULL)").run(runId);
  }

  /** One synchronous, immutable read view. Never carries eligibility across an action boundary. */
  readSnapshot<T>(read: () => T): T {
    this.assertStorage();
    const previous = this.db.pragma("query_only", { simple: true });
    try {
      this.db.pragma("query_only = ON");
      return this.db.transaction(() => this.agents.withReadSnapshot(read))();
    } finally {
      this.db.pragma(previous === 1 ? "query_only = ON" : "query_only = OFF");
    }
  }

  /** A fixed trusted worker attaches this exact existing file; it cannot initialize or adopt state. */
  storageIdentity() {
    return this.assertStorage();
  }

  control(runId: string): ControlState {
    const row = this.db.prepare("SELECT * FROM orchestration_runs WHERE run_id = ?").get(runId) as
      ControlRow | undefined;
    if (!row) throw new Error(`Run ${runId} has no adaptive control record`);
    return ControlStateSchema.parse({
      runId: row.run_id,
      controlVersion: row.control_version,
      policyDigest: row.policy_digest,
      status: row.status,
      observationCursor: row.observation_cursor,
      decisionsUsed: row.decisions_used,
      maxDecisions: row.max_decisions,
    });
  }

  policy(runId: string): RepositoryPolicy {
    const row = this.db
      .prepare("SELECT policy_digest, policy_json FROM orchestration_runs WHERE run_id = ?")
      .get(runId) as Pick<ControlRow, "policy_digest" | "policy_json"> | undefined;
    if (!row) throw new Error("Missing adaptive policy");
    const policy = RepositoryPolicySchema.parse(JSON.parse(row.policy_json));
    if (digestJson(policy) !== row.policy_digest)
      throw new Error("Frozen policy digest does not match its contents");
    return policy;
  }

  assertAuthority(authority: ControllerAuthority): void {
    this.assertStorage();
    const row = this.db
      .prepare(
        `SELECT runs.state_json FROM run_leases JOIN runs USING(run_id)
      WHERE run_id = ? AND owner_token = ? AND lease_id = ?`,
      )
      .get(authority.runId, authority.ownerToken, authority.leaseId) as
      { state_json: string } | undefined;
    if (!row) throw new Error("Adaptive controller lease was lost or replaced");
    const state = RunStateSchema.parse(JSON.parse(row.state_json));
    if (state.runId !== authority.runId) throw new Error("Run identity mismatch");
    this.policy(authority.runId);
  }

  private transaction<T>(authority: ControllerAuthority, body: () => T): T {
    return this.db
      .transaction(() => {
        this.assertAuthority(authority);
        return body();
      })
      .immediate();
  }

  pendingDecision(runId: string): DecisionTicket | null {
    const row = this.db
      .prepare("SELECT * FROM decisions WHERE run_id = ? AND status = 'pending'")
      .get(runId) as DecisionRow | undefined;
    return row ? ticket(row) : null;
  }

  beginDecision(
    authority: ControllerAuthority,
    observationCursor: number,
    expectedControlVersion: number,
  ): DecisionTicket {
    return this.transaction(authority, () => {
      const control = this.control(authority.runId);
      if (control.status !== "active")
        throw new Error(`Run is ${control.status}; no new decisions may start`);
      if (control.controlVersion !== expectedControlVersion)
        throw new Error("Stale control version");
      const maximum = this.latestObservationCursor(authority.runId);
      if (
        !Number.isSafeInteger(observationCursor) ||
        observationCursor < control.observationCursor ||
        observationCursor > maximum
      )
        throw new Error("Invalid decision observation cursor");
      const pending = this.db
        .prepare("SELECT * FROM decisions WHERE run_id = ? AND status = 'pending'")
        .get(authority.runId) as DecisionRow | undefined;
      if (
        pending &&
        pending.control_version === expectedControlVersion &&
        pending.observation_cursor === observationCursor &&
        pending.policy_digest === control.policyDigest
      )
        return ticket(pending);
      if (pending)
        this.db
          .prepare("UPDATE decisions SET status = 'cancelled' WHERE decision_id = ?")
          .run(pending.decision_id);
      if (control.decisionsUsed >= control.maxDecisions)
        throw new Error("Adaptive decision budget exhausted");
      const decisionId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO decisions(decision_id, run_id, observation_cursor, control_version, policy_digest, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          decisionId,
          authority.runId,
          observationCursor,
          expectedControlVersion,
          control.policyDigest,
          now(),
        );
      this.db
        .prepare(
          "UPDATE orchestration_runs SET decisions_used = decisions_used + 1 WHERE run_id = ?",
        )
        .run(authority.runId);
      this.audit(authority.runId, "orchestrator.decision_started", decisionId);
      return {
        decisionId,
        observationCursor,
        expectedControlVersion,
        policyDigest: control.policyDigest,
      };
    });
  }

  acceptAction(authority: ControllerAuthority, input: OrchestratorDecision): ActionAdmission {
    const decision = OrchestratorDecisionSchema.parse(input);
    const requestDigest = digestJson(decision.request);
    return this.transaction(authority, () => {
      const existing = this.db
        .prepare("SELECT * FROM actions WHERE run_id = ? AND decision_id = ?")
        .get(authority.runId, decision.request.decisionId) as ActionRow | undefined;
      if (existing) {
        if (existing.request_digest === requestDigest)
          return { kind: "replayed", action: actionRecord(existing) };
        return this.rejection(
          authority.runId,
          existing.action_id,
          "replay_mismatch",
          "The same decision ID cannot carry different arguments",
        );
      }
      const pending = this.db
        .prepare("SELECT * FROM decisions WHERE run_id = ? AND decision_id = ?")
        .get(authority.runId, decision.request.decisionId) as DecisionRow | undefined;
      const control = this.control(authority.runId);
      let denial: [string, string] | undefined;
      if (!pending || pending.status !== "pending")
        denial = [
          "unknown_decision",
          "Only the controller-issued pending decision may be accepted",
        ];
      else if (control.status !== "active") denial = ["run_not_active", `Run is ${control.status}`];
      else if (
        decision.request.expectedControlVersion !== pending.control_version ||
        pending.control_version !== control.controlVersion
      )
        denial = ["stale_control", "Control facts changed while the model was deciding"];
      else if (decision.request.observationCursor !== pending.observation_cursor)
        denial = [
          "wrong_cursor",
          "The decision must acknowledge exactly the issued observation cursor",
        ];
      else if (pending.policy_digest !== control.policyDigest)
        denial = ["stale_policy", "The effective policy changed"];
      else if (
        !concurrentWithPublication(decision.request.action.kind) &&
        !["request_publish_tracker", "reconcile_tracker_commit"].includes(
          decision.request.action.kind,
        ) &&
        this.trackerCommits.pending(authority.runId)
      )
        denial = [
          "tracker_commit_unsettled",
          "Settle and publish the pending tracker commit before further delivery mutations",
        ];
      else if (
        !concurrentWithPublication(decision.request.action.kind) &&
        this.publications.pending(authority.runId)
      )
        denial = [
          "publication_unsettled",
          "Publication I/O/evidence must settle before further mutations",
        ];
      else if (
        !concurrentWithTracker(decision.request.action.kind) &&
        this.tracker.pending(authority.runId)
      )
        denial = ["tracker_unsettled", "Reconcile tracker I/O/evidence before further mutations"];
      const actionId = randomUUID();
      if (!pending) return this.rejection(authority.runId, actionId, denial![0], denial![1]);
      // A cancelled/settled ticket cannot be repurposed, even when it never created an action.
      if (pending.status !== "pending")
        return this.rejection(authority.runId, actionId, denial![0], denial![1]);
      const result = denial
        ? { status: "rejected" as const, actionId, code: denial[0], detail: denial[1] }
        : null;
      const at = now();
      this.db
        .prepare(
          `INSERT INTO actions(action_id, run_id, decision_id, operation_id, policy_digest, request_json, request_digest, status, result_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          actionId,
          authority.runId,
          pending.decision_id,
          randomUUID(),
          pending.policy_digest,
          JSON.stringify(decision.request),
          requestDigest,
          denial ? "rejected" : "accepted",
          result ? JSON.stringify(result) : null,
          at,
          at,
        );
      this.db
        .prepare("UPDATE decisions SET status = ?, decision_json = ? WHERE decision_id = ?")
        .run(denial ? "rejected" : "accepted", JSON.stringify(decision), pending.decision_id);
      if (!denial)
        this.db
          .prepare("UPDATE orchestration_runs SET observation_cursor = ? WHERE run_id = ?")
          .run(pending.observation_cursor, authority.runId);
      this.audit(
        authority.runId,
        denial ? "action.rejected" : "action.accepted",
        `${actionId}: ${decision.request.action.kind}${denial ? ` (${denial[0]})` : ""}`,
      );
      if (result) return { kind: "rejected", result };
      return { kind: "accepted", action: this.action(authority.runId, actionId)! };
    });
  }

  rejectDecision(authority: ControllerAuthority, decisionId: string, detail: string): void {
    this.transaction(authority, () => {
      const result = this.db
        .prepare(
          "UPDATE decisions SET status = 'rejected' WHERE run_id = ? AND decision_id = ? AND status = 'pending'",
        )
        .run(authority.runId, decisionId);
      if (result.changes !== 1) throw new Error("Decision is no longer pending");
      this.appendObservation(authority, {
        source: "kernel",
        sourceEventId: `invalid-decision:${decisionId}`,
        kind: "orchestrator.invalid_output",
        summary: redactSensitiveText(detail, 7999),
        artifactIds: [],
        identity: null,
        wakesOrchestrator: true,
      });
    });
  }

  startAction(authority: ControllerAuthority, actionId: string): ActionRecord {
    return this.transaction(authority, () => {
      const action = this.requiredAction(authority.runId, actionId);
      const control = this.control(authority.runId);
      if (action.status !== "accepted")
        throw new DispatchConflictError("Only an accepted action can start");
      if (
        control.status !== "active" ||
        action.policyDigest !== control.policyDigest ||
        action.request.expectedControlVersion !== control.controlVersion
      )
        throw new DispatchConflictError("Action admission is stale before dispatch");
      this.db
        .prepare(
          "UPDATE actions SET status = 'running', updated_at = ? WHERE action_id = ? AND status = 'accepted'",
        )
        .run(now(), actionId);
      this.audit(authority.runId, "action.started", actionId);
      return this.requiredAction(authority.runId, actionId);
    });
  }

  settleAction(
    authority: ControllerAuthority,
    actionId: string,
    expectedStatus: "running" | "indeterminate",
    resultInput: ActionResult,
  ): ActionRecord {
    const result = ActionResultSchema.parse(resultInput);
    if (result.actionId !== actionId || result.status === "running")
      throw new Error("Expected a terminal result for this action");
    return this.transaction(authority, () => {
      const action = this.requiredAction(authority.runId, actionId);
      if (action.status !== expectedStatus)
        throw new Error("Action state changed before settlement");
      if (
        action.policyDigest !== this.control(authority.runId).policyDigest &&
        result.status === "succeeded"
      )
        throw new Error("Superseded policy cannot authorize successful settlement");
      if (
        action.request.action.kind === "reconcile_tracker_operation" &&
        result.status === "succeeded"
      ) {
        const completion = this.tracker.record(
          authority.runId,
          action.request.action.trackerOperationId,
        );
        if (
          completion.kind === "complete" &&
          completion.completion &&
          completion.outcome === null
        ) {
          if (
            result.result.kind !== "resource" ||
            result.result.resourceId !== completion.trackerOperationId ||
            result.result.generation !== 1
          )
            throw new Error("Reconciliation result does not identify its terminal inspection");
          const parent = this.requiredAction(authority.runId, completion.actionId);
          if (parent.status !== "running" && parent.status !== "indeterminate")
            throw new Error("Completion's parent action is not awaiting settlement");
          this.settleAction(authority, parent.actionId, parent.status, {
            status: "succeeded",
            actionId: parent.actionId,
            result: result.result,
          });
        }
      }
      if (action.request.action.kind === "complete_run" && result.status === "succeeded") {
        const completion = this.tracker
          .operations(authority.runId)
          .find((record) => record.actionId === actionId);
        if (
          !completion ||
          result.result.kind !== "resource" ||
          result.result.generation !== 1 ||
          result.result.resourceId !== completion.trackerOperationId
        )
          throw new Error("Completion result does not identify its exact terminal inspection");
        // A crash may have interrupted the read-only reconciliation action too.
        // Discard its lost acknowledgement in this transaction; the parent's
        // fresh stopped inspection, not the interrupted reader, proves completion.
        for (const reconciler of this.actions(authority.runId)) {
          if (
            reconciler.status === "indeterminate" &&
            reconciler.request.action.kind === "reconcile_tracker_operation" &&
            reconciler.request.action.trackerOperationId === completion.trackerOperationId
          ) {
            this.settleAction(authority, reconciler.actionId, "indeterminate", {
              status: "failed",
              actionId: reconciler.actionId,
              problemId: `interrupted-reader-${reconciler.actionId}`,
            });
          }
        }
        this.tracker.complete(authority, actionId);
        this.db
          .prepare(
            "UPDATE orchestration_runs SET status = 'complete', control_version = control_version + 1 WHERE run_id = ?",
          )
          .run(authority.runId);
        const completedAt = now();
        this.db
          .prepare(
            "UPDATE runs SET phase = 'complete', updated_at = ?, state_json = json_set(state_json, '$.updatedAt', ?) WHERE run_id = ?",
          )
          .run(completedAt, completedAt, authority.runId);
      }
      this.db
        .prepare(
          "UPDATE actions SET status = ?, result_json = ?, updated_at = ? WHERE action_id = ? AND status = ?",
        )
        .run(result.status, JSON.stringify(result), now(), actionId, expectedStatus);
      this.audit(authority.runId, `action.${result.status}`, actionId);
      this.appendObservation(authority, {
        source: "kernel",
        sourceEventId: `${actionId}:${expectedStatus}:${result.status}`,
        kind: `action.${result.status}`,
        summary: `${action.request.action.kind}: ${result.status} (action ${actionId})`,
        artifactIds: [],
        identity: null,
        wakesOrchestrator: ![
          "wait_for_events",
          "record_memory",
          "inspect_run",
          "inspect_action",
          "inspect_record",
          "inspect_observation",
          "inspect_repo",
          "inspect_agent",
          "inspect_artifact",
          "inspect_fixture",
          "inspect_fixture_access",
        ].includes(action.request.action.kind),
      });
      return this.requiredAction(authority.runId, actionId);
    });
  }

  /** SQLite-only capabilities commit their mutation, result, and observations together. */
  executeLocalAction(
    authority: ControllerAuthority,
    actionId: string,
    effect: () => ActionPayload,
  ): ActionRecord {
    return this.transaction(authority, () => {
      this.startAction(authority, actionId);
      return this.settleAction(authority, actionId, "running", {
        status: "succeeded",
        actionId,
        result: effect(),
      });
    });
  }

  rejectAcceptedAction(
    authority: ControllerAuthority,
    actionId: string,
    code: string,
    detail: string,
  ): ActionResult {
    return this.transaction(authority, () => {
      const action = this.requiredAction(authority.runId, actionId);
      if (action.status !== "accepted")
        throw new DispatchConflictError("Only an accepted intent may be rejected before dispatch");
      const result = ActionResultSchema.parse({
        status: "rejected",
        actionId,
        code,
        detail: redactSensitiveText(detail, 7999),
      });
      this.db
        .prepare(
          "UPDATE actions SET status = 'rejected', result_json = ?, updated_at = ? WHERE action_id = ?",
        )
        .run(JSON.stringify(result), now(), actionId);
      this.audit(authority.runId, "action.rejected", `${actionId}: ${code}`);
      return result;
    });
  }

  /** Running external effects are uncertain after handoff. Reconciliation, not replay, follows. */
  markInterruptedActions(authority: ControllerAuthority): ActionRecord[] {
    return this.transaction(authority, () => {
      const running = this.actions(authority.runId).filter((action) => action.status === "running");
      return running.map((action) =>
        this.settleAction(authority, action.actionId, "running", {
          status: "indeterminate",
          actionId: action.actionId,
          problemId: `recovery-${action.actionId}`,
        }),
      );
    });
  }

  action(runId: string, actionId: string): ActionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM actions WHERE run_id = ? AND action_id = ?")
      .get(runId, actionId) as ActionRow | undefined;
    return row ? actionRecord(row) : null;
  }
  actionForOperation(runId: string, operationId: string): ActionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM actions WHERE run_id = ? AND operation_id = ?")
      .get(runId, operationId) as ActionRow | undefined;
    return row ? actionRecord(row) : null;
  }
  actions(runId: string): ActionRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM actions WHERE run_id = ? ORDER BY created_at, rowid")
        .all(runId) as ActionRow[]
    ).map(actionRecord);
  }
  private requiredAction(runId: string, actionId: string): ActionRecord {
    const action = this.action(runId, actionId);
    if (!action) throw new Error("Unknown action in this run");
    return action;
  }

  appendObservation(authority: ControllerAuthority, input: ObservationInput): Observation {
    return this.transaction(authority, () => this.recordObservation(authority.runId, input));
  }

  private recordObservation(runId: string, input: ObservationInput): Observation {
    const parsed = ObservationInputSchema.parse(input);
    if (parsed.identity && parsed.identity.runId !== runId)
      throw new Error("Observation belongs to a different run");
    {
      const previous = this.db
        .prepare(
          "SELECT * FROM observations WHERE run_id = ? AND source = ? AND source_event_id = ?",
        )
        .get(runId, parsed.source, parsed.sourceEventId) as ObservationRow | undefined;
      if (previous) {
        if (previous.input_digest !== digestJson(parsed))
          throw new Error("Observation source ID was reused with different content");
        return observationRecord(previous);
      }
      const at = now();
      const value = { ...parsed, summary: redactSensitiveText(parsed.summary, 7999) };
      const row = this.db
        .prepare(
          `INSERT INTO observations(run_id, source, source_event_id, input_digest, observation_json, at, wakes)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          parsed.source,
          parsed.sourceEventId,
          digestJson(parsed),
          JSON.stringify(value),
          at,
          parsed.wakesOrchestrator ? 1 : 0,
        );
      return ObservationSchema.parse({ ...value, id: Number(row.lastInsertRowid), at });
    }
  }

  observations(runId: string, afterCursor = 0, limit = 100, wakeOnly = false): Observation[] {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isSafeInteger(afterCursor) ||
      afterCursor < 0
    )
      throw new Error("Invalid observation range");
    return (
      this.db
        .prepare(
          `SELECT * FROM observations WHERE run_id = ? AND id > ? ${wakeOnly ? "AND wakes = 1" : ""} ORDER BY id LIMIT ?`,
        )
        .all(runId, afterCursor, limit) as ObservationRow[]
    ).map(observationRecord);
  }
  latestObservationCursor(runId: string): number {
    return (
      this.db
        .prepare("SELECT COALESCE(MAX(id), 0) AS cursor FROM observations WHERE run_id = ?")
        .get(runId) as { cursor: number }
    ).cursor;
  }

  recordMemory(authority: ControllerAuthority, input: MemoryInput): MemoryEntry {
    const entry = MemoryInputSchema.parse(input);
    return this.transaction(authority, () => {
      if (entry.scope === "task" && !entry.taskId)
        throw new MemoryReferenceError("Task memory requires a task identity");
      if (
        entry.confidence === "observed" &&
        !entry.observationIds.length &&
        !entry.evidenceIds.length
      )
        throw new MemoryReferenceError("Observed memory requires evidence");
      for (const id of entry.observationIds)
        if (
          !this.db
            .prepare("SELECT 1 FROM observations WHERE run_id = ? AND id = ?")
            .get(authority.runId, id)
        )
          throw new MemoryReferenceError("Memory cites an observation outside this run");
      for (const id of entry.evidenceIds) {
        try {
          let settled;
          try {
            settled = this.delivery.validationIO(authority.runId, id).settled;
          } catch (error) {
            if (!(error instanceof DeliveryError)) throw error;
            settled = this.reviews.evidence(authority.runId, id).status === "finished";
          }
          if (entry.confidence === "observed" && !settled)
            throw new MemoryReferenceError(
              "Observed memory cannot cite an unfinished evidence intent as an outcome",
            );
        } catch (error) {
          if (error instanceof DeliveryError)
            throw new MemoryReferenceError("Memory references unregistered evidence");
          throw error;
        }
      }
      if (
        entry.supersedes &&
        !this.db
          .prepare(
            "SELECT 1 FROM memory_entries WHERE run_id = ? AND memory_id = ? AND superseded_by IS NULL",
          )
          .get(authority.runId, entry.supersedes)
      )
        throw new MemoryReferenceError("Memory supersession is stale or belongs to another run");
      const memoryId = randomUUID();
      const createdAt = now();
      const safe = { ...entry, content: redactSensitiveText(entry.content, 7999) };
      this.db
        .prepare(
          "INSERT INTO memory_entries(memory_id, run_id, entry_json, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(memoryId, authority.runId, JSON.stringify(safe), createdAt);
      if (entry.supersedes)
        this.db
          .prepare("UPDATE memory_entries SET superseded_by = ? WHERE memory_id = ?")
          .run(memoryId, entry.supersedes);
      this.audit(authority.runId, "memory.recorded", `${memoryId}: ${entry.kind}`);
      return { ...safe, memoryId, createdAt, supersededBy: null };
    });
  }

  memory(runId: string, includeSuperseded = false): MemoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_entries WHERE run_id = ? ${includeSuperseded ? "" : "AND superseded_by IS NULL"} ORDER BY created_at, rowid`,
      )
      .all(runId) as {
      memory_id: string;
      entry_json: string;
      created_at: string;
      superseded_by: string | null;
    }[];
    return rows.map((row) => ({
      ...MemoryInputSchema.parse(JSON.parse(row.entry_json)),
      memoryId: row.memory_id,
      createdAt: row.created_at,
      supersededBy: row.superseded_by,
    }));
  }

  setEscalation(
    authority: ControllerAuthority,
    question: string,
    reason: string,
    evidenceIds: string[],
  ): string {
    return this.transaction(authority, () => {
      const escalationId = randomUUID();
      this.db
        .prepare(
          "UPDATE escalations SET status = 'superseded' WHERE run_id = ? AND status = 'pending'",
        )
        .run(authority.runId);
      this.db
        .prepare(
          "INSERT INTO escalations(escalation_id, run_id, question, reason, evidence_ids_json, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
        )
        .run(
          escalationId,
          authority.runId,
          redactSensitiveText(question),
          reason,
          JSON.stringify(evidenceIds),
          now(),
        );
      this.changeStatus(authority, "awaiting_user");
      this.audit(
        authority.runId,
        "orchestrator.escalated",
        `${escalationId}: ${redactSensitiveText(question)}`,
      );
      return escalationId;
    });
  }

  changeStatus(
    authority: ControllerAuthority,
    status: Exclude<ControlState["status"], "complete">,
  ): void {
    if (!["active", "paused", "awaiting_user", "blocked"].includes(status))
      throw new Error("Completion requires the delivery proof path");
    this.transaction(authority, () => {
      if (this.control(authority.runId).status === "complete")
        throw new Error("A completed run cannot resume delivery");
      this.db
        .prepare(
          "UPDATE orchestration_runs SET status = ?, control_version = control_version + 1 WHERE run_id = ?",
        )
        .run(status, authority.runId);
      this.audit(authority.runId, "orchestrator.status_changed", status);
    });
  }

  pendingEscalation(runId: string) {
    const row = this.db
      .prepare(
        "SELECT escalation_id, question, reason, created_at FROM escalations WHERE run_id = ? AND status = 'pending'",
      )
      .get(runId) as
      { escalation_id: string; question: string; reason: string; created_at: string } | undefined;
    return row
      ? {
          escalationId: row.escalation_id,
          question: row.question,
          reason: row.reason,
          createdAt: row.created_at,
        }
      : null;
  }

  /** Trusted CLI/TUI operator boundary. Agents never receive access to this database API. */
  operatorControl(
    runId: string,
    expectedVersion: number,
    command:
      | { kind: "pause" }
      | { kind: "resume" }
      | { kind: "respond"; escalationId: string; message: string },
  ): ControlState {
    return this.db
      .transaction(() => {
        const control = this.control(runId);
        if (control.controlVersion !== expectedVersion)
          throw new Error("Control changed; inspect the run before retrying");
        if (control.status === "complete")
          throw new Error("A completed run cannot resume delivery");
        const pending = this.pendingEscalation(runId);
        if (command.kind === "resume" && (control.status !== "paused" || pending))
          throw new Error(
            "Only a paused run without a pending question can resume; respond to its exact escalation first",
          );
        if (command.kind === "respond") {
          if (!pending || pending.escalationId !== command.escalationId)
            throw new Error("Escalation changed; inspect the pending question before responding");
          if (!command.message.trim() || Buffer.byteLength(command.message) > 7000)
            throw new Error("Response must contain 1–7000 bytes");
          const message = redactSensitiveText(command.message, 7000);
          this.db
            .prepare(
              "UPDATE escalations SET status = 'answered', response = ?, answered_at = ? WHERE run_id = ? AND escalation_id = ? AND status = 'pending'",
            )
            .run(message, now(), runId, command.escalationId);
          this.recordObservation(runId, {
            source: "operator",
            sourceEventId: randomUUID(),
            kind: "operator.response",
            identity: null,
            summary: `Response to ${command.escalationId}: ${message}\nAuthority: instruction only; no environment or destructive-action grant.`,
            artifactIds: [],
            wakesOrchestrator: true,
          });
        }
        const status = command.kind === "pause" ? "paused" : "active";
        this.db
          .prepare(
            "UPDATE orchestration_runs SET status = ?, control_version = control_version + 1 WHERE run_id = ?",
          )
          .run(status, runId);
        this.audit(runId, `operator.${command.kind}`, status);
        return this.control(runId);
      })
      .immediate();
  }

  /** Called only inside an already-authorized StateStore settings transaction. */
  noteSettingsChange(runId: string): void {
    if (!this.db.inTransaction) throw new Error("Settings control changes must be transactional");
    this.db
      .prepare(
        "UPDATE orchestration_runs SET control_version = control_version + 1 WHERE run_id = ?",
      )
      .run(runId);
  }

  /** Explicit operator handoff, never an agent-selected runtime fallback. */
  handoffRuntime(
    authority: ControllerAuthority,
    expectedVersion: number,
    target: RuntimeHandoffTarget,
  ) {
    return this.transaction(authority, () =>
      commitRuntimeHandoff(this.db, this, authority, expectedVersion, target),
    );
  }

  preserveQuarantine(runId: string): void {
    if (!this.db.inTransaction)
      throw new Error("Quarantine must be atomic with raw run preservation");
    for (const table of ORCHESTRATION_TABLES) {
      const rows = this.db.prepare(`SELECT * FROM ${table} WHERE run_id = ?`).all(runId);
      for (const row of rows)
        this.db
          .prepare(
            "INSERT INTO quarantined_orchestration(run_id, source_table, row_json) VALUES (?, ?, ?)",
          )
          .run(runId, table, JSON.stringify(row));
    }
  }

  private rejection(
    runId: string,
    actionId: string,
    code: string,
    detail: string,
  ): Extract<ActionAdmission, { kind: "rejected" }> {
    this.audit(runId, "action.rejected", `${actionId}: ${code}`);
    return { kind: "rejected", result: { status: "rejected", actionId, code, detail } };
  }
  private audit(runId: string, kind: string, message: string): void {
    this.db
      .prepare(
        "INSERT INTO events(run_id, at, level, kind, message, detail) VALUES (?, ?, 'info', ?, ?, NULL)",
      )
      .run(runId, now(), kind, redactSensitiveText(message));
  }
}

function now(): string {
  return new Date().toISOString();
}
function ticket(row: DecisionRow): DecisionTicket {
  return {
    decisionId: row.decision_id,
    observationCursor: row.observation_cursor,
    expectedControlVersion: row.control_version,
    policyDigest: row.policy_digest,
  };
}
function actionRecord(row: ActionRow): ActionRecord {
  if (digestJson(JSON.parse(row.request_json)) !== row.request_digest)
    throw new Error("Stored action request digest mismatch");
  const result = row.result_json ? ActionResultSchema.parse(JSON.parse(row.result_json)) : null;
  if (
    result
      ? result.actionId !== row.action_id || result.status !== row.status
      : !["accepted", "running"].includes(row.status)
  )
    throw new Error("Stored action result does not match its identity or terminal status");
  return ActionRecordSchema.parse({
    actionId: row.action_id,
    operationId: row.operation_id,
    runId: row.run_id,
    decisionId: row.decision_id,
    policyDigest: row.policy_digest,
    request: JSON.parse(row.request_json),
    requestDigest: row.request_digest,
    status: row.status,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
function observationRecord(row: ObservationRow): Observation {
  return ObservationSchema.parse({ ...JSON.parse(row.observation_json), id: row.id, at: row.at });
}
