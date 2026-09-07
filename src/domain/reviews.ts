import { z } from "zod";
import { TurnIdentitySchema } from "./orchestration.js";
import { RequiredCheckSchema } from "./repository-policy.js";
import { agentOutputSchema } from "./types.js";

const Id = z.string().min(1).max(256);
export const AdaptiveFindingSchema = z.strictObject({
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string().min(1).max(500),
  detail: z.string().min(1).max(4000),
  file: z.string().max(4096).nullable(),
  line: z.number().int().positive().nullable(),
  remediation: z.string().min(1).max(2000),
});
export const AdaptiveReviewResultSchema = z.strictObject({
  verdict: z.enum(["approved", "changes_requested", "blocked"]),
  summary: z.string().min(1).max(4000),
  revision: Id,
  validationPlanId: Id,
  planAdequacy: z.enum(["adequate", "inadequate"]),
  adequacyReason: z.string().min(1).max(4000),
  // Outstanding reviewer demands, not a summary of checks already satisfied.
  // Any current demand blocks approval; earlier demands remain in the task ledger.
  requiredChecks: z.array(RequiredCheckSchema).max(100),
  validationEvidenceIds: z.array(Id).max(100),
  findings: z.array(AdaptiveFindingSchema).max(100),
  resolutions: z
    .array(
      z.strictObject({
        findingId: Id,
        disposition: z.enum(["resolved", "dismissed"]),
        rationale: z.string().min(1).max(4000),
      }),
    )
    .max(100),
  residualRisks: z.array(z.string().min(1).max(2000)).max(100),
});
export type AdaptiveReviewResult = z.infer<typeof AdaptiveReviewResultSchema>;
export const ADAPTIVE_REVIEW_OUTPUT_SCHEMA = agentOutputSchema(AdaptiveReviewResultSchema);

export type ReviewApprovalBlockerCode =
  | "review_missing"
  | "candidate_mismatch"
  | "review_unfinished"
  | "review_source_changed"
  | "review_failed"
  | "review_report_missing"
  | "review_turn_ineligible"
  | "review_work_pending"
  | "verdict_not_approved"
  | "plan_inadequate"
  | "reported_findings"
  | "reviewer_required_checks"
  | "candidate_not_current"
  | "unresolved_findings"
  | "revision_not_available"
  | "missing_validation"
  | "uncited_validation"
  | "retained_checks_missing"
  | "reviewer_turn_superseded";

/** Derived current evidence, never a persisted approval flag or permission token. */
export type ReviewApprovalAssessment =
  | { approved: true; evidenceId: string; latestEvidenceId: string; blocker: null }
  | {
      approved: false;
      evidenceId: null;
      latestEvidenceId: string | null;
      /** First unsatisfied predicate; later predicates are not established by this result. */
      blocker: {
        code: ReviewApprovalBlockerCode;
        detail: string;
        referenceIds: string[];
        omittedReferenceCount: number;
      };
    };

export const ReviewEvidenceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runId: Id,
    evidenceId: Id,
    operationId: Id,
    controllerLeaseId: Id,
    taskId: Id,
    candidateId: Id,
    candidateGeneration: z.number().int().positive(),
    validationPlanId: Id,
    workspaceId: Id,
    workspaceGeneration: z.number().int().positive(),
    phase: z.enum(["pre_commit", "exact_revision"]),
    revision: Id,
    parentRevision: Id,
    fullTree: Id,
    fingerprint: Id,
    policyDigest: Id,
    admissionOperationId: Id,
    inspectionOperationId: Id.nullable(),
    turnIdentity: TurnIdentitySchema.nullable(),
    status: z.enum(["admitting", "running", "finished"]),
    sourceIntact: z.boolean(),
    report: AdaptiveReviewResultSchema.nullable(),
    failure: z.string().max(8000).nullable(),
    validationEvidenceIds: z.array(Id).max(100),
    findingIds: z.array(Id).max(100),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .refine((review) => (review.status === "finished") === (review.finishedAt !== null))
  .refine(
    (review) => review.report === null || (review.status === "finished" && review.sourceIntact),
  );
export type ReviewEvidence = z.infer<typeof ReviewEvidenceSchema>;

export const FindingRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: Id,
  findingId: Id,
  taskId: Id,
  reviewEvidenceId: Id,
  finding: AdaptiveFindingSchema,
  createdAt: z.iso.datetime(),
});
export type FindingRecord = z.infer<typeof FindingRecordSchema>;
