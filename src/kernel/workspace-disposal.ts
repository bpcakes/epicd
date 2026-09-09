import type { ActionKernel } from "./actions.js";
import { OperationFailed, CapabilityRejected } from "./guards.js";
import { WorkspaceError, type WorkspaceManager } from "../adapters/workspaces.js";
import { preparePrivateIO } from "../adapters/private-io-files.js";
import { disposalRoot, retainedWorkspacePath } from "../adapters/workspace-disposal-files.js";
import { runWorkspaceDisposal } from "../adapters/workspace-disposal-io.js";

/** The coordinator chooses retirement. No deletion policy, pane control or follow-up strategy is inferred. */
export function registerWorkspaceDisposalCapabilities(
  kernel: ActionKernel,
  workspaces: WorkspaceManager,
) {
  const journal = kernel.journal;
  kernel.registerLocal("inspect_workspace", ({ authority }, action) => {
    const workspace = journal.agents.workspace(authority.runId, action);
    const disposals = journal.workspaceDisposals.forWorkspace(authority.runId, action);
    const creation = journal.workspaceCreations.forWorkspace(authority.runId, action);
    const view = {
      workspace,
      ...journal.workspaceInspections.historyPreview(authority.runId, action),
      creation: creation
        ? {
            creationId: creation.creationId,
            operationId: creation.creationOperationId,
            outcome: creation.outcome,
            workerResult: creation.workerResult ? { ...creation.workerResult } : null,
            stopConfirmed:
              creation.stop !== null ||
              (creation.execution === null && creation.outcome === "failed"),
            workspaceOperationId: creation.workspaceOperationId,
            sourceOperationId: creation.sourceOperationId,
            source:
              creation.source.kind === "repository"
                ? { kind: "repository" }
                : {
                    kind: creation.source.kind,
                    workspaceId: creation.source.workspaceId,
                    workspaceGeneration: creation.source.workspaceGeneration,
                  },
            detail: creation.detail,
            detailsTruncated: false,
          }
        : null,
      disposals: disposals.slice(-20).map((record) => ({
        disposalId: record.disposalId,
        operationId: record.operationId,
        outcome: record.outcome,
        stopConfirmed:
          !!record.stop || (record.execution === null && record.outcome === "not_moved"),
        retainedPath: record.outcome === "retained" ? retainedWorkspacePath(record) : null,
        sourcePathOccupied: record.sourcePathOccupied,
        detail: record.detail,
        detailTruncated: false,
      })),
      omittedDisposals: Math.max(0, disposals.length - 20),
      warning:
        "Disposal retains files and historical evidence, not fresh approval. Native endpoint/provider records remain intact; no pane closure or permanent deletion is implied. inspect_repo reads the original retained copy by workspace identity. Histories and diagnostics are bounded previews; inspect_record pages the complete retained records.",
    };
    // Budget the assembled JSON, including escaping, rather than assuming that
    // independently bounded fields fit together. Every optional section can shrink.
    let text = JSON.stringify(view);
    while (Buffer.byteLength(text) > 64_000) {
      if (view.disposals.length > 1) {
        view.disposals.shift();
        view.omittedDisposals += 1;
      } else if (view.inspections.length > 1) {
        view.inspections.shift();
        view.omittedInspections += 1;
      } else if (
        view.creation &&
        (view.creation.detail?.length ||
          (view.creation.workerResult?.status === "failed" &&
            view.creation.workerResult.detail.length))
      ) {
        if (view.creation.detail)
          view.creation.detail = view.creation.detail.slice(
            0,
            Math.floor(view.creation.detail.length / 2),
          );
        if (view.creation.workerResult?.status === "failed")
          view.creation.workerResult.detail = view.creation.workerResult.detail.slice(
            0,
            Math.floor(view.creation.workerResult.detail.length / 2),
          );
        view.creation.detailsTruncated = true;
      } else if (view.disposals[0]?.detail) {
        const latest = view.disposals[0];
        latest.detail = latest.detail!.slice(0, Math.floor(latest.detail!.length / 2));
        latest.detailTruncated = true;
      } else {
        throw new CapabilityRejected(
          "inspection_too_large",
          "Workspace metadata exceeds the bounded inspection budget",
        );
      }
      text = JSON.stringify(view);
    }
    return {
      kind: "inspection",
      artifactIds: [],
      text,
    };
  });
  kernel.registerExternal("dispose_workspace", async ({ authority, record, signal }, action) => {
    let source;
    try {
      source = await workspaces.disposalSource(authority, action);
    } catch (error) {
      journal.assertAuthority(authority);
      throw new CapabilityRejected(
        error instanceof WorkspaceError ? error.code : "workspace_identity",
        error instanceof Error ? error.message : "Workspace identity is unproven",
      );
    }
    signal.throwIfAborted();
    const archive = await preparePrivateIO(disposalRoot(source.path));
    const disposal = journal.workspaceDisposals.reserve(authority, record.actionId, archive);
    const outcome = await runWorkspaceDisposal(journal, authority, disposal, signal);
    if (outcome.outcome !== "retained")
      throw new OperationFailed(
        outcome.detail ?? "Workspace disposal did not establish retained files",
      );
    return {
      kind: "resource",
      resourceId: source.workspaceId,
      generation: source.workspaceGeneration,
    };
  });
}
