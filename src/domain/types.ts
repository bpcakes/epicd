import { createHash } from "node:crypto";
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

export const AgentRoleSchema = z.enum(["orchestrator", "implementation", "review"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export const AGENT_ROLES = AgentRoleSchema.options;

export const AgentAccessModeSchema = z.enum(["sandboxed", "danger-full-access"]);
export type AgentAccessMode = z.infer<typeof AgentAccessModeSchema>;

export const AgentCleanupActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session"),
    runtime: RuntimeKindSchema,
    role: AgentRoleSchema,
    sessionId: z.string().min(1),
    reason: z.literal("unverifiable-session-contract").optional(),
  }),
  z.object({
    kind: z.literal("run"),
    runtime: RuntimeKindSchema,
  }),
]);
export type AgentCleanupAction = z.infer<typeof AgentCleanupActionSchema>;

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

export const DEFAULT_MAX_REVIEW_PASSES = 3;

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

/** Resolves the one inheritance contract used by execution, status, and the TUI. */
export function resolveAgentRoleSettings(
  source: AgentSettingsSource,
  role: AgentRole,
): AgentRoleSettings {
  const preferences = source.agentSettings[role];
  return AgentRoleSettingsSchema.parse({
    model: preferences.model ?? source.model,
    reasoningEffort:
      preferences.reasoningEffort ??
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
  .object({
    runtime: z.literal("sdk"),
    requested: AgentRoleSettingsSchema.readonly(),
    effective: ResolvedAgentRoleSettingsSchema.readonly(),
  })
  .readonly();
export type SdkAgentSessionContract = z.infer<typeof SdkAgentSessionContractSchema>;

export const HerdrAgentSessionContractSchema = z
  .object({
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

export const AgentSessionStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("inactive") }),
  z.object({
    status: z.literal("unresolved"),
    sessionId: z.string().min(1),
    settings: AgentRoleSettingsSchema,
  }),
  z.object({
    status: z.literal("active"),
    sessionId: z.string().min(1),
    contract: AgentSessionContractSchema,
  }),
]);
export type AgentSessionState = z.infer<typeof AgentSessionStateSchema>;

export const AgentSessionsSchema = z.object({
  orchestrator: AgentSessionStateSchema,
  implementation: AgentSessionStateSchema,
  review: AgentSessionStateSchema,
});
export type AgentSessions = z.infer<typeof AgentSessionsSchema>;

export function createInactiveAgentSessions(): AgentSessions {
  return {
    orchestrator: { status: "inactive" },
    implementation: { status: "inactive" },
    review: { status: "inactive" },
  };
}

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

export const RUN_STATE_SCHEMA_VERSION = 1;

const RunStateBaseSchema = z.object({
  stateSchemaVersion: z.literal(RUN_STATE_SCHEMA_VERSION),
  runId: z.string(),
  agentNamespace: z.string().regex(/^[a-f0-9]{20}$/),
  repoPath: z.string(),
  epicId: z.string(),
  epicTitle: z.string(),
  model: ModelIdSchema.nullable(),
  reasoningEffort: ReasoningEffortSchema.nullable().default(null),
  runtime: RuntimeKindSchema.default("sdk"),
  agentSettings: AgentPreferencesSchema.default(() => ({
    orchestrator: { ...DEFAULT_AGENT_PREFERENCES.orchestrator },
    implementation: { ...DEFAULT_AGENT_PREFERENCES.implementation },
    review: { ...DEFAULT_AGENT_PREFERENCES.review },
  })),
  agentAccessMode: AgentAccessModeSchema.default("sandboxed"),
  // Runs persisted before this setting existed used the historical default of five.
  maxReviewPasses: z.number().int().positive().default(5),
  phase: RunPhaseSchema,
  currentBeadId: z.string().nullable(),
  currentBeadTitle: z.string().nullable(),
  agentSessions: AgentSessionsSchema.default(createInactiveAgentSessions),
  pendingAgentCleanup: z.array(AgentCleanupActionSchema).default([]),
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

function migrateRunStateInput(input: unknown): unknown {
  if (!isUnknownRecord(input)) return input;
  const state = { ...input };
  if (
    state.stateSchemaVersion !== undefined &&
    state.stateSchemaVersion !== RUN_STATE_SCHEMA_VERSION
  )
    return state;
  state.stateSchemaVersion = RUN_STATE_SCHEMA_VERSION;
  if (state.agentAccessMode === undefined) {
    state.agentAccessMode =
      state.dangerouslyBypassApprovalsAndSandbox === true ? "danger-full-access" : "sandboxed";
  }
  if (state.agentNamespace === undefined && typeof state.runId === "string") {
    state.agentNamespace = createHash("sha256").update(state.runId).digest("hex").slice(0, 20);
  }
  const sessions =
    state.agentSessions === undefined ? migrateLegacyAgentSessions(state) : state.agentSessions;
  state.agentSessions = migrateSessionContracts(state, sessions);
  return state;
}

function migrateSessionContracts(state: Record<string, unknown>, sessions: unknown): unknown {
  if (!isUnknownRecord(sessions)) return sessions;
  const runtime = state.runtime === "herdr" ? "herdr" : "sdk";
  return Object.fromEntries(
    Object.entries(sessions).map(([role, session]) => {
      if (!isUnknownRecord(session) || session.status !== "active") return [role, session];

      if (session.contract === undefined) {
        const settings = AgentRoleSettingsSchema.safeParse(session.settings);
        if (!settings.success) return [role, session];
        if (runtime === "sdk" && settings.data.model === null) {
          return [
            role,
            { status: "unresolved", sessionId: session.sessionId, settings: settings.data },
          ];
        }
        return [
          role,
          {
            status: "active",
            sessionId: session.sessionId,
            contract: {
              runtime,
              requested: settings.data,
              effective: settings.data,
            },
          },
        ];
      }

      if (!isUnknownRecord(session.contract) || session.contract.runtime !== undefined) {
        return [role, session];
      }
      const requested = AgentRoleSettingsSchema.safeParse(session.contract.requested);
      const effective = AgentRoleSettingsSchema.safeParse(session.contract.effective);
      if (!requested.success || !effective.success) return [role, session];
      if (runtime === "sdk" && effective.data.model === null) {
        return [
          role,
          { status: "unresolved", sessionId: session.sessionId, settings: requested.data },
        ];
      }
      return [
        role,
        {
          status: "active",
          sessionId: session.sessionId,
          contract: { runtime, requested: requested.data, effective: effective.data },
        },
      ];
    }),
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LegacyActiveAgentSettingsSchema = z.object({
  orchestrator: AgentRoleSettingsSchema.nullable(),
  implementation: AgentRoleSettingsSchema.nullable(),
  review: AgentRoleSettingsSchema.nullable(),
});

function migrateLegacyAgentSessions(state: Record<string, unknown>): AgentSessions {
  const configured = AgentPreferencesSchema.safeParse(state.agentSettings);
  const activeSettings = LegacyActiveAgentSettingsSchema.safeParse(state.activeAgentSettings);
  const fallbackModel = typeof state.model === "string" && state.model ? state.model : null;
  const legacySessionIds: Record<AgentRole, unknown> = {
    orchestrator: state.orchestratorThreadId,
    implementation: state.implementationThreadId,
    review: state.reviewThreadId,
  };
  const sessions = createInactiveAgentSessions();

  for (const role of AGENT_ROLES) {
    const sessionId = legacySessionIds[role];
    if (typeof sessionId !== "string" || !sessionId) continue;
    const configuredSettings =
      (activeSettings.success ? activeSettings.data[role] : null) ??
      (configured.success ? configured.data[role] : DEFAULT_AGENT_PREFERENCES[role]);
    const settings = {
      ...configuredSettings,
      model: configuredSettings.model ?? fallbackModel,
      reasoningEffort:
        configuredSettings.reasoningEffort ??
        ReasoningEffortSchema.safeParse(state.reasoningEffort).data ??
        DEFAULT_AGENT_SETTINGS[role].reasoningEffort,
    };
    if (state.runtime === "herdr") {
      sessions[role] = {
        status: "active",
        sessionId,
        contract: { runtime: "herdr", requested: settings, effective: settings },
      };
    } else if (settings.model === null) {
      sessions[role] = { status: "unresolved", sessionId, settings };
    } else {
      sessions[role] = {
        status: "active",
        sessionId,
        contract: {
          runtime: "sdk",
          requested: settings,
          effective: { ...settings, model: settings.model },
        },
      };
    }
  }
  return sessions;
}

type RequiredRunStateField =
  "currentBeadId" | "baseRevision" | "candidateRevision" | "reviewedFingerprint" | "reviewedTree";

const requiredFieldsByPhase: Partial<Record<RunPhase, readonly RequiredRunStateField[]>> = {
  claiming: ["currentBeadId", "baseRevision"],
  implementing: ["currentBeadId", "baseRevision"],
  reviewing: ["currentBeadId", "baseRevision"],
  fixing: ["currentBeadId", "baseRevision"],
  committing: ["currentBeadId", "baseRevision", "reviewedFingerprint", "reviewedTree"],
  verifying: ["currentBeadId", "baseRevision", "candidateRevision"],
  closing: ["currentBeadId", "baseRevision", "candidateRevision"],
};

export const RunStateSchema = z
  .preprocess(migrateRunStateInput, RunStateBaseSchema)
  .superRefine((state, context) => {
    const activePhase =
      state.phase === "paused" || state.phase === "blocked" ? state.resumePhase : state.phase;
    if (activePhase) {
      const requiredFields: readonly RequiredRunStateField[] =
        requiredFieldsByPhase[activePhase] ?? [];
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
    }
    const activeSessionIds = new Set(
      AGENT_ROLES.flatMap((role) => {
        const session = state.agentSessions[role];
        return session.status === "inactive" ? [] : [session.sessionId];
      }),
    );
    for (const role of AGENT_ROLES) {
      const session = state.agentSessions[role];
      if (session.status === "active" && session.contract.runtime !== state.runtime) {
        context.addIssue({
          code: "custom",
          path: ["agentSessions", role, "contract", "runtime"],
          message: `${role} session runtime must match the run runtime`,
        });
      }
      if (session.status === "unresolved" && state.runtime !== "sdk") {
        context.addIssue({
          code: "custom",
          path: ["agentSessions", role, "status"],
          message: `${role} unresolved sessions are valid only for the SDK runtime`,
        });
      }
    }
    const cleanupKeys = new Set<string>();
    for (const [index, action] of state.pendingAgentCleanup.entries()) {
      const key =
        action.kind === "run"
          ? `run:${action.runtime}`
          : `session:${action.runtime}:${action.sessionId}`;
      if (cleanupKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["pendingAgentCleanup", index],
          message: "pendingAgentCleanup must not contain duplicate actions",
        });
      }
      cleanupKeys.add(key);
      if (action.kind === "session" && activeSessionIds.has(action.sessionId)) {
        context.addIssue({
          code: "custom",
          path: ["pendingAgentCleanup", index, "sessionId"],
          message: "a session cannot be active and pending cleanup at the same time",
        });
      }
    }
  });

export type RunState = z.infer<typeof RunStateSchema>;

/** Returns the persisted session identity for every non-inactive lifecycle state. */
export function runAgentSessionId(
  state: Pick<RunState, "agentSessions">,
  role: AgentRole,
): string | null {
  const session = state.agentSessions[role];
  return session.status === "inactive" ? null : session.sessionId;
}

/** A run owns recoverable work until workflow, sessions, and durable cleanup are complete. */
export function runRecoveryKind(
  state: Pick<RunState, "phase" | "agentSessions" | "pendingAgentCleanup"> &
    Partial<Pick<RunState, "lastError">>,
): "workflow" | "cleanup" | "diagnostic" | null {
  if (state.phase !== "complete") return "workflow";
  if (
    state.pendingAgentCleanup.length > 0 ||
    AGENT_ROLES.some((role) => state.agentSessions[role].status !== "inactive")
  )
    return "cleanup";
  return state.lastError != null ? "diagnostic" : null;
}

export function runNeedsResume(state: Parameters<typeof runRecoveryKind>[0]): boolean {
  return runRecoveryKind(state) !== null;
}

/** Applies stateful compatibility migrations only after a controller owns the run lease. */
export function prepareRunStateForControl(state: RunState): RunState {
  const source = RunStateSchema.parse(state);
  const agentSessions: AgentSessions = { ...source.agentSessions };
  const pendingAgentCleanup: AgentCleanupAction[] = [...source.pendingAgentCleanup];

  for (const role of AGENT_ROLES) {
    const session = agentSessions[role];
    if (source.phase === "complete" && session.status !== "inactive") {
      agentSessions[role] = { status: "inactive" };
      const duplicate = pendingAgentCleanup.some(
        (action) =>
          action.kind === "session" &&
          action.runtime === source.runtime &&
          action.sessionId === session.sessionId,
      );
      if (!duplicate) {
        pendingAgentCleanup.push({
          kind: "session",
          runtime: source.runtime,
          role,
          sessionId: session.sessionId,
          ...(session.status === "unresolved" && source.runtime === "sdk"
            ? { reason: "unverifiable-session-contract" as const }
            : {}),
        });
      }
      continue;
    }
    if (session.status !== "unresolved") continue;
    agentSessions[role] = { status: "inactive" };
    const duplicate = pendingAgentCleanup.some(
      (action) =>
        action.kind === "session" &&
        action.runtime === "sdk" &&
        action.sessionId === session.sessionId,
    );
    if (!duplicate) {
      pendingAgentCleanup.push({
        kind: "session",
        runtime: "sdk",
        role,
        sessionId: session.sessionId,
        reason: "unverifiable-session-contract",
      });
    }
  }

  return RunStateSchema.parse({ ...source, agentSessions, pendingAgentCleanup });
}

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
  blockedIssues?: Issue[];
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
