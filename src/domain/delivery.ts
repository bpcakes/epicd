import { z } from "zod";
import { WorkspaceIdentitySchema } from "./agents.js";
import { WorkspaceSnapshotSchema } from "./workspaces.js";
import { digestJson, RequiredCheckSchema } from "./repository-policy.js";
import { FixtureExecutableSchema } from "./fixtures.js";

export const ValidationServiceRuntimeSchema = z.strictObject({
  initdb: FixtureExecutableSchema,
  pg_ctl: FixtureExecutableSchema,
  postgres: FixtureExecutableSchema,
  psql: FixtureExecutableSchema,
});
export type ValidationServiceRuntime = z.infer<typeof ValidationServiceRuntimeSchema>;
export const ValidationEnvironmentSchema = z.strictObject({
  bindingId: z.string().min(1).max(256),
  instanceId: z.uuid(),
  generation: z.literal(1), // A fresh check-scoped instance is never reset or reused.
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: ValidationServiceRuntimeSchema.nullable(),
});
export type ValidationEnvironment = z.infer<typeof ValidationEnvironmentSchema>;

const Id = z.string().min(1).max(256);
const At = z.iso.datetime();
export const CandidateIdentitySchema = z.strictObject({
  candidateId: Id,
  candidateGeneration: z.number().int().positive(),
});
export type CandidateIdentity = z.infer<typeof CandidateIdentitySchema>;
export const ValidationPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: Id,
  planId: Id,
  operationId: Id,
  taskId: Id,
  generation: z.number().int().positive(),
  policyDigest: Id,
  acceptanceCriteria: z.array(z.string().min(1).max(4000)).min(1).max(100),
  checks: z.array(RequiredCheckSchema).min(1).max(100),
  // Even a policy-backed plan needs independent review of free-form acceptance criteria.
  adequacy: z.literal("unreviewed"),
  createdAt: At,
});
export type ValidationPlan = z.infer<typeof ValidationPlanSchema>;
export const EpicDeliveryBindingSchema = z.strictObject({
  publicationId: z.uuid(),
  trackerSnapshotId: z.uuid(),
  scopeDigest: z.string().length(64),
  baselineRevision: Id,
  closureOperationIds: z.array(z.uuid()).max(1000),
});
export type EpicDeliveryBinding = z.infer<typeof EpicDeliveryBindingSchema>;
export const CandidateSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("implementation"),
    assignmentId: Id,
    turnId: Id.nullable(),
    taskWriterTurnCount: z.number().int().nonnegative(),
  }),
  EpicDeliveryBindingSchema.extend({
    kind: z.literal("published_epic"),
    writerTurnCount: z.number().int().nonnegative(),
  }),
]);
export const CandidateRecordSchema = CandidateIdentitySchema.extend({
  schemaVersion: z.literal(1),
  runId: Id,
  operationId: Id,
  taskId: Id,
  ...WorkspaceIdentitySchema.shape,
  source: CandidateSourceSchema,
  validationPlanId: Id,
  policyDigest: Id,
  status: z.enum(["capturing", "captured", "failed"]),
  snapshot: WorkspaceSnapshotSchema.nullable(),
  failure: z.string().max(4000).nullable(),
  createdAt: At,
  capturedAt: At.nullable(),
}).refine(
  (value) =>
    (value.status === "captured") === (value.snapshot !== null && value.capturedAt !== null),
  "A captured candidate requires an exact snapshot",
);
export type CandidateRecord = z.infer<typeof CandidateRecordSchema>;
export const CandidateWorkspaceSchema = WorkspaceIdentitySchema.extend({
  schemaVersion: z.literal(1),
  runId: Id,
  operationId: Id,
  ...CandidateIdentitySchema.shape,
  revision: Id,
  phase: z.enum(["pre_commit", "exact_revision"]),
  createdAt: At,
});
export type CandidateWorkspace = z.infer<typeof CandidateWorkspaceSchema>;
export const ValidationOutcomeSchema = z.strictObject({
  status: z.enum(["succeeded", "failed", "cancelled", "timed_out", "not_started"]),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  // The supervisor retains 64 KiB plus a small explicit omission/redaction marker.
  stdout: z.string().max(65637),
  stderr: z.string().max(65637),
  outputTruncated: z.boolean(),
  startedAt: At,
  endedAt: At,
  processTreeStopped: z.literal(true),
});
export type ValidationOutcome = z.infer<typeof ValidationOutcomeSchema>;
export const ValidationEvidenceSchema = WorkspaceIdentitySchema.extend({
  schemaVersion: z.literal(1),
  runId: Id,
  evidenceId: Id,
  operationId: Id,
  workspaceOperationId: Id,
  controllerLeaseId: Id,
  ...CandidateIdentitySchema.shape,
  validationPlanId: Id,
  checkId: Id,
  purpose: z.enum(["delivery", "diagnostic"]),
  check: RequiredCheckSchema,
  commandDigest: Id,
  policyDigest: Id,
  phase: z.enum(["pre_commit", "exact_revision"]),
  revision: Id,
  fingerprint: Id,
  confinementProfile: z.literal("bwrap-read-only-source-v1"),
  environmentGenerations: z.array(ValidationEnvironmentSchema).max(4),
  fixtureAccessIds: z.array(z.uuid()).max(1),
  environmentVerified: z.boolean(),
  status: z.enum(["running", "finished"]),
  outcome: ValidationOutcomeSchema.nullable(),
  sourceUnchanged: z.boolean(),
  createdAt: At,
})
  .refine(
    (value) => (value.status === "finished") === (value.outcome !== null),
    "Terminal validation needs an observed process outcome",
  )
  .refine(
    (value) => value.checkId === value.check.id && value.commandDigest === digestJson(value.check),
    "Validation command identity differs from its frozen check",
  );
export type ValidationEvidence = z.infer<typeof ValidationEvidenceSchema>;
