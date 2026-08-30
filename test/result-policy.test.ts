import { describe, expect, it } from "vitest";
import { requireAcceptedImplementationResult } from "../src/engine/result-policy.js";
import type { ImplementationResult } from "../src/domain/types.js";

const passingResult: ImplementationResult = {
  status: "completed",
  summary: "done",
  changedFiles: ["src/example.ts"],
  tests: [{ command: "npm test", outcome: "passed", detail: "passed" }],
  blockers: [],
};

describe("implementation result acceptance", () => {
  it.each([
    ["implementation", "Implementation blocked"],
    ["fix", "Fix blocked"],
  ] as const)("rejects a blocked %s turn", (kind, message) => {
    const blocked: ImplementationResult = {
      ...passingResult,
      status: "blocked",
      blockers: ["database unavailable"],
    };

    expect(() => requireAcceptedImplementationResult(blocked, kind, "epic.1")).toThrow(
      `${message}: database unavailable`,
    );
  });

  it.each([
    ["implementation", "Implementation did not provide"],
    ["fix", "Fix turn did not provide"],
  ] as const)("requires passing evidence from a %s turn", (kind, message) => {
    const unverified: ImplementationResult = { ...passingResult, tests: [] };

    expect(() => requireAcceptedImplementationResult(unverified, kind, "epic.1")).toThrow(message);
  });

  it.each(["implementation", "fix"] as const)(
    "rejects failed evidence even when a %s turn also reports a pass",
    (kind) => {
      const failed: ImplementationResult = {
        ...passingResult,
        tests: [
          ...passingResult.tests,
          { command: "npm run typecheck", outcome: "failed", detail: "type error" },
        ],
      };

      expect(() => requireAcceptedImplementationResult(failed, kind, "epic.1")).toThrow(
        "failure-free validation result",
      );
    },
  );

  it.each(["implementation", "fix"] as const)("accepts a verified %s turn", (kind) => {
    expect(() => requireAcceptedImplementationResult(passingResult, kind, "epic.1")).not.toThrow();
  });
});
