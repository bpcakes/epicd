import { z } from "zod";
import { isAbsolute, resolve } from "node:path";
import { ModelIdSchema, ReasoningEffortSchema } from "./types.js";

export const LaunchPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) => isAbsolute(path) && resolve(path) === path && path !== "/" && !path.includes("\0"),
  );
export const CodexLaunchSchema = z.strictObject({
  generation: z.string().uuid(),
  confinement: z.strictObject({
    executable: LaunchPathSchema,
    workspace: LaunchPathSchema,
    sourceMode: z.enum(["read-only", "workspace-write"]),
    providerHome: LaunchPathSchema,
    scratch: LaunchPathSchema,
    artifacts: LaunchPathSchema,
  }),
  model: ModelIdSchema,
  reasoningEffort: ReasoningEffortSchema,
  /** Only the cache pathname is persisted, never credentials. */
  authCachePath: LaunchPathSchema.nullable(),
  controlDirectory: LaunchPathSchema,
});
export type CodexLaunch = z.infer<typeof CodexLaunchSchema>;

export const CodexLaunchStopSchema = z
  .strictObject({
    generation: z.string().uuid(),
    stoppedAt: z.iso.datetime(),
    kind: z.enum(["stopped", "not_started"]),
    code: z.number().int().nonnegative().max(255).nullable(),
    signal: z
      .string()
      .regex(/^SIG[A-Z0-9]+$/)
      .nullable(),
    interrupted: z.boolean(),
    processTreeStopped: z.literal(true),
  })
  .refine(
    (receipt) =>
      receipt.kind !== "not_started" || (receipt.code === null && receipt.signal === null),
  );
export type CodexLaunchStop = z.infer<typeof CodexLaunchStopSchema>;

export const TurnLaunchSchema = z.strictObject({
  controllerLeaseId: z.string().min(1),
  manifest: CodexLaunchSchema,
  manifestDigest: z.string().length(64),
  stop: CodexLaunchStopSchema.nullable(),
});
export type TurnLaunch = z.infer<typeof TurnLaunchSchema>;
