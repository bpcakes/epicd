import { describe, expect, it } from "vitest";
import {
  ImplementationResultSchema,
  IMPLEMENTATION_OUTPUT_SCHEMA,
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
