import { z } from "zod";
import { createHash } from "node:crypto";
import { PublicationRepositorySchema } from "./publication.js";
import { digestJson } from "./repository-policy.js";

import { StateFileIdentitySchema } from "./state-file-identity.js";
export const RepositoryIOStopSchema = z.strictObject({
  ioId: z.uuid(),
  controllerLeaseId: z.string().min(1),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operation: z.enum(["acquiring", "releasing"]),
  kind: z.enum(["stopped", "not_started"]),
  code: z.number().int().nullable(),
  interrupted: z.boolean(),
  detail: z.string().max(4000).nullable(),
  stoppedAt: z.iso.datetime(),
});
export type RepositoryIOStop = z.infer<typeof RepositoryIOStopSchema>;
export const RepositoryAdmissionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    reservationId: z.uuid(),
    repository: PublicationRepositorySchema,
    stateFile: StateFileIdentitySchema,
    objectContent: z.string().max(4096),
    revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    phase: z.enum(["reserved", "acquiring", "owned", "releasing", "released", "conflict"]),
    ioStopped: z.boolean(),
    controllerLeaseId: z.string().min(1),
    ioId: z.uuid().nullable(),
    ioDirectory: StateFileIdentitySchema.nullable(),
    ioReceipt: RepositoryIOStopSchema.nullable(),
    detail: z.string().max(4000).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((record, context) => {
    const content = JSON.stringify({
      schemaVersion: 1,
      kind: "epicd-run-owner",
      runId: record.runId,
      reservationId: record.reservationId,
      stateFile: record.stateFile,
      commonDirectory: record.repository.commonDirectory,
    });
    const bytes = Buffer.from(content);
    const revision = createHash(record.repository.objectFormat)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (record.objectContent !== content || record.revision !== revision)
      context.addIssue({
        code: "custom",
        message:
          "Repository ownership bytes must bind the exact run, state file and common Git directory",
      });
    if (
      (!record.ioStopped && !["acquiring", "releasing"].includes(record.phase)) ||
      (["acquiring", "releasing"].includes(record.phase) && record.ioId === null)
    )
      context.addIssue({
        code: "custom",
        message: "Repository operation phase and stop identity disagree",
      });
    if ((record.ioId === null) !== (record.ioDirectory === null))
      context.addIssue({ code: "custom", message: "Repository I/O directory binding is missing" });
    if (
      record.ioReceipt &&
      (!record.ioStopped ||
        record.ioReceipt.ioId !== record.ioId ||
        record.ioReceipt.controllerLeaseId !== record.controllerLeaseId ||
        record.ioReceipt.bindingDigest !== repositoryIOBinding(record) ||
        (["acquiring", "releasing"].includes(record.phase) &&
          record.ioReceipt.operation !== record.phase))
    )
      context.addIssue({
        code: "custom",
        message: "Repository stop receipt differs from its intent",
      });
  });
export type RepositoryAdmission = z.infer<typeof RepositoryAdmissionSchema>;

export function repositoryIOBinding(record: {
  runId: string;
  reservationId: string;
  repository: unknown;
  stateFile: unknown;
  revision: string;
  ioDirectory: unknown;
}) {
  return digestJson({
    runId: record.runId,
    reservationId: record.reservationId,
    repository: record.repository,
    stateFile: record.stateFile,
    revision: record.revision,
    ioDirectory: record.ioDirectory,
  });
}
