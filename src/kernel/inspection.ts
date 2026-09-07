import type { ActionKernel } from "./actions.js";
import { CapabilityRejected, OperationFailed, assertCurrentDispatch } from "./guards.js";
import { inspectRepository } from "../adapters/repository-inspection.js";
import { InspectionError } from "../adapters/inspection-files.js";
import { WorkspaceError, type WorkspaceManager } from "../adapters/workspaces.js";
import { AgentCoordinationError } from "../adapters/agent-journal.js";
import type { ActionRecord } from "../domain/orchestration.js";
import type { RecoveryObservation } from "./reconcile.js";

/** A lost read result is not recovered by reading newer bytes and calling them the old observation. */
export function reconcileRepositoryInspection(action: ActionRecord): RecoveryObservation {
  if (action.request.action.kind !== "inspect_repo")
    throw new Error("Not a repository inspection action");
  if (action.status !== "indeterminate" || action.result?.status !== "indeterminate")
    throw new Error("Only a journaled indeterminate inspection needs reconciliation");
  return {
    status: "failed",
    detail:
      "Interrupted read-only inspection has no retained result; request a new observation if useful. No source mutation or delivery evidence is implied.",
  };
}

/** Non-mutating inspection is recorded like other actions, without minting delivery evidence. */
export function registerInspectionCapabilities(
  kernel: ActionKernel,
  workspaces: WorkspaceManager,
): void {
  kernel.registerExternal("inspect_repo", async ({ authority, record, signal }, action) => {
    try {
      const text = await inspectRepository(workspaces, authority, action, signal);
      assertCurrentDispatch(kernel.journal, authority, record);
      return { kind: "inspection", text, artifactIds: [] };
    } catch (error) {
      kernel.journal.assertAuthority(authority);
      if (error instanceof CapabilityRejected || error instanceof AgentCoordinationError)
        throw error;
      if (error instanceof InspectionError || error instanceof WorkspaceError)
        throw new CapabilityRejected(error.code, error.message);
      // Only reads occurred, all descriptors/child processes have settled; there is no effect to reconcile.
      throw new OperationFailed(
        error instanceof Error ? error.message : "Repository inspection failed",
      );
    }
  });
}
