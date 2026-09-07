import { z } from "zod";
import {
  AgentAccessModeSchema,
  AgentCleanupActionSchema,
  AgentPreferencesSchema,
  AGENT_ROLES,
  AgentSettingsSchema,
  AgentSessionsSchema,
  ModelIdSchema,
  ReasoningEffortSchema,
  ReviewFindingSchema,
  resolveAgentSettings,
  RunPhaseSchema,
  RuntimeKindSchema,
  type RunState,
} from "./domain/types.js";
import type { ControllerLeaseInfo } from "./adapters/store.js";

export const ControllerLeaseInfoSchema = z.object({
  pid: z.number().int().positive(),
  // Lease identities are opaque compare-and-swap tokens, not a public UUID commitment.
  leaseId: z.string().min(1),
  acquiredAt: z.string(),
  alive: z.boolean(),
});

export const RunStatusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string(),
  agentNamespace: z.string(),
  repoPath: z.string(),
  epicId: z.string(),
  epicTitle: z.string(),
  phase: RunPhaseSchema,
  resumePhase: RunPhaseSchema.nullable(),
  runtime: RuntimeKindSchema,
  agentAccessMode: AgentAccessModeSchema,
  model: ModelIdSchema.nullable(),
  reasoningEffort: ReasoningEffortSchema.nullable(),
  agentSettings: AgentSettingsSchema,
  agentPreferences: AgentPreferencesSchema,
  controllerLease: ControllerLeaseInfoSchema.nullable(),
  agentSessions: AgentSessionsSchema,
  maxReviewPasses: z.number().int().positive(),
  currentBeadId: z.string().nullable(),
  currentBeadTitle: z.string().nullable(),
  completedTasks: z.number().int().nonnegative(),
  totalTasks: z.number().int().nonnegative(),
  reviewPass: z.number().int().nonnegative(),
  pendingFindings: z.array(ReviewFindingSchema),
  pendingAgentCleanup: z.array(AgentCleanupActionSchema),
  baseRevision: z.string().nullable(),
  epicBaseRevision: z.string(),
  candidateRevision: z.string().nullable(),
  reviewBaselineFingerprint: z.string().nullable(),
  reviewedFingerprint: z.string().nullable(),
  reviewedTree: z.string().nullable(),
  recentOutcomes: z.array(
    z.object({
      beadId: z.string(),
      title: z.string(),
      verifiedRevision: z.string(),
      reviewSummary: z.string(),
    }),
  ),
  lastReviewSummary: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type RunStatus = z.infer<typeof RunStatusSchema>;

function humanStatusField(label: string, value: string): string {
  const [first = "", ...continuation] = value.split(/\r?\n/);
  return `\n  ${label}: ${first}${continuation.map((line) => `\n    ${line}`).join("")}`;
}

export function humanRunStatus(state: RunState, lease: ControllerLeaseInfo | null = null): string {
  const access = state.agentAccessMode === "danger-full-access" ? " · FULL ACCESS" : "";
  const cleanup =
    state.pendingAgentCleanup.length > 0
      ? ` · CLEANUP PENDING (${state.pendingAgentCleanup.length})`
      : "";
  const controller = lease
    ? `\n  controller pid ${lease.pid} · lease ${lease.leaseId} · ${lease.alive ? "alive" : "stale"}`
    : "";
  const sessions = AGENT_ROLES.flatMap((role) => {
    const session = state.agentSessions[role];
    return session.status === "inactive" ? [] : [`${role} (${session.status})`];
  });
  const sessionRecovery = sessions.length > 0 ? `\n  session recovery: ${sessions.join(", ")}` : "";
  const lastError = state.lastError ? humanStatusField("last error", state.lastError) : "";
  return `${state.epicId} (${state.runId})\n  ${state.phase} · ${state.runtime}${access}${cleanup} · ${state.completedTasks}/${state.totalTasks} tasks · updated ${state.updatedAt}${controller}${sessionRecovery}${lastError}`;
}

/** Stable machine-readable boundary for `epicd status --json`. */
export function runStatusView(
  state: RunState,
  controllerLease: ControllerLeaseInfo | null = null,
): RunStatus {
  return RunStatusSchema.parse({
    schemaVersion: 1,
    runId: state.runId,
    agentNamespace: state.agentNamespace,
    repoPath: state.repoPath,
    epicId: state.epicId,
    epicTitle: state.epicTitle,
    phase: state.phase,
    resumePhase: state.resumePhase,
    runtime: state.runtime,
    agentAccessMode: state.agentAccessMode,
    model: state.model,
    reasoningEffort: state.reasoningEffort ?? null,
    agentSettings: resolveAgentSettings(state),
    agentPreferences: state.agentSettings,
    controllerLease,
    agentSessions: state.agentSessions,
    maxReviewPasses: state.maxReviewPasses,
    currentBeadId: state.currentBeadId,
    currentBeadTitle: state.currentBeadTitle,
    completedTasks: state.completedTasks,
    totalTasks: state.totalTasks,
    reviewPass: state.reviewPass,
    pendingFindings: state.pendingFindings,
    pendingAgentCleanup: state.pendingAgentCleanup,
    baseRevision: state.baseRevision,
    epicBaseRevision: state.epicBaseRevision,
    candidateRevision: state.candidateRevision,
    reviewBaselineFingerprint: state.reviewBaselineFingerprint,
    reviewedFingerprint: state.reviewedFingerprint,
    reviewedTree: state.reviewedTree,
    recentOutcomes: state.recentOutcomes,
    lastReviewSummary: state.lastReviewSummary,
    lastError: state.lastError,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  });
}
