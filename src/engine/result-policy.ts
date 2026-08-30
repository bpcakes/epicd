import type { ImplementationResult } from "../domain/types.js";

export type ImplementationTurnKind = "implementation" | "fix";

export function requireAcceptedImplementationResult(
  result: ImplementationResult,
  kind: ImplementationTurnKind,
  issueId: string,
): void {
  const turnName = kind === "implementation" ? "Implementation" : "Fix";
  if (result.status === "blocked") {
    throw new Error(`${turnName} blocked: ${result.blockers.join("; ")}`);
  }
  if (
    !result.tests.some((test) => test.outcome === "passed") ||
    result.tests.some((test) => test.outcome === "failed")
  ) {
    const subject = kind === "implementation" ? "Implementation" : "Fix turn";
    throw new Error(
      `${subject} did not provide a passing, failure-free validation result for ${issueId}`,
    );
  }
}
