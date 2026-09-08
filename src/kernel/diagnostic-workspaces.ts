import type { OrchestrationJournal } from "../adapters/orchestration-journal.js";
import type { WorkspaceManager } from "../adapters/workspaces.js";
import type { ActionRecord, ControllerAuthority, KernelAction } from "../domain/orchestration.js";
import type { ActionKernel } from "./actions.js";
import { CapabilityRejected } from "./guards.js";
import type { RecoveryObservation } from "./reconcile.js";

type DiagnosticRequest = Extract<KernelAction, { kind: "create_diagnostic_workspace" }>;

function source(journal: OrchestrationJournal, runId: string, action: DiagnosticRequest) {
  if (action.candidate) {
    const snapshot = journal.delivery.snapshotAtRevision(runId, action.candidate, action.revision);
    return { revision: snapshot.snapshotRevision, snapshot };
  }
  if (action.revision !== null)
    throw new CapabilityRejected(
      "diagnostic_revision",
      "A non-baseline diagnostic revision must identify a kernel-recorded candidate and exact commit",
    );
  const revision = journal.runObjective(runId).baselineRevision;
  if (!revision) throw new CapabilityRejected("missing_baseline", "Run has no frozen baseline");
  return { revision, snapshot: null };
}

/** Writable experiments, not delivery evidence. No model-supplied filesystem paths. */
export function registerDiagnosticWorkspaceCapabilities(
  kernel: ActionKernel,
  workspaces: WorkspaceManager,
  repositoryPath: string,
): void {
  kernel.registerExternal(
    "create_diagnostic_workspace",
    async ({ authority, record, signal }, action) => {
      const base = source(kernel.journal, authority.runId, action);
      const workspace = base.snapshot
        ? await workspaces.createSnapshotCopy(
            authority,
            base.snapshot,
            signal,
            record.operationId,
            "diagnostic",
          )
        : await workspaces.create(
            authority,
            repositoryPath,
            base.revision,
            "diagnostic",
            signal,
            record.operationId,
          );
      // Deliberately no candidate/review binding: experiments cannot satisfy delivery checks.
      return {
        kind: "resource",
        resourceId: workspace.workspaceId,
        generation: workspace.workspaceGeneration,
      };
    },
  );
}

/** Adopt only the unchanged copy belonging to this action, never rerun materialization. */
export async function reconcileDiagnosticWorkspace(
  journal: OrchestrationJournal,
  workspaces: WorkspaceManager,
  authority: ControllerAuthority,
  record: ActionRecord,
  signal?: AbortSignal,
): Promise<RecoveryObservation> {
  if (
    record.request.action.kind !== "create_diagnostic_workspace" ||
    record.status !== "indeterminate"
  )
    throw new Error("Expected an indeterminate diagnostic workspace action");
  journal.assertAuthority(authority);
  const unresolved = (): RecoveryObservation => ({
    status: "unresolved",
    detail: `Diagnostic copy for ${record.actionId} is not proven intact and stopped. Preserve the recorded resources; no copy was recreated.`,
  });
  const workspace = journal.agents.workspaceForOperation(authority.runId, record.operationId);
  if (workspace) {
    try {
      const creation = await workspaces.reconcileCreation(authority, workspace);
      if (creation?.outcome === "failed")
        return {
          status: "failed",
          detail: creation.detail ?? "Diagnostic creation failed without replay",
        };
    } catch {
      journal.assertAuthority(authority);
      return unresolved();
    }
  }
  if (
    !workspace ||
    workspace.activeTurnId ||
    journal.agents.activeWorkspaceOperation(authority.runId, workspace)
  )
    return unresolved();
  try {
    const base = source(journal, authority.runId, record.request.action);
    if (
      workspace.purpose !== "diagnostic" ||
      workspace.sourceMode !== "mutable" ||
      workspace.baselineRevision !== base.revision ||
      (base.snapshot &&
        (journal.agents.activeWorkspaceOperation(authority.runId, base.snapshot) ||
          (workspace.baselineFingerprint !== null &&
            workspace.baselineFingerprint !== base.snapshot.fingerprint)))
    )
      return unresolved();
    if ((await workspaces.inspectMaterialization(authority, workspace, signal)) !== "ready")
      return unresolved();
    const inspected = journal.agents.workspace(authority.runId, workspace);
    if (base.snapshot && inspected.baselineFingerprint !== base.snapshot.fingerprint)
      return unresolved();
    return {
      status: "succeeded",
      result: {
        kind: "resource",
        resourceId: inspected.workspaceId,
        generation: inspected.workspaceGeneration,
      },
    };
  } catch {
    journal.assertAuthority(authority);
    return unresolved();
  }
}
