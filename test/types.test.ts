import { describe, expect, it } from "vitest";
import {
  ImplementationResultSchema,
  ReviewResultSchema,
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
});
