import { z } from "zod";

export const IssueStatusSchema = z.enum([
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "draft",
  "closed",
  "tombstone",
  "pinned",
]);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

export const IssueTypeSchema = z.enum([
  "task",
  "bug",
  "feature",
  "epic",
  "chore",
  "docs",
  "question",
]);
export type IssueType = z.infer<typeof IssueTypeSchema>;

export const IssueSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable().optional().transform(emptyString),
    acceptance_criteria: z.string().nullable().optional().transform(emptyString),
    status: IssueStatusSchema,
    priority: z.number().int().min(0).max(4).default(2),
    issue_type: IssueTypeSchema,
    labels: z.array(z.string()).default([]),
    assignee: z.string().nullable().optional(),
    agent_context: z.unknown().optional(),
    inherited_context: z.unknown().optional(),
    dependents: z.array(z.unknown()).optional(),
    dependencies: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type Issue = z.infer<typeof IssueSchema>;

function emptyString(value: string | null | undefined): string {
  return value ?? "";
}

export const ReviewFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string().min(1),
  detail: z.string().min(1),
  file: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  remediation: z.string().min(1),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const TestExecutionSchema = z.object({
  command: z.string(),
  outcome: z.enum(["passed", "failed", "not_run"]),
  detail: z.string(),
});

export type TestExecution = z.infer<typeof TestExecutionSchema>;

export const ReviewResultSchema = z.object({
  verdict: z.enum(["approved", "changes_requested", "blocked"]),
  summary: z.string(),
  revision: z.string().nullable(),
  findings: z.array(ReviewFindingSchema),
  tests: z.array(TestExecutionSchema),
  residualRisks: z.array(z.string()),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const ImplementationResultSchema = z.object({
  status: z.enum(["completed", "blocked"]),
  summary: z.string(),
  changedFiles: z.array(z.string()),
  tests: z.array(TestExecutionSchema),
  blockers: z.array(z.string()),
});

export type ImplementationResult = z.infer<typeof ImplementationResultSchema>;

export const RuntimeKindSchema = z.enum(["sdk", "herdr"]);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

export const AgentRoleSchema = z.enum(["orchestrator", "implementation", "review"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export const AGENT_ROLES = AgentRoleSchema.options;

export const ReasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ModelIdSchema = z.string().trim().min(1);

export const AgentRoleSettingsSchema = z.object({
  model: ModelIdSchema.nullable(),
  reasoningEffort: ReasoningEffortSchema,
});
export type AgentRoleSettings = z.infer<typeof AgentRoleSettingsSchema>;

/** Persisted future-thread preferences. Null inherits the corresponding run-wide/default value. */
export const AgentRolePreferencesSchema = z.object({
  model: ModelIdSchema.nullable(),
  reasoningEffort: ReasoningEffortSchema.nullable(),
});
export type AgentRolePreferences = z.infer<typeof AgentRolePreferencesSchema>;

export const DEFAULT_AGENT_SETTINGS = {
  orchestrator: { model: null, reasoningEffort: "high" },
  implementation: { model: null, reasoningEffort: "high" },
  review: { model: null, reasoningEffort: "xhigh" },
} as const satisfies Record<AgentRole, AgentRoleSettings>;

export const DEFAULT_AGENT_PREFERENCES = {
  orchestrator: { model: null, reasoningEffort: null },
  implementation: { model: null, reasoningEffort: null },
  review: { model: null, reasoningEffort: null },
} as const satisfies Record<AgentRole, AgentRolePreferences>;

export const AgentSettingsSchema = z.object({
  orchestrator: AgentRoleSettingsSchema,
  implementation: AgentRoleSettingsSchema,
  review: AgentRoleSettingsSchema,
});
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

export const AgentPreferencesSchema = z.object({
  orchestrator: AgentRolePreferencesSchema,
  implementation: AgentRolePreferencesSchema,
  review: AgentRolePreferencesSchema,
});
export type AgentPreferences = z.infer<typeof AgentPreferencesSchema>;

export type AgentSettingsSource = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  agentSettings: AgentPreferences;
};

export const ORCHESTRATOR_MODEL = "gpt-6-astra";
export const AstraReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

/** The coordinator never inherits a worker model or silently falls back. */
export function resolveAgentRoleSettings(
  source: AgentSettingsSource,
  role: AgentRole,
): AgentRoleSettings {
  const preference = source.agentSettings[role];
  if (role === "orchestrator") {
    if (preference.model !== null && preference.model !== ORCHESTRATOR_MODEL)
      throw new Error(`Orchestration requires ${ORCHESTRATOR_MODEL}`);
    const effort = preference.reasoningEffort ?? "high";
    if (!AstraReasoningEffortSchema.safeParse(effort).success)
      throw new Error(
        `${ORCHESTRATOR_MODEL} supports reasoning efforts: ${AstraReasoningEffortSchema.options.join(", ")}`,
      );
    return { model: ORCHESTRATOR_MODEL, reasoningEffort: effort };
  }
  return AgentRoleSettingsSchema.parse({
    model: preference.model ?? source.model,
    reasoningEffort:
      preference.reasoningEffort ??
      source.reasoningEffort ??
      DEFAULT_AGENT_SETTINGS[role].reasoningEffort,
  });
}

export function resolveAgentSettings(source: AgentSettingsSource): AgentSettings {
  return AgentSettingsSchema.parse(
    Object.fromEntries(AGENT_ROLES.map((role) => [role, resolveAgentRoleSettings(source, role)])),
  );
}

export const ResolvedAgentRoleSettingsSchema = AgentRoleSettingsSchema.extend({
  model: ModelIdSchema,
});
export type ResolvedAgentRoleSettings = z.infer<typeof ResolvedAgentRoleSettingsSchema>;

export const SdkAgentSessionContractSchema = z
  .strictObject({
    runtime: z.literal("sdk"),
    requested: AgentRoleSettingsSchema.readonly(),
    effective: ResolvedAgentRoleSettingsSchema.readonly(),
  })
  .readonly();
export type SdkAgentSessionContract = z.infer<typeof SdkAgentSessionContractSchema>;

export const HerdrAgentSessionContractSchema = z
  .strictObject({
    runtime: z.literal("herdr"),
    requested: AgentRoleSettingsSchema.readonly(),
    effective: AgentRoleSettingsSchema.readonly(),
  })
  .readonly();
export type HerdrAgentSessionContract = z.infer<typeof HerdrAgentSessionContractSchema>;

export const AgentSessionContractSchema = z.discriminatedUnion("runtime", [
  SdkAgentSessionContractSchema,
  HerdrAgentSessionContractSchema,
]);
export type AgentSessionContract = z.infer<typeof AgentSessionContractSchema>;

export const RUN_STATE_SCHEMA_VERSION = 3;

export const CommonGitDirectorySchema = z.strictObject({
  path: z.string().startsWith("/"),
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
});
export type CommonGitDirectory = z.infer<typeof CommonGitDirectorySchema>;

export const RuntimeConfigurationSchema = z.strictObject({
  commonDirectory: CommonGitDirectorySchema,
  executable: z.string().startsWith("/"),
  trackerExecutable: z.string().startsWith("/"),
  runtimeRoot: z.string().startsWith("/"),
  workspaceRoot: z.string().startsWith("/"),
  authCachePath: z.string().startsWith("/").nullable(),
  turnTimeoutMs: z.number().int().min(1).max(21_600_000),
  herdr: z
    .strictObject({
      executable: z.string().startsWith("/"),
      sessionName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
      workspaceId: z.string().min(1).max(256),
    })
    .nullable(),
});
export type RuntimeConfiguration = z.infer<typeof RuntimeConfigurationSchema>;

/** Immutable run identity; runtime selection changes only through explicit guarded handoff. */
export const RunStateSchema = z
  .strictObject({
    stateSchemaVersion: z.literal(RUN_STATE_SCHEMA_VERSION),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    repoPath: z.string().startsWith("/"),
    epicId: z.string().min(1),
    epicTitle: z.string().min(1),
    epicBaseRevision: z.string().min(1),
    model: ModelIdSchema.nullable(),
    reasoningEffort: ReasoningEffortSchema.nullable(),
    runtime: RuntimeKindSchema,
    agentSettings: AgentPreferencesSchema,
    runtimeConfiguration: RuntimeConfigurationSchema.nullable(),
    totalTasks: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((state, context) => {
    try {
      resolveAgentRoleSettings(state, "orchestrator");
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["agentSettings", "orchestrator"],
        message: error instanceof Error ? error.message : "Invalid coordinator settings",
      });
    }
    if (
      state.runtimeConfiguration &&
      (state.runtime === "herdr") !== (state.runtimeConfiguration.herdr !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["runtimeConfiguration"],
        message: "Native endpoint must match the selected runtime",
      });
  });
export type RunState = z.infer<typeof RunStateSchema>;

export const EventLevelSchema = z.enum(["debug", "info", "success", "warning", "error"]);
export type EventLevel = z.infer<typeof EventLevelSchema>;

export const EngineEventSchema = z.object({
  id: z.number().int().optional(),
  runId: z.string(),
  at: z.string(),
  level: EventLevelSchema,
  kind: z.string(),
  message: z.string(),
  detail: z.string().nullable().default(null),
});

export type EngineEvent = z.infer<typeof EngineEventSchema>;

const refinementKeywords = new Set([
  "$schema",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxLength",
  "maximum",
  "minLength",
  "minimum",
  "multipleOf",
  "pattern",
]);

function normalizeAgentOutputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeAgentOutputSchema);
  if (!value || typeof value !== "object") return value;

  const normalized = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !refinementKeywords.has(key))
      .map(([key, entry]) => [key, normalizeAgentOutputSchema(entry)]),
  );
  const variants = normalized.anyOf;
  if (
    Array.isArray(variants) &&
    variants.every(
      (variant) =>
        variant &&
        typeof variant === "object" &&
        Object.keys(variant).length === 1 &&
        typeof (variant as { type?: unknown }).type === "string",
    )
  ) {
    const { anyOf: _, ...rest } = normalized;
    return { ...rest, type: variants.map((variant) => (variant as { type: string }).type) };
  }
  return normalized;
}

export function agentOutputSchema(schema: z.ZodType): Record<string, unknown> {
  // The agent boundary intentionally describes shape only. Zod remains the
  // canonical validator for refinements after the structured response arrives.
  return normalizeAgentOutputSchema(z.toJSONSchema(schema)) as Record<string, unknown>;
}

export const REVIEW_OUTPUT_SCHEMA = agentOutputSchema(ReviewResultSchema);
export const IMPLEMENTATION_OUTPUT_SCHEMA = agentOutputSchema(ImplementationResultSchema);
