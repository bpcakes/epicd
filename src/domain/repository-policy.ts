import { createHash } from "node:crypto";
import { z } from "zod";
import { ORCHESTRATOR_MODEL, AstraReasoningEffortSchema } from "./types.js";

const RelativePath = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      value === "." ||
      (!value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        value.split("/").every((part) => part !== "" && part !== "." && part !== "..")),
    "Expected a bounded repository-relative path",
  );
export const RequiredCheckSchema = z.strictObject({
  id: z.string().min(1).max(256),
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(100),
  cwd: RelativePath.default("."),
  timeoutMs: z.number().int().positive().max(21_600_000).default(120_000),
  environmentBindings: z.array(z.string().min(1).max(256)).max(100).default([]),
  stage: z.enum(["pre_commit", "exact_revision", "both"]).default("both"),
});

export const RepositoryPolicySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    coordinator: z
      .strictObject({
        model: z.literal(ORCHESTRATOR_MODEL).default(ORCHESTRATOR_MODEL),
        reasoningEfforts: z
          .array(AstraReasoningEffortSchema)
          .min(1)
          .default(["low", "medium", "high", "xhigh", "max"]),
      })
      .default({
        model: ORCHESTRATOR_MODEL,
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      }),
    requiredChecks: z.array(RequiredCheckSchema).max(100).default([]),
    writableScratch: z
      .array(RelativePath.refine((value) => value !== ".", "Scratch cannot be the repository root"))
      .max(100)
      .default([]),
    fixtures: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(256),
          provider: z.literal("postgresql"),
          socketDirectory: z.string().startsWith("/").max(4096),
          port: z.number().int().min(1).max(65535),
          role: z.string().min(1).max(63),
          database: z.string().min(1).max(63),
          expectedOwner: z.string().min(1).max(63),
          operations: z.array(z.enum(["create", "reset", "cleanup"])).min(1),
          environmentBinding: z.string().min(1).max(256),
          cleanup: z.enum(["retain", "on_completion"]),
        }),
      )
      .max(100)
      .default([]),
    budgets: z
      .strictObject({
        maxWorkers: z.number().int().min(1).max(4).default(4),
        taskDecisions: z.number().int().min(1).max(64).default(64),
        epicDecisions: z.number().int().min(1).max(128).default(128),
        failedRecoveriesPerTask: z.number().int().min(1).max(12).default(12),
        identicalFailures: z.number().int().min(1).max(3).default(3),
        artifactBytes: z
          .number()
          .int()
          .min(1)
          .max(100 * 1024 * 1024)
          .default(100 * 1024 * 1024),
      })
      .default({
        maxWorkers: 4,
        taskDecisions: 64,
        epicDecisions: 128,
        failedRecoveriesPerTask: 12,
        identicalFailures: 3,
        artifactBytes: 100 * 1024 * 1024,
      }),
  })
  .superRefine((policy, context) => {
    for (const [field, entries] of [
      ["requiredChecks", policy.requiredChecks],
      ["fixtures", policy.fixtures],
    ] as const) {
      const ids = entries.map((entry) => entry.id);
      if (new Set(ids).size !== ids.length)
        context.addIssue({ code: "custom", path: [field], message: "IDs must be unique" });
    }
  });
export type RepositoryPolicy = z.infer<typeof RepositoryPolicySchema>;

/** Stable digests do not depend on insertion order of JSON object properties. */
export function digestJson(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return input;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
