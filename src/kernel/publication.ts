import type { ActionKernel } from "./actions.js";
import type { WorkspaceManager } from "../adapters/workspaces.js";
import { PublicationAdapter } from "../adapters/publication.js";
import { OperationFailed } from "./guards.js";
import { randomUUID } from "node:crypto";
import type { ControllerAuthority } from "../domain/orchestration.js";

export function registerPublicationCapabilities(
  kernel: ActionKernel,
  workspaces: WorkspaceManager,
) {
  const journal = kernel.journal;
  const adapter = new PublicationAdapter(journal, workspaces);
  kernel.registerLocal("inspect_publication", ({ authority }, action) => {
    const {
      controllerLeaseId: _lease,
      lockNonce: _nonce,
      ...record
    } = journal.publications.record(authority.runId, action.publicationId);
    return {
      kind: "inspection",
      text: JSON.stringify({
        ...record,
        currentApproval: journal.publications.approval(authority.runId, record.publicationId),
        evidenceWarning:
          "Physical publication does not itself close a task or replace current exact-revision verification; retained packs require owned cleanup",
      }),
      artifactIds: [],
    };
  });
  kernel.registerExternal("request_publish", async ({ authority, record, signal }) => {
    const intent = journal.publications.reserve(authority, record.actionId);
    await adapter.publish(authority, intent.publicationId, signal);
    const settled = await adapter.reconcile(authority, intent.publicationId);
    if (settled.outcome !== "published")
      throw new OperationFailed(
        `Publication ${settled.publicationId}: ${settled.failure ?? settled.outcome}`,
      );
    return {
      kind: "resource",
      resourceId: settled.publicationId,
      generation: settled.candidateGeneration,
    };
  });
  kernel.registerExternal("reconcile_publication", async ({ authority }, action) => {
    const settled = await reconcilePublication(kernel, adapter, authority, action.publicationId);
    return {
      kind: "resource",
      resourceId: settled.publicationId,
      generation: settled.candidateGeneration,
    };
  });
  return adapter;
}

/** Resolve this publication's parent action only; never interrupt unrelated live operations. */
export async function reconcilePublication(
  kernel: ActionKernel,
  adapter: PublicationAdapter,
  authority: ControllerAuthority,
  publicationId: string,
) {
  const record = await adapter.reconcile(authority, publicationId);
  const parent = kernel.journal
    .actions(authority.runId)
    .find((action) => action.operationId === record.operationId);
  if (
    parent &&
    (parent.status === "running" || parent.status === "indeterminate") &&
    !kernel.operation(parent.operationId)
  ) {
    if (
      record.outcome === "published" &&
      parent.policyDigest === kernel.journal.control(authority.runId).policyDigest
    )
      kernel.journal.settleAction(authority, parent.actionId, parent.status, {
        status: "succeeded",
        actionId: parent.actionId,
        result: {
          kind: "resource",
          resourceId: record.publicationId,
          generation: record.candidateGeneration,
        },
      });
    else {
      const problemId = randomUUID();
      kernel.journal.appendObservation(authority, {
        source: "publication-reconciler",
        sourceEventId: problemId,
        kind: "publication.parent_failed",
        summary: `Publication ${record.publicationId}: ${record.outcome}; inspect its physical facts and current policy`,
        artifactIds: [],
        identity: null,
        wakesOrchestrator: true,
      });
      kernel.journal.settleAction(authority, parent.actionId, parent.status, {
        status: "failed",
        actionId: parent.actionId,
        problemId,
      });
    }
  }
  return record;
}
