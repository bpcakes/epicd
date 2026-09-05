import { describe, expect, it } from "vitest";
import { agentOptions } from "../src/agent-options.js";
import { createInactiveAgentSessions, runNeedsResume } from "../src/domain/types.js";

describe("CLI agent options", () => {
  it("represents explicit per-role inheritance resets", () => {
    expect(
      agentOptions({
        model: "gpt-run-wide",
        reviewModelInherit: true,
        reviewReasoningInherit: true,
      }),
    ).toEqual({
      model: "gpt-run-wide",
      agentSettings: { review: { model: null, reasoningEffort: null } },
    });
  });

  it("preserves concrete role overrides", () => {
    expect(
      agentOptions({ implementationModel: "gpt-implementation", implementationReasoning: "high" }),
    ).toEqual({
      agentSettings: {
        implementation: { model: "gpt-implementation", reasoningEffort: "high" },
      },
    });
  });

  it("represents explicit run-wide provider-default resets", () => {
    expect(agentOptions({ modelInherit: true, reasoningInherit: true })).toEqual({
      model: null,
      reasoningEffort: null,
    });
  });
});

describe("run ownership", () => {
  it("keeps completed runs recoverable until cleanup finishes", () => {
    const inactive = createInactiveAgentSessions();
    expect(
      runNeedsResume({ phase: "complete", agentSessions: inactive, pendingAgentCleanup: [] }),
    ).toBe(false);
    expect(
      runNeedsResume({
        phase: "complete",
        agentSessions: inactive,
        pendingAgentCleanup: [{ kind: "run", runtime: "herdr" }],
      }),
    ).toBe(true);
    expect(
      runNeedsResume({ phase: "paused", agentSessions: inactive, pendingAgentCleanup: [] }),
    ).toBe(true);
    expect(
      runNeedsResume({
        phase: "complete",
        agentSessions: inactive,
        pendingAgentCleanup: [],
        lastError: "cleanup controller failed",
      }),
    ).toBe(true);
    expect(
      runNeedsResume({
        phase: "complete",
        agentSessions: {
          ...inactive,
          review: {
            status: "unresolved",
            sessionId: "thr-legacy",
            settings: { model: null, reasoningEffort: "xhigh" },
          },
        },
        pendingAgentCleanup: [],
      }),
    ).toBe(true);
  });
});
