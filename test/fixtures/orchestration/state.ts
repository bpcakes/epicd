import {
  createInactiveAgentSessions,
  DEFAULT_AGENT_PREFERENCES,
  SdkAgentSessionContractSchema,
  type RunState,
} from "../../../src/domain/types.js";

export function currentSession(sessionId: string) {
  const settings = { model: "gpt-pinned", reasoningEffort: "xhigh" };
  return {
    status: "active" as const,
    sessionId,
    contract: SdkAgentSessionContractSchema.parse({
      runtime: "sdk",
      requested: settings,
      effective: settings,
    }),
  };
}

export function initialRun(runId = "adaptive-test"): RunState {
  const at = new Date().toISOString();
  return {
    stateSchemaVersion: 2,
    orchestrationMode: "legacy",
    runId,
    agentNamespace: "0123456789abcdef0123",
    repoPath: `/repo/${runId}`,
    epicId: "demo",
    epicTitle: "Demonstration",
    model: "worker-model",
    reasoningEffort: null,
    runtime: "sdk",
    agentSettings: structuredClone(DEFAULT_AGENT_PREFERENCES),
    agentAccessMode: "sandboxed",
    maxReviewPasses: 3,
    phase: "selecting",
    currentBeadId: null,
    currentBeadTitle: null,
    agentSessions: createInactiveAgentSessions(),
    pendingAgentCleanup: [],
    baseRevision: null,
    epicBaseRevision: "initial-revision",
    candidateRevision: null,
    reviewBaselineFingerprint: null,
    reviewedFingerprint: null,
    reviewedTree: null,
    completedTasks: 0,
    totalTasks: 1,
    reviewPass: 0,
    pendingFindings: [],
    recentOutcomes: [],
    lastReviewSummary: null,
    resumePhase: null,
    lastError: null,
    createdAt: at,
    updatedAt: at,
  };
}
