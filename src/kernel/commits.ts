import type { ActionKernel } from "./actions.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import type { OrchestrationJournal } from "../adapters/orchestration-journal.js";
import { WorkspaceError, type WorkspaceManager } from "../adapters/workspaces.js";
import { KernelGitError } from "../adapters/kernel-git.js";
import { DeliveryError } from "../adapters/delivery-journal.js";
import { OperationFailed } from "./guards.js";
import { registerTrackerCommitCapabilities } from "./tracker-commits.js";
import { reconcileCommitIO } from "../adapters/commit-io.js";

export function registerCommitCapabilities(kernel: ActionKernel, workspaces: WorkspaceManager) {
  const journal = kernel.journal;
  registerTrackerCommitCapabilities(kernel, workspaces);
  kernel.registerExternal(
    "create_implementation_workspace",
    async ({ authority, record, signal }, action) => {
      const base = journal.commits.implementationBase(authority.runId, action.baseCommitId);
      const workspace = base.commit
        ? await workspaces.createImplementationCopy(
            authority,
            base.commit,
            record.operationId,
            signal,
            base.sourceWorkspace ?? base.commit,
          )
        : await workspaces.create(
            authority,
            base.sourcePath,
            base.revision,
            "implementation",
            signal,
            record.operationId,
          );
      return {
        kind: "resource",
        resourceId: workspace.workspaceId,
        generation: workspace.workspaceGeneration,
      };
    },
  );
  kernel.registerLocal("inspect_commit", ({ authority }, action) => {
    const { controllerLeaseId: _private, ...record } = journal.commits.record(
      authority.runId,
      action.commitId,
    );
    return {
      kind: "inspection",
      text: JSON.stringify({
        ...record,
        evidenceWarning:
          "Private commit object; independent exact-SHA verification and publication are separate obligations",
      }),
      artifactIds: [],
    };
  });
  kernel.registerExternal("request_commit", async ({ authority, record, signal }) => {
    const intent = journal.commits.reserve(authority, record.actionId);
    try {
      await workspaces.writeCandidateCommit(authority, intent, signal);
    } catch (error) {
      journal.assertAuthority(authority);
      if (!(
        error instanceof WorkspaceError ||
        error instanceof KernelGitError ||
        error instanceof DeliveryError ||
        signal.aborted
      ))
        throw error;
      const settled = await reconcileCommit(journal, workspaces, authority, intent.commitId);
      throw new OperationFailed(
        `Commit ${settled.commitId}: ${settled.failure ?? (error instanceof Error ? error.message : "interrupted")}`,
      );
    }
    const settled = await reconcileCommit(journal, workspaces, authority, intent.commitId);
    if (settled.status !== "created" || !settled.sourceIntact)
      throw new OperationFailed(`Commit ${settled.commitId}: ${settled.failure}`);
    return {
      kind: "resource",
      resourceId: settled.commitId,
      generation: settled.candidateGeneration,
    };
  });
}

/** Completes a recorded commitment only after confirmed I/O stop; never repeats a write. */
export async function reconcileCommit(
  journal: OrchestrationJournal,
  workspaces: WorkspaceManager,
  authority: ControllerAuthority,
  commitId: string,
  signal?: AbortSignal,
) {
  journal.assertAuthority(authority);
  const record = journal.commits.record(authority.runId, commitId);
  if (["created", "failed"].includes(record.status)) return record;
  await reconcileCommitIO(journal, authority, { kind: "application", commitId });
  const observed = await workspaces.inspectCandidateCommit(authority, record, signal);
  return journal.commits.finish(
    authority,
    commitId,
    observed.created,
    observed.sourceIntact,
    observed.detail,
  );
}
