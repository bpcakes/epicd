import { z } from "zod";

const Window = {
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(4000),
};

/** Select retained records, never caller-supplied evidence content or authority. */
export const ReviewReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("action"),
    actionId: z.string().min(1).max(256),
    ...Window,
  }),
  z.strictObject({ kind: z.literal("artifact"), artifactId: z.uuid(), ...Window }),
]);
export type ReviewReference = z.infer<typeof ReviewReferenceSchema>;
export const ReviewReferencesSchema = z.array(ReviewReferenceSchema).max(8);
