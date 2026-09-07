import { z } from "zod";
import { createHash } from "node:crypto";
import { PublicationRepositorySchema } from "./publication.js";

export const StateFileIdentitySchema = z.strictObject({
  path: z.string().startsWith("/").max(2048),
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
});
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
  });
export type StateFileIdentity = z.infer<typeof StateFileIdentitySchema>;
export type RepositoryAdmission = z.infer<typeof RepositoryAdmissionSchema>;
