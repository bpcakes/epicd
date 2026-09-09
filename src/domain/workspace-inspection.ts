import { z } from "zod";
import { WorkspaceIdentitySchema } from "./agents.js";
import { CommandLifetimeSchema, CommandStopSchema, assertCommandStop } from "./command-lifetime.js";
import { digestJson } from "./repository-policy.js";

const Id = z.string().min(1).max(256);
export const WorkspaceInspectionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("materialization") }),
  z.strictObject({ kind: z.literal("application_commit"), commitId: z.uuid() }),
  z.strictObject({ kind: z.literal("tracker_commit"), trackerCommitId: z.uuid() }),
]);
export type WorkspaceInspectionTarget = z.infer<typeof WorkspaceInspectionTargetSchema>;
export type CommitInspectionTarget = Exclude<
  WorkspaceInspectionTarget,
  { kind: "materialization" }
>;
/** Recovery reuses retained attempts; a new caller request may replace a previously failed attempt. */
export type CommitInspectionMode = "recover" | "request";
const CommitObservationFields = {
  kind: z.enum(["application_commit", "tracker_commit"]),
  detail: z.string().max(4000).nullable(),
};
const CommitObservation = z.discriminatedUnion("created", [
  z.strictObject({
    ...CommitObservationFields,
    created: z.literal(true),
    sourceIntact: z.boolean(),
  }),
  z.strictObject({
    ...CommitObservationFields,
    created: z.literal(false),
    sourceIntact: z.literal(false),
  }),
]);
export const WorkspaceInspectionResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("observed"),
    observation: z.union([
      z.discriminatedUnion("ready", [
        z.strictObject({
          kind: z.literal("materialization"),
          ready: z.literal(true),
          fingerprint: z.string().length(64),
        }),
        z.strictObject({
          kind: z.literal("materialization"),
          ready: z.literal(false),
          fingerprint: z.null(),
        }),
      ]),
      CommitObservation,
    ]),
  }),
  z.strictObject({ status: z.literal("failed"), detail: z.string().max(4000) }),
]);
export type WorkspaceInspectionResult = z.infer<typeof WorkspaceInspectionResultSchema>;
export type WorkspaceInspectionObservation = Extract<
  WorkspaceInspectionResult,
  { status: "observed" }
>["observation"];

export const WorkspaceInspectionSchema = WorkspaceIdentitySchema.extend({
  inspectionId: z.uuid(),
  runId: Id,
  controllerLeaseId: Id,
  workspaceRoot: z.string().startsWith("/"),
  workspaceOperationId: z.uuid(),
  target: WorkspaceInspectionTargetSchema,
  targetDigest: z.string().length(64),
  execution: CommandLifetimeSchema.nullable(),
  stop: CommandStopSchema.nullable(),
  workerResult: WorkspaceInspectionResultSchema.nullable(),
  outcome: z.enum(["observed", "failed"]).nullable(),
  detail: z.string().max(4000).nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
}).superRefine((record, context) => {
  try {
    if (record.execution) {
      if (
        record.execution.runId !== record.runId ||
        record.execution.operationId !== record.inspectionId ||
        record.execution.controllerLeaseId !== record.controllerLeaseId ||
        record.execution.scopeDigest !== workspaceInspectionScope(record)
      )
        throw new Error("Inspection execution differs from its exact target");
      if (record.stop) assertCommandStop(record.execution, record.stop);
      if (record.outcome && !record.stop)
        throw new Error("Inspection has no independent stop proof");
    } else if (record.stop || record.workerResult || record.outcome === "observed")
      throw new Error("Inspection observation has no bound worker");
    if (record.stop?.kind === "not_started" && record.workerResult)
      throw new Error("An unstarted inspection cannot have observations");
    if (
      record.workerResult?.status === "observed" &&
      record.workerResult.observation.kind !== record.target.kind
    )
      throw new Error("Observation differs from the admitted inspection target");
    if (
      (record.outcome !== null) !== (record.finishedAt !== null) ||
      (record.outcome === "observed" && record.workerResult?.status !== "observed")
    )
      throw new Error("Inspection settlement differs from its retained result");
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid inspection",
    });
  }
});
export type WorkspaceInspection = z.infer<typeof WorkspaceInspectionSchema>;

export function workspaceInspectionScope(
  record: Pick<
    WorkspaceInspection,
    | "inspectionId"
    | "runId"
    | "controllerLeaseId"
    | "workspaceRoot"
    | "workspaceId"
    | "workspaceGeneration"
    | "workspaceOperationId"
    | "target"
    | "targetDigest"
  >,
) {
  return digestJson({
    kind: "workspace-inspection",
    inspectionId: record.inspectionId,
    runId: record.runId,
    controllerLeaseId: record.controllerLeaseId,
    workspaceRoot: record.workspaceRoot,
    workspaceId: record.workspaceId,
    workspaceGeneration: record.workspaceGeneration,
    workspaceOperationId: record.workspaceOperationId,
    target: record.target,
    targetDigest: record.targetDigest,
  });
}
/** Public history never includes private command-control paths or controller credentials. */
export function workspaceInspectionView(record: WorkspaceInspection) {
  const { execution: _execution, stop, controllerLeaseId: _lease, ...view } = record;
  return { ...view, stopConfirmed: stop !== null || record.outcome !== null };
}

/** A completed read can observe a negative fact; neither fact is fresh delivery approval. */
export function workspaceInspectionObservationDetail(observation: WorkspaceInspectionObservation) {
  if (observation.kind === "materialization")
    return observation.ready
      ? "Materialization observed ready; original observation and independent worker stop retained"
      : "Materialization observed incomplete; original observation and independent worker stop retained";
  return `Commit observed ${observation.created ? "created" : "not created"}; source ${observation.sourceIntact ? "intact" : "not intact"}; original observation and independent worker stop retained`;
}

/** Keep the observed facts in bounded previews, separately from execution settlement. */
export function workspaceInspectionSummary(record: WorkspaceInspection) {
  const result = record.workerResult;
  const workerResult =
    result?.status === "failed"
      ? { ...result, detail: result.detail.slice(0, 300) }
      : result?.status === "observed" && result.observation.kind !== "materialization"
        ? {
            ...result,
            observation: {
              ...result.observation,
              detail: result.observation.detail?.slice(0, 300) ?? null,
            },
          }
        : result;
  return {
    inspectionId: record.inspectionId,
    target: record.target,
    outcome: record.outcome,
    workerResult,
    workspaceOperationId: record.workspaceOperationId,
    stopConfirmed: record.stop !== null || record.outcome !== null,
    detail: record.detail?.slice(0, 300) ?? null,
  };
}
