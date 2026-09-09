import { z } from "zod";
import { WorkspaceIdentitySchema } from "./agents.js";
import { CandidateIdentitySchema } from "./delivery.js";
import type { KernelAction } from "./orchestration.js";
import { CommandLifetimeSchema, CommandStopSchema, assertCommandStop } from "./command-lifetime.js";
import { digestJson } from "./repository-policy.js";

const Path = z.string().min(1).max(4096);
const Oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const NodeIdentitySchema = z.strictObject({
  path: Path,
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
});
/** Physical identities, not permission, review approval, or evidence that prior I/O stopped. */
export const PublicationRepositorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  root: NodeIdentitySchema,
  gitDirectory: NodeIdentitySchema,
  commonDirectory: NodeIdentitySchema,
  gitEntryDigest: z.string().length(64).nullable(),
  configDigest: z.string().length(64),
  objectFormat: z.enum(["sha1", "sha256"]),
});
export type PublicationRepository = z.infer<typeof PublicationRepositorySchema>;

/** The journal must persist this intent before giving the transport write authority. */
export const PublicationRefIntentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    publicationId: z.string().uuid(),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    repository: PublicationRepositorySchema,
    revision: Oid,
    expectedRef: Oid.nullable(),
  })
  .refine((intent) =>
    [intent.revision, intent.expectedRef].every(
      (oid) => oid === null || oid.length === (intent.repository.objectFormat === "sha1" ? 40 : 64),
    ),
  );
export type PublicationRefIntent = z.infer<typeof PublicationRefIntentSchema>;

/** Persist before import; a .keep file is an owned retention obligation, never disposable by guess. */
export const PublicationPackSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    publicationId: z.string().uuid(),
    objectFormat: z.enum(["sha1", "sha256"]),
    revision: Oid,
    baseRevision: Oid,
    packHash: Oid,
    size: z
      .number()
      .int()
      .min(32)
      .max(64 * 1024 * 1024),
  })
  .refine((pack) =>
    [pack.revision, pack.baseRevision, pack.packHash].every(
      (oid) => oid.length === (pack.objectFormat === "sha1" ? 40 : 64),
    ),
  );
export type PublicationPack = z.infer<typeof PublicationPackSchema>;

/** A physical observation only. The caller separately proves old I/O stop and current approval. */
export const PublicationRefObservationSchema = z.strictObject({
  outcome: z.enum(["applied", "not_applied", "conflict"]),
  branchRevision: Oid.nullable(),
  receiptRevision: Oid.nullable(),
  detail: z.string().max(4000),
});
export type PublicationRefObservation = z.infer<typeof PublicationRefObservationSchema>;

export const PublicationIOResultSchema = z.strictObject({
  failure: z.string().max(4000).nullable(),
  intervention: z.boolean(),
  canonical: PublicationRefObservationSchema.nullable(),
  user: PublicationRefObservationSchema.nullable(),
});
export type PublicationIOResult = z.infer<typeof PublicationIOResultSchema>;
export const PublicationIOAttemptSchema = z.strictObject({
  attemptId: z.uuid(),
  phase: z.enum(["publish", "inspect"]),
  controllerLeaseId: z.string().min(1).max(256),
  workspaceOperations: z.array(z.uuid()).min(1).max(2),
  execution: CommandLifetimeSchema.nullable(),
  stop: CommandStopSchema.nullable(),
  result: PublicationIOResultSchema.nullable(),
  settledAt: z.iso.datetime().nullable(),
});
export type PublicationIOAttempt = z.infer<typeof PublicationIOAttemptSchema>;

export const DeliveryRepositorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().min(1).max(256),
  baseRevision: Oid,
  userRepository: PublicationRepositorySchema.nullable(),
  creationOperationId: z.string().uuid(),
  workspace: WorkspaceIdentitySchema.nullable(),
  canonicalRepository: PublicationRepositorySchema.nullable(),
  privateRevision: Oid.nullable(),
  publishedRevision: Oid.nullable(),
  lastPublishedId: z.string().uuid().nullable(),
});
export type DeliveryRepository = z.infer<typeof DeliveryRepositorySchema>;

export const PublicationLockSchema = z
  .strictObject({
    revision: Oid,
    acquired: z.boolean(),
    releaseRequested: z.boolean(),
    released: z.boolean(),
    releaseDisposition: z.enum(["removed", "absent", "other_owner"]).nullable(),
  })
  .refine((lock) => !lock.released || lock.releaseRequested)
  .refine((lock) => lock.released === (lock.releaseDisposition !== null));
export const PublicationRecordSchema = CandidateIdentitySchema.extend({
  schemaVersion: z.literal(1),
  publicationId: z.string().uuid(),
  runId: z.string().min(1).max(256),
  operationId: z.string().uuid(),
  controllerLeaseId: z.string().min(1).max(256),
  commitId: z.string().uuid(),
  // Candidate/commit/review fields identify the reviewed application ancestor.
  // Only this discriminant can attest that the published revision is tracker-only.
  provenance: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("application") }),
    z.strictObject({
      kind: z.literal("tracker"),
      trackerCommitId: z.uuid(),
      reviewedRevision: Oid,
    }),
  ]),
  reviewEvidenceId: z.string().min(1).max(256),
  policyDigest: z.string().min(1).max(256),
  ...WorkspaceIdentitySchema.shape,
  workspaceOperations: z.array(z.string().uuid()).min(1).max(64),
  workspaceRoot: z.string().startsWith("/"),
  ioAttempts: z.array(PublicationIOAttemptSchema).min(1).max(31),
  revision: Oid,
  expectedPreviousRevision: Oid,
  publicRef: PublicationRefIntentSchema.nullable(),
  canonicalRef: PublicationRefIntentSchema.nullable(),
  packs: z
    .array(
      z.strictObject({
        destination: z.enum(["canonical", "user"]),
        record: PublicationPackSchema,
        retained: z.boolean(),
      }),
    )
    .max(2),
  lockNonce: z.string().uuid(),
  lock: PublicationLockSchema.nullable(),
  dispatched: z.boolean(),
  ioStopped: z.boolean(),
  intervention: z.boolean(),
  failure: z.string().max(4000).nullable(),
  outcome: z.enum(["published", "not_published", "conflict"]).nullable(),
  canonicalApplied: z.boolean(),
  publicApplied: z.boolean(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
})
  .refine((record) => (record.outcome !== null) === (record.finishedAt !== null))
  .refine((record) => record.outcome === null || record.ioStopped)
  .refine((record) => record.outcome === null || !record.lock || record.lock.released)
  .refine(
    (record) =>
      !record.lock ||
      (record.publicRef !== null &&
        record.lock.revision.length === record.publicRef.revision.length),
  )
  .refine(
    (record) =>
      record.outcome !== "published" ||
      (record.canonicalApplied && record.publicApplied && !record.intervention),
  )
  .refine((record) => !record.publicApplied || record.publicRef !== null)
  .refine((record) => !record.canonicalApplied || record.canonicalRef !== null)
  .refine((record) =>
    [record.publicRef, record.canonicalRef].every(
      (ref) =>
        ref === null ||
        (ref.runId === record.runId &&
          ref.publicationId === record.publicationId &&
          ref.revision === record.revision),
    ),
  )
  .refine((record) => record.packs.every((pack) => pack.record.revision === record.revision))
  .superRefine((record, context) => {
    try {
      const members = record.ioAttempts.flatMap((attempt) => attempt.workspaceOperations);
      if (
        digestJson(members) !== digestJson(record.workspaceOperations) ||
        new Set(members).size !== members.length ||
        new Set(record.ioAttempts.map((attempt) => attempt.attemptId)).size !==
          record.ioAttempts.length ||
        record.ioStopped !== (record.ioAttempts.at(-1)!.settledAt !== null)
      )
        throw new Error("Publication I/O projection differs from its exact attempts");
      const writer = record.ioAttempts[0]!;
      if (record.dispatched && (!writer.execution || writer.stop?.kind === "not_started"))
        throw new Error("Dispatched publication has no started writer intent");
      if (
        !record.dispatched &&
        (record.publicRef || record.canonicalRef || record.lock || record.packs.length)
      )
        throw new Error("Undispatched publication has unexplained physical intents");
      for (const [index, attempt] of record.ioAttempts.entries()) {
        if (
          attempt.phase !== (index === 0 ? "publish" : "inspect") ||
          (index === 0 && attempt.controllerLeaseId !== record.controllerLeaseId) ||
          (index < record.ioAttempts.length - 1 && !attempt.settledAt)
        )
          throw new Error("Publication attempt ordering or ownership differs");
        if (attempt.execution) {
          if (
            attempt.execution.runId !== record.runId ||
            attempt.execution.operationId !== attempt.attemptId ||
            attempt.execution.controllerLeaseId !== attempt.controllerLeaseId ||
            attempt.execution.scopeDigest !== publicationIOScope(record, attempt)
          )
            throw new Error("Publication execution differs from its exact attempt");
          if (attempt.stop) assertCommandStop(attempt.execution, attempt.stop);
          if (attempt.settledAt && !attempt.stop)
            throw new Error("Publication worker stop is unproven");
        } else if (attempt.stop || attempt.result)
          throw new Error("Publication result has no bound execution");
        if (attempt.stop?.kind === "not_started" && attempt.result)
          throw new Error("An unstarted publication worker cannot have a result");
        if (attempt.phase === "publish" && (attempt.result?.canonical || attempt.result?.user))
          throw new Error("Publication writes cannot substitute for independent inspection");
        if (attempt.phase === "inspect" && attempt.result) {
          for (const [observation, intent] of [
            [attempt.result.canonical, record.canonicalRef],
            [attempt.result.user, record.publicRef],
          ] as const) {
            if (!attempt.result.failure && Boolean(observation) !== Boolean(intent))
              throw new Error("Inspection omitted an exact admitted ref target");
            if (!observation) continue;
            if (!intent) throw new Error("Inspection has no matching ref intent");
            const expected =
              observation.branchRevision === intent.revision &&
              observation.receiptRevision === intent.revision
                ? "applied"
                : observation.branchRevision === intent.expectedRef &&
                    observation.receiptRevision === null
                  ? "not_applied"
                  : "conflict";
            if (observation.outcome !== expected)
              throw new Error("Inspection outcome differs from its exact observed refs");
          }
        }
      }
      if (record.outcome) {
        const inspection = record.ioAttempts.at(-1)!;
        if (
          inspection.phase !== "inspect" ||
          !inspection.result ||
          inspection.result.failure ||
          record.canonicalApplied !== (inspection.result.canonical?.outcome === "applied") ||
          record.publicApplied !== (inspection.result.user?.outcome === "applied")
        )
          throw new Error("Publication outcome has no matching retained stopped inspection");
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid publication I/O",
      });
    }
  });
export type PublicationRecord = z.infer<typeof PublicationRecordSchema>;

export function publicationIOScope(
  record: Pick<
    PublicationRecord,
    | "publicationId"
    | "runId"
    | "operationId"
    | "commitId"
    | "provenance"
    | "policyDigest"
    | "reviewEvidenceId"
    | "revision"
    | "expectedPreviousRevision"
    | "workspaceRoot"
    | "workspaceId"
    | "workspaceGeneration"
    | "candidateId"
    | "candidateGeneration"
    | "lockNonce"
  >,
  attempt: Pick<
    PublicationIOAttempt,
    "attemptId" | "phase" | "controllerLeaseId" | "workspaceOperations"
  >,
): string {
  return digestJson({
    kind: "publication-io",
    publicationId: record.publicationId,
    runId: record.runId,
    operationId: record.operationId,
    commitId: record.commitId,
    provenance: record.provenance,
    policyDigest: record.policyDigest,
    reviewEvidenceId: record.reviewEvidenceId,
    revision: record.revision,
    expectedPreviousRevision: record.expectedPreviousRevision,
    workspaceRoot: record.workspaceRoot,
    workspaceId: record.workspaceId,
    workspaceGeneration: record.workspaceGeneration,
    candidateId: record.candidateId,
    candidateGeneration: record.candidateGeneration,
    lockNonce: record.lockNonce,
    attemptId: attempt.attemptId,
    phase: attempt.phase,
    controllerLeaseId: attempt.controllerLeaseId,
    workspaceOperations: attempt.workspaceOperations,
  });
}

/** Model/reviewer view excludes private execution controls and controller credentials. */
export function publicationView(record: PublicationRecord) {
  const { controllerLeaseId: _lease, lockNonce: _nonce, ioAttempts, ...view } = record;
  return {
    ...view,
    ioAttempts: ioAttempts.map(
      ({ attemptId, phase, workspaceOperations, result, settledAt, stop }) => ({
        attemptId,
        phase,
        workspaceOperations,
        result,
        settledAt,
        stopConfirmed: stop !== null || settledAt !== null,
      }),
    ),
  };
}

/** Bounded attempt previews; complete redacted history is available through inspect_record paging. */
export function publicationInspectionView(record: PublicationRecord) {
  const view = publicationView(record);
  return {
    ...view,
    ioAttempts: view.ioAttempts.map(({ result, ...attempt }) => ({
      ...attempt,
      result: result
        ? {
            failurePreview: result.failure?.slice(0, 300) ?? null,
            failureTruncated: (result.failure?.length ?? 0) > 300,
            intervention: result.intervention,
            canonicalOutcome: result.canonical?.outcome ?? null,
            userOutcome: result.user?.outcome ?? null,
          }
        : null,
    })),
  };
}

/** Evidence-changing capabilities wait; the coordinator can still observe and communicate. */
export function concurrentWithPublication(kind: KernelAction["kind"]): boolean {
  return (
    kind.startsWith("inspect_") ||
    kind.startsWith("read_") ||
    [
      "record_memory",
      "wait_for_events",
      "message_agent",
      "interrupt_agent",
      "interrupt_action",
      "escalate",
      "reconcile_publication",
      "reconcile_action",
      "reconcile_workspace_inspection",
    ].includes(kind)
  );
}
