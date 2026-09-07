import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  CandidateRecordSchema,
  CandidateWorkspaceSchema,
  ValidationEvidenceSchema,
  ValidationOutcomeSchema,
  ValidationPlanSchema,
  type CandidateIdentity,
  type CandidateRecord,
  type CandidateWorkspace,
  type ValidationEvidence,
  type ValidationOutcome,
  type ValidationPlan,
  ValidationServiceRuntimeSchema,
  type ValidationServiceRuntime,
} from "../domain/delivery.js";
import { WorkspaceSnapshotSchema, type WorkspaceSnapshot } from "../domain/workspaces.js";
import type { WorkspaceIdentity } from "../domain/agents.js";
import type {
  ActionRecord,
  ControllerAuthority,
  ControlState,
  KernelAction,
  ObservationInput,
} from "../domain/orchestration.js";
import {
  digestJson,
  RequiredCheckSchema,
  type RepositoryPolicy,
} from "../domain/repository-policy.js";
import type { AgentJournal } from "./agent-journal.js";
import { redactSensitiveText } from "../util/redact.js";
import type { CommitRecord } from "../domain/commits.js";

export const DELIVERY_TABLES = [
  "validation_plans",
  "candidates",
  "candidate_workspaces",
  "validation_evidence",
] as const;
export function createDeliverySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS validation_plans (
      plan_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL UNIQUE REFERENCES actions(operation_id), task_id TEXT NOT NULL, generation INTEGER NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(run_id, plan_id), UNIQUE(run_id, task_id, generation),
      CHECK(json_extract(record_json, '$.planId') = plan_id AND json_extract(record_json, '$.runId') = run_id AND
        json_extract(record_json, '$.operationId') = operation_id AND json_extract(record_json, '$.taskId') = task_id AND
        json_extract(record_json, '$.generation') = generation)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS candidates (
      candidate_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL UNIQUE REFERENCES actions(operation_id), generation INTEGER NOT NULL, task_id TEXT NOT NULL,
      plan_id TEXT NOT NULL, workspace_id TEXT NOT NULL, workspace_generation INTEGER NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      UNIQUE(run_id, candidate_id, generation), UNIQUE(run_id, task_id, generation),
      FOREIGN KEY(run_id, plan_id) REFERENCES validation_plans(run_id, plan_id),
      FOREIGN KEY(run_id, workspace_id, workspace_generation) REFERENCES workspaces(run_id, workspace_id, generation),
      CHECK(json_extract(record_json, '$.candidateId') = candidate_id AND json_extract(record_json, '$.runId') = run_id AND
        json_extract(record_json, '$.operationId') = operation_id AND json_extract(record_json, '$.candidateGeneration') = generation AND
        json_extract(record_json, '$.taskId') = task_id AND json_extract(record_json, '$.validationPlanId') = plan_id AND
        json_extract(record_json, '$.workspaceId') = workspace_id AND json_extract(record_json, '$.workspaceGeneration') = workspace_generation)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_candidate ON candidates(run_id, task_id)
      WHERE json_extract(record_json, '$.status') = 'capturing';
    CREATE TABLE IF NOT EXISTS candidate_workspaces (
      workspace_id TEXT PRIMARY KEY, workspace_generation INTEGER NOT NULL,
      run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL UNIQUE REFERENCES actions(operation_id), candidate_id TEXT NOT NULL, candidate_generation INTEGER NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      FOREIGN KEY(run_id, workspace_id, workspace_generation) REFERENCES workspaces(run_id, workspace_id, generation),
      FOREIGN KEY(run_id, candidate_id, candidate_generation) REFERENCES candidates(run_id, candidate_id, generation),
      CHECK(json_extract(record_json, '$.workspaceId') = workspace_id AND json_extract(record_json, '$.workspaceGeneration') = workspace_generation AND
        json_extract(record_json, '$.runId') = run_id AND json_extract(record_json, '$.operationId') = operation_id AND
        json_extract(record_json, '$.candidateId') = candidate_id AND json_extract(record_json, '$.candidateGeneration') = candidate_generation)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS validation_evidence (
      evidence_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL UNIQUE REFERENCES actions(operation_id), workspace_operation_id TEXT NOT NULL UNIQUE REFERENCES workspace_operations(operation_id),
      candidate_id TEXT NOT NULL, candidate_generation INTEGER NOT NULL, plan_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, workspace_generation INTEGER NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      FOREIGN KEY(run_id, candidate_id, candidate_generation) REFERENCES candidates(run_id, candidate_id, generation),
      FOREIGN KEY(run_id, plan_id) REFERENCES validation_plans(run_id, plan_id),
      FOREIGN KEY(run_id, workspace_id, workspace_generation) REFERENCES workspaces(run_id, workspace_id, generation),
      CHECK(json_extract(record_json, '$.evidenceId') = evidence_id AND json_extract(record_json, '$.runId') = run_id AND
        json_extract(record_json, '$.operationId') = operation_id AND json_extract(record_json, '$.workspaceOperationId') = workspace_operation_id AND
        json_extract(record_json, '$.candidateId') = candidate_id AND json_extract(record_json, '$.candidateGeneration') = candidate_generation AND
        json_extract(record_json, '$.validationPlanId') = plan_id AND json_extract(record_json, '$.workspaceId') = workspace_id AND
        json_extract(record_json, '$.workspaceGeneration') = workspace_generation)
    ) STRICT;
  `);
}
type Access = {
  transaction<T>(authority: ControllerAuthority, body: () => T): T;
  control(runId: string): ControlState;
  policy(runId: string): RepositoryPolicy;
  action(runId: string, actionId: string): ActionRecord | null;
  observe(authority: ControllerAuthority, input: ObservationInput): unknown;
  agents: AgentJournal;
  reviewChecks(runId: string, taskId: string): z.infer<typeof RequiredCheckSchema>[];
  exactCommit(runId: string, candidate: CandidateIdentity, revision: string): CommitRecord;
  assertPublicationIdle(runId: string): void;
};
export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}
const now = () => new Date().toISOString();

/** Facts and prerequisite checks, never a scheduler or model-supplied approval surface. */
export class DeliveryJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly access: Access,
  ) {}

  definePlan(authority: ControllerAuthority, actionId: string): ValidationPlan {
    return this.access.transaction(authority, () => {
      this.access.assertPublicationIdle(authority.runId);
      const { record, action } = this.action(authority, actionId, "define_validation_plan");
      const prior = this.byOperation(
        ValidationPlanSchema,
        "validation_plans",
        authority.runId,
        record.operationId,
      );
      if (prior) return prior;
      const policy = this.access.policy(authority.runId);
      const checks = action.checks.map((check) => RequiredCheckSchema.parse(check));
      if (new Set(checks.map((check) => check.id)).size !== checks.length)
        throw new DeliveryError("duplicate_check", "Validation check IDs must be unique");
      const requirements = new Map<string, z.infer<typeof RequiredCheckSchema>>();
      for (const required of [
        ...policy.requiredChecks,
        ...this.access.reviewChecks(authority.runId, action.taskId),
      ]) {
        const previous = requirements.get(required.id);
        if (previous && digestJson({ ...previous, stage: required.stage }) !== digestJson(required))
          throw new DeliveryError(
            "review_check_conflict",
            `A different required command needs a new check ID: ${required.id}`,
          );
        requirements.set(
          required.id,
          previous && previous.stage !== required.stage ? { ...required, stage: "both" } : required,
        );
      }
      for (const required of requirements.values()) {
        const index = checks.findIndex((check) => check.id === required.id);
        if (index < 0) checks.push(required);
        else {
          if (digestJson({ ...checks[index], stage: required.stage }) !== digestJson(required))
            throw new DeliveryError(
              "required_check_changed",
              `Required check cannot be weakened or replaced: ${required.id}`,
            );
          checks[index] = required;
        }
      }
      const bindings = new Set([
        ...policy.fixtures.map((fixture) => fixture.environmentBinding),
        ...policy.validationServices.map((service) => service.id),
      ]);
      if (
        checks.some((check) => check.environmentBindings.some((binding) => !bindings.has(binding)))
      )
        throw new DeliveryError(
          "undeclared_binding",
          "Validation requests an undeclared environment binding",
        );
      const previous = this.latestPlan(authority.runId, action.taskId);
      const plan = ValidationPlanSchema.parse({
        schemaVersion: 1,
        runId: authority.runId,
        planId: randomUUID(),
        operationId: record.operationId,
        taskId: action.taskId,
        generation: (previous?.generation ?? 0) + 1,
        policyDigest: record.policyDigest,
        acceptanceCriteria: action.acceptanceCriteria.map((text) =>
          redactSensitiveText(text, 3999),
        ),
        checks,
        adequacy: "unreviewed",
        createdAt: now(),
      });
      if (Buffer.byteLength(JSON.stringify(plan)) > 32768)
        throw new DeliveryError(
          "plan_too_large",
          "Validation plan exceeds its 32 KiB inspection budget",
        );
      this.db
        .prepare("INSERT INTO validation_plans VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          plan.planId,
          authority.runId,
          plan.operationId,
          plan.taskId,
          plan.generation,
          JSON.stringify(plan),
        );
      this.changed(authority, "validation.plan_defined", plan.planId);
      return plan;
    });
  }

  reserveCandidate(authority: ControllerAuthority, actionId: string): CandidateRecord {
    return this.access.transaction(authority, () => {
      const { record, action } = this.action(authority, actionId, "capture_candidate");
      const previousOperation = this.byOperation(
        CandidateRecordSchema,
        "candidates",
        authority.runId,
        record.operationId,
      );
      if (previousOperation) return previousOperation; // Intent lookup, never permission to replay capture.
      const plan = this.plan(authority.runId, action.validationPlanId);
      if (
        plan.taskId !== action.taskId ||
        this.latestPlan(authority.runId, action.taskId)?.planId !== plan.planId
      )
        throw new DeliveryError(
          "stale_plan",
          "Capture requires this task's current validation plan",
        );
      const workspace = this.access.agents.workspace(authority.runId, action);
      if (
        workspace.purpose !== "implementation" ||
        workspace.sourceMode !== "mutable" ||
        workspace.status !== "ready" ||
        workspace.activeTurnId ||
        this.access.agents.activeWorkspaceOperation(authority.runId, workspace)
      )
        throw new DeliveryError(
          "candidate_workspace",
          "Candidate capture needs a stopped implementation workspace",
        );
      const agent = this.access.agents
        .instances(authority.runId)
        .find(
          (item) =>
            item.workspaceId === workspace.workspaceId &&
            item.workspaceGeneration === workspace.workspaceGeneration &&
            !["revoked", "released"].includes(item.status),
        );
      if (!agent)
        throw new DeliveryError(
          "candidate_assignment",
          "Candidate has no current implementation assignment",
        );
      const assignment = this.access.agents.assignment(authority.runId, agent.assignmentId);
      if (
        assignment.taskId !== action.taskId ||
        !["implementation", "epic_repair"].includes(assignment.purpose)
      )
        throw new DeliveryError(
          "candidate_assignment",
          "Candidate belongs to a different task or assignment purpose",
        );
      const previous = this.latestCandidate(authority.runId, action.taskId);
      const writers = this.taskWriters(authority.runId, action.taskId);
      if (writers.active)
        throw new DeliveryError(
          "task_writer_active",
          "Another writer for this task has not stopped",
        );
      if (previous?.status === "capturing")
        throw new DeliveryError(
          "capture_uncertain",
          "Reconcile the earlier candidate capture before creating another",
        );
      const candidate = CandidateRecordSchema.parse({
        schemaVersion: 1,
        runId: authority.runId,
        candidateId: randomUUID(),
        candidateGeneration: (previous?.candidateGeneration ?? 0) + 1,
        operationId: record.operationId,
        taskId: action.taskId,
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
        sourceAssignmentId: assignment.assignmentId,
        sourceTurnId: this.latestSourceTurn(authority.runId, assignment.assignmentId),
        taskWriterTurnCount: writers.count,
        validationPlanId: plan.planId,
        policyDigest: record.policyDigest,
        status: "capturing",
        snapshot: null,
        createdAt: now(),
        capturedAt: null,
        failure: null,
      });
      this.db
        .prepare("INSERT INTO candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          candidate.candidateId,
          authority.runId,
          record.operationId,
          candidate.candidateGeneration,
          candidate.taskId,
          plan.planId,
          workspace.workspaceId,
          workspace.workspaceGeneration,
          JSON.stringify(candidate),
        );
      this.changed(authority, "candidate.capture_reserved", candidate.candidateId);
      return candidate;
    });
  }

  finishCapture(
    authority: ControllerAuthority,
    identity: CandidateIdentity,
    input: WorkspaceSnapshot,
  ): CandidateRecord {
    return this.access.transaction(authority, () => {
      const candidate = this.candidate(authority.runId, identity);
      if (candidate.status === "failed")
        throw new DeliveryError("capture_failed", "A failed capture cannot be silently promoted");
      const snapshot = WorkspaceSnapshotSchema.parse(input);
      const workspace = this.access.agents.workspace(authority.runId, candidate);
      if (
        snapshot.runId !== authority.runId ||
        snapshot.workspaceId !== candidate.workspaceId ||
        snapshot.workspaceGeneration !== candidate.workspaceGeneration ||
        snapshot.parentRevision !== workspace.baselineRevision ||
        digestJson(snapshot.manifest) !== snapshot.fingerprint
      )
        throw new DeliveryError(
          "capture_mismatch",
          "Snapshot does not match its reserved source identity and fingerprint",
        );
      if (candidate.snapshot) {
        if (digestJson(candidate.snapshot) !== digestJson(snapshot))
          throw new DeliveryError(
            "capture_conflict",
            "Candidate identity already holds different bytes",
          );
        return candidate;
      }
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 32 * 1024 * 1024)
        throw new DeliveryError("manifest_too_large", "Candidate manifest exceeds 32 MiB");
      candidate.snapshot = snapshot;
      candidate.status = "captured";
      candidate.capturedAt = now();
      this.db
        .prepare("UPDATE candidates SET record_json = ? WHERE run_id = ? AND candidate_id = ?")
        .run(
          JSON.stringify(CandidateRecordSchema.parse(candidate)),
          authority.runId,
          candidate.candidateId,
        );
      this.changed(authority, "candidate.captured", candidate.candidateId);
      return candidate;
    });
  }

  failCapture(authority: ControllerAuthority, identity: CandidateIdentity, detail: string): void {
    this.access.transaction(authority, () => {
      const candidate = this.candidate(authority.runId, identity);
      if (candidate.status !== "capturing")
        throw new DeliveryError("capture_settled", "Capture already has a terminal outcome");
      candidate.status = "failed";
      candidate.failure = redactSensitiveText(detail, 3999);
      this.db
        .prepare("UPDATE candidates SET record_json = ? WHERE run_id = ? AND candidate_id = ?")
        .run(
          JSON.stringify(CandidateRecordSchema.parse(candidate)),
          authority.runId,
          candidate.candidateId,
        );
      this.changed(authority, "candidate.capture_failed", candidate.candidateId);
    });
  }

  bindReviewCopy(
    authority: ControllerAuthority,
    actionId: string,
    identity: WorkspaceIdentity,
  ): CandidateWorkspace {
    return this.access.transaction(authority, () => {
      const { record, action } = this.action(authority, actionId, "create_review_workspace", true);
      const candidate = this.candidate(authority.runId, action);
      const workspace = this.access.agents.workspace(authority.runId, identity);
      const snapshot = this.snapshotAtRevision(authority.runId, candidate, action.revision);
      if (
        !candidate.snapshot ||
        workspace.sourceMode !== "immutable" ||
        workspace.status !== "ready" ||
        workspace.purpose !== (action.revision === null ? "review" : "verification") ||
        workspace.creationOperationId !== record.operationId ||
        workspace.baselineRevision !== snapshot.snapshotRevision ||
        workspace.baselineFingerprint !== candidate.snapshot.fingerprint
      )
        throw new DeliveryError(
          "review_copy_mismatch",
          "Review workspace does not match its reserved candidate and creation action",
        );
      const existing = this.byOperation(
        CandidateWorkspaceSchema,
        "candidate_workspaces",
        authority.runId,
        record.operationId,
      );
      if (existing) {
        if (
          existing.workspaceId !== workspace.workspaceId ||
          existing.workspaceGeneration !== workspace.workspaceGeneration
        )
          throw new DeliveryError(
            "review_copy_conflict",
            "Review action already has a different workspace",
          );
        return existing;
      }
      const binding = CandidateWorkspaceSchema.parse({
        schemaVersion: 1,
        runId: authority.runId,
        operationId: record.operationId,
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
        candidateId: candidate.candidateId,
        candidateGeneration: candidate.candidateGeneration,
        revision: snapshot.snapshotRevision,
        phase: action.revision === null ? "pre_commit" : "exact_revision",
        createdAt: now(),
      });
      this.db
        .prepare("INSERT INTO candidate_workspaces VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          workspace.workspaceId,
          workspace.workspaceGeneration,
          authority.runId,
          record.operationId,
          candidate.candidateId,
          candidate.candidateGeneration,
          JSON.stringify(binding),
        );
      this.changed(authority, "candidate.review_workspace_ready", workspace.workspaceId);
      return binding;
    });
  }

  beginValidation(authority: ControllerAuthority, actionId: string): ValidationEvidence {
    return this.access.transaction(authority, () => {
      const { record, action } = this.action(authority, actionId, "run_validation");
      if (
        this.byOperation(
          ValidationEvidenceSchema,
          "validation_evidence",
          authority.runId,
          record.operationId,
        )
      )
        throw new DeliveryError(
          "validation_uncertain",
          "Validation already has an intent; inspect its outcome instead of launching again",
        );
      const candidate = this.candidate(authority.runId, action);
      const plan = this.plan(authority.runId, action.validationPlanId);
      const binding = this.binding(authority.runId, action);
      const workspace = this.access.agents.workspace(authority.runId, action);
      const snapshot = this.snapshotAtRevision(
        authority.runId,
        candidate,
        binding.phase === "pre_commit" ? null : binding.revision,
      );
      if (
        !candidate.snapshot ||
        candidate.validationPlanId !== plan.planId ||
        plan.taskId !== candidate.taskId ||
        binding.candidateId !== candidate.candidateId ||
        binding.candidateGeneration !== candidate.candidateGeneration ||
        workspace.sourceMode !== "immutable" ||
        workspace.baselineRevision !== snapshot.snapshotRevision ||
        binding.revision !== snapshot.snapshotRevision ||
        workspace.baselineFingerprint !== candidate.snapshot.fingerprint
      )
        throw new DeliveryError(
          "validation_target",
          "Validation target, plan, and candidate do not match",
        );
      const check = plan.checks.find((item) => item.id === action.checkId);
      if (!check || (check.stage !== "both" && check.stage !== binding.phase))
        throw new DeliveryError(
          "validation_stage",
          "This validation check is not required at the selected revision stage",
        );
      const services = this.access.policy(authority.runId).validationServices;
      if (check.environmentBindings.some((id) => !services.some((service) => service.id === id)))
        throw new DeliveryError(
          "fixture_bridge_unavailable",
          "Host fixture bindings cannot enter validation; declare a separate check-scoped service or configure a restricted bridge",
        );
      const exclusion = this.access.agents.beginWorkspaceOperation(
        authority,
        workspace,
        "validation",
        this.access.control(authority.runId).controlVersion,
      );
      const evidence = ValidationEvidenceSchema.parse({
        schemaVersion: 1,
        runId: authority.runId,
        evidenceId: randomUUID(),
        operationId: record.operationId,
        workspaceOperationId: exclusion.operationId,
        controllerLeaseId: authority.leaseId,
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
        candidateId: candidate.candidateId,
        candidateGeneration: candidate.candidateGeneration,
        validationPlanId: plan.planId,
        checkId: check.id,
        commandDigest: digestJson(check),
        policyDigest: record.policyDigest,
        phase: binding.phase,
        revision: snapshot.snapshotRevision,
        fingerprint: candidate.snapshot.fingerprint,
        confinementProfile: "bwrap-read-only-source-v1",
        environmentGenerations: check.environmentBindings.map((id) => ({
          bindingId: id,
          instanceId: randomUUID(),
          generation: 1,
          definitionDigest: digestJson(services.find((service) => service.id === id)!),
          runtime: null,
        })),
        environmentVerified: false,
        status: "running",
        outcome: null,
        sourceUnchanged: false,
        createdAt: now(),
      });
      this.db
        .prepare("INSERT INTO validation_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          evidence.evidenceId,
          authority.runId,
          evidence.operationId,
          evidence.workspaceOperationId,
          evidence.candidateId,
          evidence.candidateGeneration,
          plan.planId,
          workspace.workspaceId,
          workspace.workspaceGeneration,
          JSON.stringify(evidence),
        );
      this.changed(authority, "validation.started", evidence.evidenceId);
      return evidence;
    });
  }

  /** Freeze executable observations before setup/command dispatch; never accept model input. */
  bindValidationServices(
    authority: ControllerAuthority,
    evidenceId: string,
    inputs: readonly ValidationServiceRuntime[],
  ): ValidationEvidence {
    return this.access.transaction(authority, () => {
      const evidence = this.evidence(authority.runId, evidenceId),
        control = this.access.control(authority.runId);
      const action = this.db
        .prepare("SELECT status FROM actions WHERE run_id = ? AND operation_id = ?")
        .get(authority.runId, evidence.operationId) as { status: string } | undefined;
      if (
        evidence.status !== "running" ||
        action?.status !== "running" ||
        inputs.length === 0 ||
        evidence.controllerLeaseId !== authority.leaseId ||
        control.status !== "active" ||
        control.policyDigest !== evidence.policyDigest ||
        inputs.length !== evidence.environmentGenerations.length ||
        evidence.environmentGenerations.some((entry) => entry.runtime !== null)
      )
        throw new DeliveryError(
          "service_binding_stale",
          "Validation runtime binding is one-use and requires its active owner",
        );
      const definitions = this.access.policy(authority.runId).validationServices;
      evidence.environmentGenerations = evidence.environmentGenerations.map((entry, index) => {
        const definition = definitions.find((item) => item.id === entry.bindingId);
        const runtime = ValidationServiceRuntimeSchema.parse(inputs[index]);
        if (
          !definition ||
          digestJson(definition) !== entry.definitionDigest ||
          Object.entries(runtime).some(
            ([name, binary]) => binary.path !== `${definition.binDirectory}/${name}`,
          )
        )
          throw new DeliveryError(
            "service_binding_mismatch",
            "Validation service runtime differs from frozen policy",
          );
        return { ...entry, runtime };
      });
      this.db
        .prepare(
          "UPDATE validation_evidence SET record_json = ? WHERE run_id = ? AND evidence_id = ?",
        )
        .run(JSON.stringify(ValidationEvidenceSchema.parse(evidence)), authority.runId, evidenceId);
      this.changed(authority, "validation.services_bound", evidenceId);
      return evidence;
    });
  }

  /** Trusted supervisor callback; agent reports never call this method. */
  finishValidation(
    authority: ControllerAuthority,
    evidenceId: string,
    input: ValidationOutcome,
    sourceUnchanged: boolean,
    environmentVerified = false,
  ): ValidationEvidence {
    return this.access.transaction(authority, () => {
      const evidence = this.evidence(authority.runId, evidenceId);
      if (evidence.controllerLeaseId !== authority.leaseId)
        throw new DeliveryError(
          "validation_owner_changed",
          "Old validation requires independent process reconciliation",
        );
      const parsed = ValidationOutcomeSchema.parse(input);
      const verifiedEnvironment =
        evidence.environmentGenerations.length === 0 ||
        (environmentVerified &&
          evidence.environmentGenerations.every((entry) => entry.runtime !== null));
      const outcome = {
        ...parsed,
        stdout: redactSensitiveText(parsed.stdout, 65535),
        stderr: redactSensitiveText(parsed.stderr, 65535),
      };
      if (evidence.outcome) {
        if (
          digestJson(evidence.outcome) !== digestJson(outcome) ||
          evidence.sourceUnchanged !== sourceUnchanged ||
          evidence.environmentVerified !== verifiedEnvironment
        )
          throw new DeliveryError(
            "validation_outcome_conflict",
            "Validation already has a different recorded outcome",
          );
        return evidence;
      }
      evidence.outcome = outcome;
      evidence.sourceUnchanged = sourceUnchanged;
      evidence.environmentVerified = verifiedEnvironment;
      evidence.status = "finished";
      this.db
        .prepare(
          "UPDATE validation_evidence SET record_json = ? WHERE run_id = ? AND evidence_id = ?",
        )
        .run(JSON.stringify(ValidationEvidenceSchema.parse(evidence)), authority.runId, evidenceId);
      this.access.agents.finishWorkspaceOperation(
        authority,
        evidence.workspaceOperationId,
        outcome.status === "succeeded" && sourceUnchanged && verifiedEnvironment
          ? "succeeded"
          : "failed",
        outcome.status === "not_started"
          ? "Validation failed before a repository command started; all admission I/O and any failed supervisor spawn settled"
          : "Trusted validation adapter settled admission I/O and confirmed closure of every process handle it created",
      );
      this.changed(authority, `validation.${outcome.status}`, evidence.evidenceId);
      return evidence;
    });
  }

  plan(runId: string, planId: string): ValidationPlan {
    return this.read(
      ValidationPlanSchema,
      "SELECT record_json FROM validation_plans WHERE run_id = ? AND plan_id = ?",
      [runId, planId],
    );
  }
  candidate(runId: string, identity: CandidateIdentity): CandidateRecord {
    return this.read(
      CandidateRecordSchema,
      "SELECT record_json FROM candidates WHERE run_id = ? AND candidate_id = ? AND generation = ?",
      [runId, identity.candidateId, identity.candidateGeneration],
    );
  }
  binding(runId: string, identity: WorkspaceIdentity): CandidateWorkspace {
    return this.read(
      CandidateWorkspaceSchema,
      "SELECT record_json FROM candidate_workspaces WHERE run_id = ? AND workspace_id = ? AND workspace_generation = ?",
      [runId, identity.workspaceId, identity.workspaceGeneration],
    );
  }
  evidence(runId: string, evidenceId: string): ValidationEvidence {
    return this.read(
      ValidationEvidenceSchema,
      "SELECT record_json FROM validation_evidence WHERE run_id = ? AND evidence_id = ?",
      [runId, evidenceId],
    );
  }
  latestPlan(runId: string, taskId: string): ValidationPlan | null {
    return (
      this.all(
        ValidationPlanSchema,
        "SELECT record_json FROM validation_plans WHERE run_id = ? AND task_id = ? ORDER BY generation DESC LIMIT 1",
        [runId, taskId],
      )[0] ?? null
    );
  }
  latestCandidate(runId: string, taskId: string): CandidateRecord | null {
    return (
      this.all(
        CandidateRecordSchema,
        "SELECT record_json FROM candidates WHERE run_id = ? AND task_id = ? ORDER BY generation DESC LIMIT 1",
        [runId, taskId],
      )[0] ?? null
    );
  }
  candidateCurrent(runId: string, identity: CandidateIdentity): boolean {
    const candidate = this.candidate(runId, identity);
    const agent = this.access.agents
      .instances(runId)
      .find((item) => item.assignmentId === candidate.sourceAssignmentId);
    const writers = this.taskWriters(runId, candidate.taskId);
    return (
      candidate.status === "captured" &&
      this.latestCandidate(runId, candidate.taskId)?.candidateId === candidate.candidateId &&
      this.latestPlan(runId, candidate.taskId)?.planId === candidate.validationPlanId &&
      candidate.policyDigest === this.access.control(runId).policyDigest &&
      !!agent &&
      !writers.active &&
      writers.count === candidate.taskWriterTurnCount &&
      !agent.activeTurnId &&
      !["revoked", "released"].includes(agent.status) &&
      this.latestSourceTurn(runId, candidate.sourceAssignmentId) === candidate.sourceTurnId
    );
  }
  satisfiesCheck(runId: string, evidenceId: string): boolean {
    const evidence = this.evidence(runId, evidenceId);
    const candidate = this.candidate(runId, evidence);
    const check = this.plan(runId, evidence.validationPlanId).checks.find(
      (item) => item.id === evidence.checkId,
    );
    const latest = this.all(
      ValidationEvidenceSchema,
      "SELECT record_json FROM validation_evidence WHERE run_id = ? AND candidate_id = ? AND json_extract(record_json, '$.checkId') = ? AND json_extract(record_json, '$.phase') = ? AND json_extract(record_json, '$.revision') = ? ORDER BY rowid DESC LIMIT 1",
      [runId, evidence.candidateId, evidence.checkId, evidence.phase, evidence.revision],
    )[0];
    let revision: string;
    try {
      revision = this.snapshotAtRevision(
        runId,
        evidence,
        evidence.phase === "pre_commit" ? null : evidence.revision,
      ).snapshotRevision;
    } catch (error) {
      if (error instanceof DeliveryError) return false;
      throw error;
    }
    return (
      latest?.evidenceId === evidence.evidenceId &&
      this.candidateCurrent(runId, evidence) &&
      !!check &&
      digestJson(check) === evidence.commandDigest &&
      candidate.validationPlanId === evidence.validationPlanId &&
      revision === evidence.revision &&
      !!candidate.snapshot &&
      candidate.snapshot.fingerprint === evidence.fingerprint &&
      evidence.policyDigest === this.access.control(runId).policyDigest &&
      evidence.sourceUnchanged &&
      evidence.environmentVerified &&
      evidence.environmentGenerations.length === check.environmentBindings.length &&
      check.environmentBindings.every((binding) =>
        evidence.environmentGenerations.some((entry) => {
          const definition = this.access
            .policy(runId)
            .validationServices.find((service) => service.id === binding);
          return (
            entry.bindingId === binding &&
            entry.runtime !== null &&
            definition &&
            digestJson(definition) === entry.definitionDigest
          );
        }),
      ) &&
      evidence.outcome?.status === "succeeded" &&
      evidence.outcome.exitCode === 0 &&
      evidence.outcome.signal === null &&
      !evidence.outcome.outputTruncated
    );
  }
  summaries(runId: string) {
    return {
      plans: this.all(
        ValidationPlanSchema,
        "SELECT record_json FROM validation_plans WHERE run_id = ? ORDER BY rowid DESC LIMIT 10",
        [runId],
      ).map((plan) => ({
        planId: plan.planId,
        taskId: plan.taskId,
        generation: plan.generation,
        adequacy: plan.adequacy,
      })),
      candidates: this.all(
        CandidateRecordSchema,
        "SELECT record_json FROM candidates WHERE run_id = ? ORDER BY rowid DESC LIMIT 10",
        [runId],
      ).map((candidate) => ({
        candidateId: candidate.candidateId,
        candidateGeneration: candidate.candidateGeneration,
        taskId: candidate.taskId,
        status: candidate.status,
        validationPlanId: candidate.validationPlanId,
        current: this.candidateCurrent(runId, candidate),
      })),
      validation: this.all(
        ValidationEvidenceSchema,
        "SELECT record_json FROM validation_evidence WHERE run_id = ? ORDER BY rowid DESC LIMIT 10",
        [runId],
      ).map((evidence) => ({
        evidenceId: evidence.evidenceId,
        candidateId: evidence.candidateId,
        checkId: evidence.checkId,
        status: evidence.outcome?.status ?? "running",
        phase: evidence.phase,
        satisfiesCheck: this.satisfiesCheck(runId, evidence.evidenceId),
      })),
      approvalWarning:
        "Validation facts are not independent review approval or exact-commit verification",
    };
  }
  preCommitEvidence(runId: string, identity: CandidateIdentity) {
    return this.validationEvidence(runId, identity, "pre_commit");
  }
  validationEvidence(
    runId: string,
    identity: CandidateIdentity,
    phase: "pre_commit" | "exact_revision",
    revision?: string,
  ) {
    const candidate = this.candidate(runId, identity);
    const checks = this.plan(runId, candidate.validationPlanId).checks.filter(
      (check) => check.stage === "both" || check.stage === phase,
    );
    const records = this.all(
      ValidationEvidenceSchema,
      "SELECT record_json FROM validation_evidence WHERE run_id = ? AND candidate_id = ? ORDER BY rowid",
      [runId, candidate.candidateId],
    );
    const evidence = records.filter(
      (record) =>
        record.phase === phase &&
        (!revision || record.revision === revision) &&
        this.satisfiesCheck(runId, record.evidenceId),
    );
    return {
      evidence,
      missingCheckIds: checks
        .filter((check) => !evidence.some((record) => record.checkId === check.id))
        .map((check) => check.id),
    };
  }
  /** Physical copy target; an actual SHA must come from the kernel's created commit registry. */
  snapshotAtRevision(
    runId: string,
    identity: CandidateIdentity,
    revision: string | null,
  ): WorkspaceSnapshot {
    const candidate = this.candidate(runId, identity);
    if (!candidate.snapshot)
      throw new DeliveryError("candidate_not_captured", "Candidate has no immutable snapshot");
    if (revision === null) return candidate.snapshot;
    const commit = this.access.exactCommit(runId, identity, revision);
    if (
      commit.fullTree !== candidate.snapshot.fullTree ||
      commit.parentRevision !== candidate.snapshot.parentRevision ||
      commit.fingerprint !== candidate.snapshot.fingerprint
    )
      throw new DeliveryError(
        "commit_candidate_mismatch",
        "Commit registry does not match its candidate snapshot",
      );
    return { ...candidate.snapshot, snapshotRevision: revision };
  }
  private latestSourceTurn(runId: string, assignmentId: string): string | null {
    return (
      this.access.agents
        .turns(runId)
        .findLast((turn) => turn.identity.assignmentId === assignmentId)?.identity.turnId ?? null
    );
  }
  private taskWriters(runId: string, taskId: string) {
    const turns = this.access.agents
      .turns(runId)
      .filter(
        (turn) =>
          turn.prompt.assignment.taskId === taskId &&
          ["implementation", "epic_repair"].includes(turn.prompt.assignment.purpose),
      );
    return { count: turns.length, active: turns.some((turn) => turn.stopEvidence === null) };
  }
  private action<K extends KernelAction["kind"]>(
    authority: ControllerAuthority,
    actionId: string,
    kind: K,
    settling = false,
  ) {
    const record = this.access.action(authority.runId, actionId);
    const control = this.access.control(authority.runId);
    if (
      !record ||
      record.status !== "running" ||
      record.request.action.kind !== kind ||
      (!settling && control.status !== "active") ||
      record.policyDigest !== control.policyDigest
    )
      throw new DeliveryError(
        "delivery_action_stale",
        "Delivery operation requires its admitted current action",
      );
    return { record, action: record.request.action as Extract<KernelAction, { kind: K }> };
  }
  private changed(authority: ControllerAuthority, kind: string, summary: string): void {
    this.db
      .prepare(
        "UPDATE orchestration_runs SET control_version = control_version + 1 WHERE run_id = ?",
      )
      .run(authority.runId);
    this.access.observe(authority, {
      source: "delivery-journal",
      sourceEventId: randomUUID(),
      kind,
      summary,
      artifactIds: [],
      identity: null,
      wakesOrchestrator: true,
    });
    this.db
      .prepare(
        "INSERT INTO events(run_id, at, level, kind, message, detail) VALUES (?, ?, 'info', ?, ?, NULL)",
      )
      .run(authority.runId, now(), kind, summary);
  }
  private byOperation<T>(
    schema: z.ZodType<T>,
    table: (typeof DELIVERY_TABLES)[number],
    runId: string,
    operationId: string,
  ): T | null {
    return (
      this.all(schema, `SELECT record_json FROM ${table} WHERE run_id = ? AND operation_id = ?`, [
        runId,
        operationId,
      ])[0] ?? null
    );
  }
  private read<T>(schema: z.ZodType<T>, sql: string, args: (string | number)[]): T {
    const value = this.all(schema, sql, args)[0];
    if (!value)
      throw new DeliveryError(
        "unknown_delivery_record",
        "Delivery record is missing, stale, or belongs to another run",
      );
    return value;
  }
  private all<T>(schema: z.ZodType<T>, sql: string, args: (string | number)[]): T[] {
    return (this.db.prepare(sql).all(...args) as { record_json: string }[]).map((row) =>
      schema.parse(JSON.parse(row.record_json)),
    );
  }
}
