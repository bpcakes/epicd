import { describe, expect, it } from "vitest";
import { currentSession } from "./fixtures/orchestration/state.js";
import {
  createInactiveAgentSessions,
  AgentSessionContractSchema,
  ImplementationResultSchema,
  IMPLEMENTATION_OUTPUT_SCHEMA,
  IssueSchema,
  ReviewResultSchema,
  REVIEW_OUTPUT_SCHEMA,
  runAgentSessionId,
  runRecoveryKind,
  runNeedsResume,
  SELECTION_OUTPUT_SCHEMA,
  TestExecutionSchema,
} from "../src/domain/types.js";

const passedTest = {
  command: "npm test",
  outcome: "passed" as const,
  detail: "all tests passed",
};

describe("persisted session contracts", () => {
  it.each(["sdk", "herdr"])(
    "freezes decoded %s contracts without changing their JSON shape",
    (runtime) => {
      const input = {
        runtime,
        requested: { model: null, reasoningEffort: "high" },
        effective: { model: "gpt-pinned", reasoningEffort: "high" },
      };
      const decoded = AgentSessionContractSchema.parse(JSON.parse(JSON.stringify(input)));
      expect(Reflect.set(decoded, "runtime", "changed")).toBe(false);
      expect(Reflect.set(decoded.requested, "model", "changed")).toBe(false);
      expect(Reflect.set(decoded.effective, "model", "changed")).toBe(false);
      expect(JSON.stringify(decoded)).toBe(JSON.stringify(input));
    },
  );
});

describe("run recovery classification", () => {
  it("distinguishes diagnostics, resource cleanup, workflow, and completed work", () => {
    const state = {
      phase: "complete" as const,
      agentSessions: createInactiveAgentSessions(),
      pendingAgentCleanup: [],
      lastError: null as string | null,
    };
    expect(runRecoveryKind(state)).toBeNull();
    expect(runNeedsResume(state)).toBe(false);
    state.lastError = "Saved diagnostic";
    expect(runRecoveryKind(state)).toBe("diagnostic");
    expect(runNeedsResume(state)).toBe(true);
    expect(
      runRecoveryKind({ ...state, pendingAgentCleanup: [{ kind: "run", runtime: "herdr" }] }),
    ).toBe("cleanup");
    state.agentSessions.review = currentSession("review");
    expect(runRecoveryKind(state)).toBe("cleanup");
    expect(runRecoveryKind({ ...state, phase: "paused" })).toBe("workflow");
  });
});

describe("agent session identity", () => {
  it("exposes IDs for active sessions but not inactive sessions", () => {
    const agentSessions = createInactiveAgentSessions();
    expect(runAgentSessionId({ agentSessions }, "review")).toBeNull();

    agentSessions.review = {
      status: "active",
      sessionId: "active-review",
      contract: {
        runtime: "sdk",
        requested: { model: "gpt-review", reasoningEffort: "xhigh" },
        effective: { model: "gpt-review", reasoningEffort: "xhigh" },
      },
    };
    expect(runAgentSessionId({ agentSessions }, "review")).toBe("active-review");
  });
});

describe("agent result schemas", () => {
  it("uses the same test-execution contract for implementation and review results", () => {
    expect(TestExecutionSchema.parse(passedTest)).toEqual(passedTest);
    expect(
      ImplementationResultSchema.parse({
        status: "completed",
        summary: "implemented",
        changedFiles: ["src/example.ts"],
        tests: [passedTest],
        blockers: [],
      }).tests,
    ).toEqual([passedTest]);
    expect(
      ReviewResultSchema.parse({
        verdict: "approved",
        summary: "reviewed",
        revision: "abc123",
        findings: [],
        tests: [passedTest],
        residualRisks: [],
      }).tests,
    ).toEqual([passedTest]);
  });

  it("rejects unsupported test outcomes at the shared boundary", () => {
    expect(() => TestExecutionSchema.parse({ ...passedTest, outcome: "skipped" })).toThrow();
  });

  it("derives shape-only agent schemas from the canonical Zod contracts", () => {
    const reviewProperties = REVIEW_OUTPUT_SCHEMA.properties as Record<string, unknown>;
    const finding = (
      reviewProperties.findings as { items: { properties: Record<string, unknown> } }
    ).items.properties;
    expect(finding.line).toEqual({ type: ["integer", "null"] });
    expect(JSON.stringify(REVIEW_OUTPUT_SCHEMA)).not.toMatch(
      /\$schema|minLength|exclusiveMinimum|maximum/,
    );
    expect(REVIEW_OUTPUT_SCHEMA).toMatchObject({
      type: "object",
      required: ["verdict", "summary", "revision", "findings", "tests", "residualRisks"],
      additionalProperties: false,
    });
    expect(IMPLEMENTATION_OUTPUT_SCHEMA).toMatchObject({
      type: "object",
      required: ["status", "summary", "changedFiles", "tests", "blockers"],
      additionalProperties: false,
    });
    expect(SELECTION_OUTPUT_SCHEMA).toMatchObject({
      type: "object",
      required: ["candidateId", "rationale", "dependencyNotes", "riskNotes"],
      additionalProperties: false,
    });
  });
});

describe("Beads issue schema", () => {
  const issue = {
    id: "epic.1",
    title: "Concrete work",
    description: null,
    acceptance_criteria: null,
    status: "open",
    priority: 1,
    issue_type: "task",
    labels: [],
  };

  it("normalizes nullable descriptive text without defaulting operational fields", () => {
    expect(IssueSchema.parse(issue)).toMatchObject({
      description: "",
      acceptance_criteria: "",
      status: "open",
      issue_type: "task",
    });
    const { status: _, ...missingStatus } = issue;
    expect(IssueSchema.safeParse(missingStatus).success).toBe(false);
  });

  it("rejects issue types and statuses outside epicd's supported Beads contract", () => {
    expect(IssueSchema.safeParse({ ...issue, issue_type: "custom-work" }).success).toBe(false);
    expect(IssueSchema.safeParse({ ...issue, status: "custom-status" }).success).toBe(false);
  });
});
