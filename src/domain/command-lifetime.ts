import { z } from "zod";
import { StateFileIdentitySchema } from "./repository-admission.js";
import { digestJson } from "./repository-policy.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CommandLifetimeSchema = z.strictObject({
  ioId: z.uuid(),
  runId: z.string().min(1),
  operationId: z.string().min(1),
  controllerLeaseId: z.string().min(1),
  scopeDigest: Digest,
  launchDigest: Digest,
  timeoutMs: z.number().int().positive().max(2_147_483_647),
  directory: StateFileIdentitySchema,
});
export type CommandLifetime = z.infer<typeof CommandLifetimeSchema>;
export const CommandStopSchema = z
  .strictObject({
    ioId: z.uuid(),
    bindingDigest: Digest,
    kind: z.enum(["stopped", "not_started"]),
    code: z.number().int().nullable(),
    reason: z.enum(["cancelled", "timed_out"]).nullable(),
    error: z.string().max(4000).nullable(),
    stoppedAt: z.iso.datetime(),
  })
  .refine(
    (receipt) =>
      receipt.kind !== "not_started" || (receipt.code === null && receipt.error === null),
    "A never-started command cannot contain an execution result",
  );
export type CommandStop = z.infer<typeof CommandStopSchema>;
export function assertCommandStop(intent: CommandLifetime, receipt: CommandStop) {
  if (receipt.ioId !== intent.ioId || receipt.bindingDigest !== digestJson(intent))
    throw new Error("Command stop receipt differs from the exact launch intent");
}
