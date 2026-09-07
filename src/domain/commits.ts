import { z } from "zod";
import { CandidateIdentitySchema } from "./delivery.js";
import { WorkspaceIdentitySchema } from "./agents.js";

const Id = z.string().min(1).max(256);
/** Private commit objects are not published, verified revisions or tracker closure proofs. */
export const CommitRecordSchema = CandidateIdentitySchema.extend({
  schemaVersion: z.literal(1),
  runId: Id,
  commitId: z.string().uuid(),
  operationId: Id,
  controllerLeaseId: Id,
  workspaceOperationId: z.string().uuid(),
  ...WorkspaceIdentitySchema.shape,
  taskId: Id,
  reviewEvidenceId: Id,
  validationPlanId: Id,
  policyDigest: Id,
  parentRevision: Id,
  fullTree: Id,
  applicationTree: Id,
  fingerprint: Id,
  objectContent: z.string().min(1).max(8000),
  revision: Id.nullable(),
  status: z.enum(["preparing", "writing", "created", "failed"]),
  failure: z.string().max(4000).nullable(),
  sourceIntact: z.boolean(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
})
  .refine((record) => !["writing", "created"].includes(record.status) || record.revision !== null)
  .refine(
    (record) => ["created", "failed"].includes(record.status) === (record.finishedAt !== null),
  );
export type CommitRecord = z.infer<typeof CommitRecordSchema>;
