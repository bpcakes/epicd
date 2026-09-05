import { runNeedsResume, type RunState, type RuntimeKind } from "./domain/types.js";
import type { DoctorMode } from "./doctor.js";

export type RunPreflight = {
  runtime: RuntimeKind;
  mode: Exclude<DoctorMode, "selection">;
};

/** Resolves runtime checks only after the run, if any, has been selected. */
export function resolveRunPreflight(
  run: RunState | null,
  requestedRuntime?: RuntimeKind,
): RunPreflight {
  return {
    runtime: requestedRuntime ?? run?.runtime ?? "sdk",
    mode: run?.phase === "complete" && runNeedsResume(run) ? "cleanup" : "workflow",
  };
}
