import { z } from "zod";
import { WorkspaceIdentitySchema, WorkspaceRecordSchema } from "./agents.js";
import { CommandLifetimeSchema, CommandStopSchema, assertCommandStop } from "./command-lifetime.js";
import { digestJson } from "./repository-policy.js";

const Id = z.string().min(1).max(256);
/** Selected by trusted adapters from repository/candidate/commit custody, not a model path. */
export const WorkspaceCreationSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("repository"), path: z.string().startsWith("/") }),
  WorkspaceIdentitySchema.extend({
    kind: z.literal("snapshot"),
    fullTree: Id,
    fingerprint: z.string().length(64),
  }),
  WorkspaceIdentitySchema.extend({
    kind: z.literal("commit"),
    objectContent: z.string().min(1).max(64_000),
  }),
]);
export type WorkspaceCreationSource = z.infer<typeof WorkspaceCreationSourceSchema>;
export const WorkspaceCreationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("created") }),
  z.strictObject({ status: z.literal("failed"), code: Id, detail: z.string().max(4000) }),
]);
export type WorkspaceCreationResult = z.infer<typeof WorkspaceCreationResultSchema>;

export const WorkspaceCreationSchema = WorkspaceIdentitySchema.extend({
  creationId: z.uuid(),
  runId: Id,
  controllerLeaseId: Id,
  creationOperationId: Id.nullable(),
  actionId: Id.nullable(),
  policyDigest: Id,
  workspaceRoot: z.string().startsWith("/"),
  revision: Id,
  purpose: WorkspaceRecordSchema.shape.purpose,
  source: WorkspaceCreationSourceSchema,
  workspaceOperationId: z.uuid(),
  sourceOperationId: z.uuid().nullable(),
  execution: CommandLifetimeSchema.nullable(),
  stop: CommandStopSchema.nullable(),
  workerResult: WorkspaceCreationResultSchema.nullable(),
  outcome: z.enum(["created", "failed"]).nullable(),
  detail: z.string().max(4000).nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
}).superRefine((record, context) => {
  try {
    if (
      (record.source.kind === "repository") !== (record.sourceOperationId === null) ||
      record.sourceOperationId === record.workspaceOperationId
    )
      throw new Error("Creation source and workspace exclusions differ");
    if (record.execution) {
      if (
        record.execution.runId !== record.runId ||
        record.execution.operationId !== record.creationId ||
        record.execution.controllerLeaseId !== record.controllerLeaseId ||
        record.execution.scopeDigest !== workspaceCreationScope(record)
      )
        throw new Error("Workspace creation execution differs from its exact intent");
      if (record.stop) assertCommandStop(record.execution, record.stop);
      if (record.outcome && !record.stop)
        throw new Error("Workspace creation has no independent stop");
    } else if (record.stop || record.workerResult || record.outcome === "created")
      throw new Error("Workspace creation result has no bound worker");
    if (record.stop?.kind === "not_started" && record.workerResult)
      throw new Error("An unstarted creation cannot have a worker result");
    if (
      (record.outcome !== null) !== (record.finishedAt !== null) ||
      (record.outcome === "created" && record.workerResult?.status !== "created")
    )
      throw new Error("Workspace creation settlement differs from its retained result");
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid workspace creation",
    });
  }
});
export type WorkspaceCreation = z.infer<typeof WorkspaceCreationSchema>;
export function workspaceCreationScope(
  record: Pick<
    WorkspaceCreation,
    | "creationId"
    | "runId"
    | "controllerLeaseId"
    | "creationOperationId"
    | "actionId"
    | "policyDigest"
    | "workspaceRoot"
    | "workspaceId"
    | "workspaceGeneration"
    | "revision"
    | "purpose"
    | "source"
    | "workspaceOperationId"
    | "sourceOperationId"
  >,
) {
  return digestJson({
    kind: "workspace-creation",
    creationId: record.creationId,
    runId: record.runId,
    controllerLeaseId: record.controllerLeaseId,
    creationOperationId: record.creationOperationId,
    actionId: record.actionId,
    policyDigest: record.policyDigest,
    workspaceRoot: record.workspaceRoot,
    workspaceId: record.workspaceId,
    workspaceGeneration: record.workspaceGeneration,
    revision: record.revision,
    purpose: record.purpose,
    source: record.source,
    workspaceOperationId: record.workspaceOperationId,
    sourceOperationId: record.sourceOperationId,
  });
}
