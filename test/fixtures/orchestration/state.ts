import {
  DEFAULT_AGENT_PREFERENCES,
  RUN_STATE_SCHEMA_VERSION,
  type RunState,
} from "../../../src/domain/types.js";

export function initialRun(runId = "orchestrator-test"): RunState {
  const at = new Date().toISOString();
  return {
    stateSchemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId,
    repoPath: `/repo/${runId}`,
    epicId: "demo",
    epicTitle: "Demonstration",
    epicBaseRevision: "initial-revision",
    model: "worker-model",
    reasoningEffort: null,
    runtime: "sdk",
    agentSettings: structuredClone(DEFAULT_AGENT_PREFERENCES),
    runtimeConfiguration: null,
    totalTasks: 1,
    createdAt: at,
    updatedAt: at,
  };
}
