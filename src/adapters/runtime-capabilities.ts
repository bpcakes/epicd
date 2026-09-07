import type { RuntimeCapabilities } from "../domain/orchestration.js";
import type { RuntimeKind } from "../domain/types.js";

/** Transport capabilities, not claims that an untested native executable is confined. */
export function runtimeCapabilities(runtime: RuntimeKind): RuntimeCapabilities {
  return {
    structuredResults: { status: "available" },
    lifecycleObservation: { status: "available" },
    commandEvents:
      runtime === "sdk"
        ? { status: "available" }
        : {
            status: "unavailable",
            reason: "Native Herdr lifecycle and screen output are not typed Codex command events",
          },
    diagnosticOutput: { status: "available" },
    usage:
      runtime === "sdk"
        ? { status: "available" }
        : {
            status: "unavailable",
            reason: "Native Herdr has no verified per-turn token usage bridge",
          },
    liveSteering: {
      status: "unavailable",
      reason: "This adapter supports follow-up turns, not confirmed mid-turn message delivery",
    },
    durableReconnect: {
      status: "unavailable",
      reason: "Generation-bound controlled-turn reconciliation is not wired yet",
    },
    confirmedInterruption: {
      status: "unavailable",
      reason: "A settled model stream or Herdr lifecycle does not prove process-tree termination",
    },
    confinedWrites: {
      status: "unavailable",
      reason: "Outer process confinement has not yet been integrated into agent launch",
    },
    immutableReviewSource: {
      status: "unavailable",
      reason: "Legacy agent launch still permits workspace writes during review",
    },
  };
}

export function requireAdaptiveRuntimeCapabilities(capabilities: RuntimeCapabilities): void {
  const required = [
    "structuredResults",
    "lifecycleObservation",
    "durableReconnect",
    "confirmedInterruption",
    "confinedWrites",
    "immutableReviewSource",
  ] as const;
  const missing = required.flatMap((name) => {
    const capability = capabilities[name];
    return capability.status === "available" ? [] : [`${name}: ${capability.reason}`];
  });
  if (missing.length)
    throw new Error(`Runtime is not ready for adaptive admission: ${missing.join("; ")}`);
}
