import { describe, expect, it } from "vitest";
import {
  createInactiveAgentSessions,
  DEFAULT_AGENT_PREFERENCES,
  type RunState,
} from "../src/domain/types.js";
import { resolveRunPreflight } from "../src/preflight.js";

function run(runtime: RunState["runtime"], phase: RunState["phase"]): RunState {
  const now = new Date().toISOString();
  return {
    stateSchemaVersion: 1,
    runId: "run-1",
    agentNamespace: "0123456789abcdef0123",
    repoPath: "/repo",
    epicId: "epic-1",
    epicTitle: "Epic",
    model: null,
    reasoningEffort: null,
    runtime,
    agentSettings: DEFAULT_AGENT_PREFERENCES,
    agentAccessMode: "sandboxed",
    maxReviewPasses: 3,
    phase,
    currentBeadId: null,
    currentBeadTitle: null,
    agentSessions: createInactiveAgentSessions(),
    pendingAgentCleanup: [],
    baseRevision: null,
    epicBaseRevision: "abc123",
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
    createdAt: now,
    updatedAt: now,
  };
}

describe("run preflight", () => {
  it("preserves a recovered run's runtime unless explicitly overridden", () => {
    const recovered = run("herdr", "blocked");

    expect(resolveRunPreflight(recovered)).toEqual({ runtime: "herdr", mode: "workflow" });
    expect(resolveRunPreflight(recovered, "sdk")).toEqual({
      runtime: "sdk",
      mode: "workflow",
    });
  });

  it("uses cleanup mode only for completed runs with outstanding cleanup", () => {
    const completed = run("herdr", "complete");
    completed.pendingAgentCleanup = [{ kind: "run", runtime: "herdr" }];

    expect(resolveRunPreflight(completed)).toEqual({ runtime: "herdr", mode: "cleanup" });
    expect(resolveRunPreflight(run("sdk", "complete"))).toEqual({
      runtime: "sdk",
      mode: "workflow",
    });
    expect(resolveRunPreflight(null)).toEqual({ runtime: "sdk", mode: "workflow" });
  });
});
