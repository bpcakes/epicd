import { z } from "zod";
import { WorkspaceIdentitySchema } from "./agents.js";

export const ManifestEntrySchema = z.strictObject({
  path: z.string().min(1).max(4096),
  mode: z.enum(["100644", "100755", "120000"]),
  objectId: z.string().min(1).max(256),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;
export const WorkspaceSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().min(1).max(256),
  ...WorkspaceIdentitySchema.shape,
  parentRevision: z.string().min(1).max(256),
  fullTree: z.string().min(1).max(256),
  applicationTree: z.string().min(1).max(256),
  snapshotRevision: z.string().min(1).max(256),
  fingerprint: z.string().length(64),
  manifest: z.array(ManifestEntrySchema),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

/** Internal kernel I/O ownership. A lost controller lease never releases this exclusion. */
export const WorkspaceOperationSchema = WorkspaceIdentitySchema.extend({
  schemaVersion: z.literal(1),
  runId: z.string().min(1).max(256),
  operationId: z.string().uuid(),
  controllerLeaseId: z.string().min(1).max(256),
  kind: z.enum(["materialize", "capture", "inspect_materialization", "copy_source", "validation"]),
  status: z.enum(["running", "indeterminate", "succeeded", "failed"]),
  stopEvidence: z.string().min(1).max(4000).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).refine(
  (record) =>
    (record.status === "succeeded" || record.status === "failed") ===
    (record.stopEvidence !== null),
  "Only a stopped workspace operation may release its exclusion",
);
export type WorkspaceOperation = z.infer<typeof WorkspaceOperationSchema>;
