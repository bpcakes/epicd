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

export const SelectionResultSchema = z.object({
  candidateId: z.string(),
  rationale: z.string(),
  dependencyNotes: z.array(z.string()),
  riskNotes: z.array(z.string()),
});

export type SelectionResult = z.infer<typeof SelectionResultSchema>;

export const RuntimeKindSchema = z.enum(["sdk", "herdr"]);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

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

export const AgentRoleSettingsSchema = z.object({
  model: z.string().min(1).nullable(),
  reasoningEffort: ReasoningEffortSchema,
});
export type AgentRoleSettings = z.infer<typeof AgentRoleSettingsSchema>;

export const DEFAULT_AGENT_SETTINGS = {
  orchestrator: { model: null, reasoningEffort: "high" },
  implementation: { model: null, reasoningEffort: "high" },
  review: { model: null, reasoningEffort: "xhigh" },
} as const satisfies Record<string, AgentRoleSettings>;

export const AgentSettingsSchema = z.object({
  orchestrator: AgentRoleSettingsSchema,
  implementation: AgentRoleSettingsSchema,
  review: AgentRoleSettingsSchema,
});
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

export const RunPhaseSchema = z.enum([
  "preparing",
  "selecting",
  "claiming",
  "implementing",
  "reviewing",
  "fixing",
  "committing",
  "verifying",
  "closing",
  "final_review",
  "paused",
  "blocked",
  "complete",
]);

export type RunPhase = z.infer<typeof RunPhaseSchema>;

const RunStateBaseSchema = z.object({
  runId: z.string(),
  repoPath: z.string(),
  epicId: z.string(),
  epicTitle: z.string(),
  model: z.string().nullable(),
  runtime: RuntimeKindSchema.default("sdk"),
  agentSettings: AgentSettingsSchema.default(DEFAULT_AGENT_SETTINGS),
  phase: RunPhaseSchema,
  currentBeadId: z.string().nullable(),
  currentBeadTitle: z.string().nullable(),
  orchestratorThreadId: z.string().nullable(),
  implementationThreadId: z.string().nullable(),
  reviewThreadId: z.string().nullable(),
  baseRevision: z.string().nullable(),
  epicBaseRevision: z.string(),
  candidateRevision: z.string().nullable(),
  reviewBaselineFingerprint: z.string().nullable().default(null),
  reviewedFingerprint: z.string().nullable().default(null),
  reviewedTree: z.string().nullable().default(null),
  completedTasks: z.number().int().nonnegative(),
  totalTasks: z.number().int().nonnegative(),
  reviewPass: z.number().int().nonnegative(),
  pendingFindings: z.array(ReviewFindingSchema),
  recentOutcomes: z.array(
    z.object({
      beadId: z.string(),
      title: z.string(),
      verifiedRevision: z.string(),
      reviewSummary: z.string(),
    }),
  ),
  lastReviewSummary: z.string().nullable(),
  resumePhase: RunPhaseSchema.nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type RequiredRunStateField =
  | "currentBeadId"
  | "baseRevision"
  | "implementationThreadId"
  | "candidateRevision"
  | "reviewedFingerprint"
  | "reviewedTree";

const requiredFieldsByPhase: Partial<Record<RunPhase, readonly RequiredRunStateField[]>> = {
  claiming: ["currentBeadId", "baseRevision"],
  implementing: ["currentBeadId", "baseRevision"],
  reviewing: ["currentBeadId", "baseRevision", "implementationThreadId"],
  fixing: ["currentBeadId", "baseRevision", "implementationThreadId"],
  committing: ["currentBeadId", "baseRevision", "reviewedFingerprint", "reviewedTree"],
  verifying: ["currentBeadId", "baseRevision", "candidateRevision"],
  closing: ["currentBeadId", "baseRevision", "candidateRevision"],
};

export const RunStateSchema = RunStateBaseSchema.superRefine((state, context) => {
  const activePhase =
    state.phase === "paused" || state.phase === "blocked" ? state.resumePhase : state.phase;
  if (!activePhase) return;

  const requiredFields: readonly RequiredRunStateField[] = requiredFieldsByPhase[activePhase] ?? [];
  for (const field of requiredFields) {
    if (!state[field]) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${field} is required while the run is ${activePhase}`,
      });
    }
  }
  if (activePhase === "fixing" && state.pendingFindings.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["pendingFindings"],
      message: "pendingFindings must not be empty while the run is fixing",
    });
  }
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

export type DoctorCheck = {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
};

export type EpicSnapshot = {
  epic: Issue;
  issues: Issue[];
  openIssues: Issue[];
  readyIssues: Issue[];
  triage: unknown;
  plan: unknown;
  graph: unknown;
};

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

function agentOutputSchema(schema: z.ZodType): Record<string, unknown> {
  // The agent boundary intentionally describes shape only. Zod remains the
  // canonical validator for refinements after the structured response arrives.
  return normalizeAgentOutputSchema(z.toJSONSchema(schema)) as Record<string, unknown>;
}

export const REVIEW_OUTPUT_SCHEMA = agentOutputSchema(ReviewResultSchema);
export const IMPLEMENTATION_OUTPUT_SCHEMA = agentOutputSchema(ImplementationResultSchema);
export const SELECTION_OUTPUT_SCHEMA = agentOutputSchema(SelectionResultSchema);
