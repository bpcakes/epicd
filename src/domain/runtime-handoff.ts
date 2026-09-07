import { z } from "zod";
import { RuntimeConfigurationSchema } from "./types.js";

/** Operator-selected launch surface only. Repository, storage, auth and policy cannot change. */
export const RuntimeHandoffTargetSchema = z.discriminatedUnion("runtime", [
  z.strictObject({
    runtime: z.literal("sdk"),
    executable: RuntimeConfigurationSchema.shape.executable,
    herdr: z.null(),
  }),
  z.strictObject({
    runtime: z.literal("herdr"),
    executable: RuntimeConfigurationSchema.shape.executable,
    herdr: RuntimeConfigurationSchema.shape.herdr.unwrap(),
  }),
]);
export type RuntimeHandoffTarget = z.infer<typeof RuntimeHandoffTargetSchema>;
