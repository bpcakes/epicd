import { z } from "zod";

export const IssueSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().default("Untitled issue"),
    description: z.string().default(""),
    acceptance_criteria: z.string().default(""),
    status: z.string().default("open"),
    priority: z.number().int().min(0).max(4).default(2),
    issue_type: z.string().default("task"),
    labels: z.array(z.string()).default([]),
    dependents: z.array(z.unknown()).optional(),
    dependencies: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type Issue = z.infer<typeof IssueSchema>;

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

export const RunStateSchema = z.object({
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

export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approved", "changes_requested", "blocked"] },
    summary: { type: "string" },
    revision: { type: ["string", "null"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          title: { type: "string" },
          detail: { type: "string" },
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
          remediation: { type: "string" },
        },
        required: ["severity", "title", "detail", "file", "line", "remediation"],
        additionalProperties: false,
      },
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          outcome: { type: "string", enum: ["passed", "failed", "not_run"] },
          detail: { type: "string" },
        },
        required: ["command", "outcome", "detail"],
        additionalProperties: false,
      },
    },
    residualRisks: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "summary", "revision", "findings", "tests", "residualRisks"],
  additionalProperties: false,
} as const;

export const IMPLEMENTATION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    tests: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          outcome: { type: "string", enum: ["passed", "failed", "not_run"] },
          detail: { type: "string" },
        },
        required: ["command", "outcome", "detail"],
        additionalProperties: false,
      },
    },
    blockers: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "changedFiles", "tests", "blockers"],
  additionalProperties: false,
} as const;

export const SELECTION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    candidateId: { type: "string" },
    rationale: { type: "string" },
    dependencyNotes: { type: "array", items: { type: "string" } },
    riskNotes: { type: "array", items: { type: "string" } },
  },
  required: ["candidateId", "rationale", "dependencyNotes", "riskNotes"],
  additionalProperties: false,
} as const;
