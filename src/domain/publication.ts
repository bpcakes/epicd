import { z } from "zod";
import { WorkspaceIdentitySchema } from "./agents.js";
import { CandidateIdentitySchema } from "./delivery.js";
import type { KernelAction } from "./orchestration.js";

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
export type PublicationRefObservation = {
  outcome: "applied" | "not_applied" | "conflict";
  branchRevision: string | null;
  receiptRevision: string | null;
  detail: string;
};

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
  reviewEvidenceId: z.string().min(1).max(256),
  policyDigest: z.string().min(1).max(256),
  ...WorkspaceIdentitySchema.shape,
  workspaceOperations: z.array(z.string().uuid()).min(1).max(64),
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
  .refine((record) => record.packs.every((pack) => pack.record.revision === record.revision));
export type PublicationRecord = z.infer<typeof PublicationRecordSchema>;

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
      "escalate",
      "reconcile_publication",
    ].includes(kind)
  );
}
