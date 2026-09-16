import { describe, expect, it } from "vitest";
import {
  AstraReasoningEffortSchema,
  resolveAgentRoleSettings,
  RunStateSchema,
  SdkAgentSessionContractSchema,
} from "../src/domain/types.js";
import { initialRun } from "./fixtures/orchestration/state.js";
describe("pinned coordinator and immutable session contracts", () => {
  it("pins Astra/high independently of worker defaults", () => {
    const state = initialRun();
    state.model = "worker";
    state.reasoningEffort = "ultra";
    expect(resolveAgentRoleSettings(state, "orchestrator")).toEqual({
      model: "gpt-6-astra",
      reasoningEffort: "high",
    });
    expect(resolveAgentRoleSettings(state, "implementation")).toEqual({
      model: "worker",
      reasoningEffort: "ultra",
    });
  });
  it.each(AstraReasoningEffortSchema.options)(
    "supports an explicitly selected Astra %s effort",
    (effort) => {
      const state = initialRun();
      state.agentSettings.orchestrator.reasoningEffort = effort;
      expect(resolveAgentRoleSettings(state, "orchestrator").reasoningEffort).toBe(effort);
    },
  );
  it.each(["none", "minimal", "ultra", "persistent"])(
    "rejects unsupported coordinator effort %s without fallback",
    (effort) => {
      const state = initialRun();
      expect(
        RunStateSchema.safeParse({
          ...state,
          agentSettings: {
            ...state.agentSettings,
            orchestrator: { model: "gpt-6-astra", reasoningEffort: effort },
          },
        }).success,
      ).toBe(false);
    },
  );
  it("requires an effective concrete SDK model and freezes the launch contract", () => {
    const requested = { model: null, reasoningEffort: "high" };
    expect(
      SdkAgentSessionContractSchema.safeParse({
        backend: "codex",
        runtime: "sdk",
        requested,
        effective: requested,
      }).success,
    ).toBe(false);
    const contract = SdkAgentSessionContractSchema.parse({
      backend: "codex",
      runtime: "sdk",
      requested,
      effective: { ...requested, model: "worker" },
    });
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.effective)).toBe(true);
  });
});
