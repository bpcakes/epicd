import { z } from "zod";

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
