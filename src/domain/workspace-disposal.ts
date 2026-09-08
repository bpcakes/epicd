import { z } from "zod";
import { WorkspaceIdentitySchema } from "./agents.js";
import { StateFileIdentitySchema } from "./state-file-identity.js";
import { CommandLifetimeSchema, CommandStopSchema, assertCommandStop } from "./command-lifetime.js";
import { digestJson } from "./repository-policy.js";

/** Recoverable removal from active use, not permanent deletion of evidence. */
export const WorkspaceDisposalSchema = WorkspaceIdentitySchema.extend({
  disposalId: z.uuid(),
  runId: z.string().min(1),
  operationId: z.uuid(),
  controllerLeaseId: z.string().min(1),
  source: StateFileIdentitySchema,
  archiveDirectory: StateFileIdentitySchema,
  execution: CommandLifetimeSchema.nullable(),
  stop: CommandStopSchema.nullable(),
  outcome: z.enum(["retained", "not_moved", "conflict"]).nullable(),
  sourcePathOccupied: z.boolean().nullable(),
  detail: z.string().max(4000).nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
}).superRefine((record, context) => {
  try {
    if ((record.outcome === null) !== (record.finishedAt === null))
      throw new Error("Disposal outcome and settlement must agree");
    if (record.execution) {
      if (
        record.execution.runId !== record.runId ||
        record.execution.operationId !== record.operationId ||
        record.execution.controllerLeaseId !== record.controllerLeaseId ||
        record.execution.scopeDigest !== workspaceDisposalScope(record)
      )
        throw new Error("Disposal execution differs from its admitted identity");
      if (record.stop) assertCommandStop(record.execution, record.stop);
      if (record.outcome && !record.stop) throw new Error("Disposal worker stop is unproven");
    } else if (record.stop || (record.outcome !== null && record.outcome !== "not_moved"))
      throw new Error("Unbound disposal can only be fenced as never moved");
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid disposal",
    });
  }
});
export type WorkspaceDisposal = z.infer<typeof WorkspaceDisposalSchema>;
export function workspaceDisposalScope(
  record: Pick<
    WorkspaceDisposal,
    | "disposalId"
    | "runId"
    | "operationId"
    | "controllerLeaseId"
    | "workspaceId"
    | "workspaceGeneration"
    | "source"
    | "archiveDirectory"
  >,
) {
  return digestJson({
    kind: "workspace-disposal",
    disposalId: record.disposalId,
    runId: record.runId,
    operationId: record.operationId,
    controllerLeaseId: record.controllerLeaseId,
    workspaceId: record.workspaceId,
    workspaceGeneration: record.workspaceGeneration,
    source: record.source,
    archiveDirectory: record.archiveDirectory,
  });
}
