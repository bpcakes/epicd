import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_PREFERENCES } from "../src/domain/types.js";
import {
  cycleAgentReasoningEffort,
  normalizeAgentModelInput,
  updateAgentPreference,
} from "../src/tui/agent-config.js";

describe("agent configuration draft", () => {
  it("normalizes edited models and supports explicit inheritance", () => {
    expect(normalizeAgentModelInput("  gpt-review  ")).toBe("gpt-review");
    expect(normalizeAgentModelInput("   ")).toBeNull();

    const selected = updateAgentPreference(DEFAULT_AGENT_PREFERENCES, "review", {
      model: "gpt-review",
      reasoningEffort: "max",
    });
    expect(selected.review).toEqual({ model: "gpt-review", reasoningEffort: "max" });

    const inherited = updateAgentPreference(selected, "review", {
      model: null,
      reasoningEffort: null,
    });
    expect(inherited.review).toEqual({ model: null, reasoningEffort: null });
  });

  it("cycles from the effective inherited effort in both directions", () => {
    const forward = cycleAgentReasoningEffort(
      DEFAULT_AGENT_PREFERENCES,
      "implementation",
      null,
      "high",
      1,
    );
    expect(forward.implementation.reasoningEffort).toBe("xhigh");

    const backward = cycleAgentReasoningEffort(forward, "implementation", null, "high", -1);
    expect(backward.implementation.reasoningEffort).toBe("high");
  });

  it("does not mutate the persisted preferences used to seed a draft", () => {
    const initial = structuredClone(DEFAULT_AGENT_PREFERENCES);
    const updated = updateAgentPreference(initial, "orchestrator", { model: "gpt-new" });

    expect(initial.orchestrator.model).toBeNull();
    expect(updated.orchestrator.model).toBe("gpt-new");
  });
});
