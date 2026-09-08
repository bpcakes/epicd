import { z } from "zod";
import { JournalRecordTargetSchema } from "./journal-records.js";

const Window = {
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(4000),
};

/** Select retained records, never caller-supplied evidence content or authority.
 * A regular union emits supported nested anyOf for Structured Outputs. Its required,
 * distinct kind literals make the alternatives disjoint; strict admission is unchanged.
 */
export const ReviewReferenceSchema = z.union([
  z.strictObject({
    kind: z.literal("action"),
    actionId: z.string().min(1).max(256),
    ...Window,
  }),
  z.strictObject({ kind: z.literal("artifact"), artifactId: z.uuid(), ...Window }),
  z.strictObject({ kind: z.literal("record"), ...JournalRecordTargetSchema.shape, ...Window }),
]);
export type ReviewReference = z.infer<typeof ReviewReferenceSchema>;
// Allow many small records without increasing the aggregate 32-KiB content budget.
export const ReviewReferencesSchema = z.array(ReviewReferenceSchema).max(32);
