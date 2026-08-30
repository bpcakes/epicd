import { describe, expect, it } from "vitest";
import {
  ImplementationResultSchema,
  IMPLEMENTATION_OUTPUT_SCHEMA,
  IssueSchema,
  ReviewResultSchema,
  REVIEW_OUTPUT_SCHEMA,
  SELECTION_OUTPUT_SCHEMA,
  TestExecutionSchema,
} from "../src/domain/types.js";

const passedTest = {
  command: "npm test",
  outcome: "passed" as const,
  detail: "all tests passed",
};

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
