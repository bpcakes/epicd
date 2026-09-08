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
    const view = {
      workspace,
      disposals: disposals.slice(-20).map((record) => ({
        disposalId: record.disposalId,
        operationId: record.operationId,
        outcome: record.outcome,
        stopConfirmed:
          !!record.stop || (record.execution === null && record.outcome === "not_moved"),
        retainedPath: record.outcome === "retained" ? retainedWorkspacePath(record) : null,
        sourcePathOccupied: record.sourcePathOccupied,
        detail: record.detail,
      })),
      omittedDisposals: Math.max(0, disposals.length - 20),
      warning:
        "Disposal retains files and historical evidence, not fresh approval. Native endpoint/provider records remain intact; no pane closure or permanent deletion is implied. inspect_repo reads the original retained copy by workspace identity.",
    };
    while (Buffer.byteLength(JSON.stringify(view)) > 64_000 && view.disposals.length) {
      view.disposals.shift();
      view.omittedDisposals += 1;
    }
    return {
      kind: "inspection",
      artifactIds: [],
      text: JSON.stringify(view),
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
