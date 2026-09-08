import { z } from "zod";
import { WorkspaceIdentitySchema } from "./agents.js";
import { CommandLifetimeSchema, CommandStopSchema, assertCommandStop } from "./command-lifetime.js";
import { digestJson } from "./repository-policy.js";

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
  kind: z.enum([
    "materialize",
    "capture",
    "inspect_materialization",
    "copy_source",
    "validation",
    "review_inspection",
    "commit",
    "publication",
  ]),
  status: z.enum(["running", "indeterminate", "succeeded", "failed"]),
  stopEvidence: z.string().min(1).max(4000).nullable(),
  execution: CommandLifetimeSchema.nullable(),
  executionStop: CommandStopSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
  .superRefine((record, context) => {
    try {
      if (record.execution) {
        if (
          record.execution.runId !== record.runId ||
          record.execution.operationId !== record.operationId ||
          record.execution.controllerLeaseId !== record.controllerLeaseId ||
          record.execution.scopeDigest !== workspaceExecutionScope(record)
        )
          throw new Error("Workspace execution differs from its operation");
        if (record.executionStop) assertCommandStop(record.execution, record.executionStop);
        if (record.stopEvidence && !record.executionStop)
          throw new Error("Supervised workspace I/O needs its complete-worker stop receipt");
      } else if (record.executionStop) throw new Error("Workspace stop has no execution binding");
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid workspace execution",
      });
    }
  })
  .refine(
    (record) =>
      (record.status === "succeeded" || record.status === "failed") ===
      (record.stopEvidence !== null),
    "Only a stopped workspace operation may release its exclusion",
  );
export type WorkspaceOperation = z.infer<typeof WorkspaceOperationSchema>;

/** Whole kernel operation, not the narrower repository command or fixture client. */
export function workspaceExecutionScope(
  operation: Pick<
    WorkspaceOperation,
    "runId" | "operationId" | "controllerLeaseId" | "kind" | "workspaceId" | "workspaceGeneration"
  >,
) {
  return digestJson({
    kind: "workspace-operation",
    runId: operation.runId,
    operationId: operation.operationId,
    controllerLeaseId: operation.controllerLeaseId,
    operationKind: operation.kind,
    workspaceId: operation.workspaceId,
    workspaceGeneration: operation.workspaceGeneration,
  });
}
