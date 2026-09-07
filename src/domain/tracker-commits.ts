import { z } from "zod";
import { WorkspaceIdentitySchema } from "./agents.js";
import { TrackerExportMetadataSchema } from "./tracker.js";
import { WorkspaceSnapshotSchema } from "./workspaces.js";

const Oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** Kernel-derived tracker objects inherit application ancestry, never a review of their own SHA. */
export const TrackerCommitRecordSchema = WorkspaceIdentitySchema.extend({
  schemaVersion: z.literal(1),
  trackerCommitId: z.uuid(),
  runId: z.string().min(1),
  operationId: z.uuid(),
  controllerLeaseId: z.string(),
  workspaceOperationId: z.uuid(),
  policyDigest: z.string().length(64),
  dispatched: z.boolean(),
  exportOperationId: z.uuid(),
  exportMetadata: TrackerExportMetadataSchema,
  parentPublicationId: z.uuid(),
  parentRevision: Oid,
  applicationCommitId: z.uuid(),
  applicationRevision: Oid,
  applicationTree: Oid,
  fullTree: Oid.nullable(),
  snapshot: WorkspaceSnapshotSchema.nullable(),
  objectContent: z.string().min(1).max(8000).nullable(),
  revision: Oid.nullable(),
  status: z.enum(["preparing", "writing", "created", "failed"]),
  sourceIntact: z.boolean(),
  failure: z.string().max(4000).nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
})
  .refine(
    (record) => ["created", "failed"].includes(record.status) === (record.finishedAt !== null),
  )
  .refine(
    (record) =>
      !["writing", "created"].includes(record.status) ||
      (record.dispatched &&
        !!record.revision &&
        !!record.fullTree &&
        !!record.objectContent &&
        !!record.snapshot),
  )
  .refine(
    (record) =>
      !record.snapshot ||
      (record.snapshot.fullTree === record.fullTree &&
        record.snapshot.applicationTree === record.applicationTree &&
        record.snapshot.snapshotRevision === record.revision &&
        record.snapshot.parentRevision === record.parentRevision &&
        record.snapshot.runId === record.runId &&
        record.snapshot.workspaceId === record.workspaceId &&
        record.snapshot.workspaceGeneration === record.workspaceGeneration),
  );

export type TrackerCommitRecord = z.infer<typeof TrackerCommitRecordSchema>;
