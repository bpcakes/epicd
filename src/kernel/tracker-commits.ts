import type { CommitInspectionMode } from "../domain/workspace-inspection.js";
import { randomUUID } from "node:crypto";
import type { ActionKernel } from "./actions.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import type { WorkspaceManager } from "../adapters/workspaces.js";
import type { OrchestrationJournal } from "../adapters/orchestration-journal.js";
import { CapabilityRejected, OperationFailed } from "./guards.js";
import { reconcileCommitIO } from "../adapters/commit-io.js";

export function registerTrackerCommitCapabilities(
  kernel: ActionKernel,
  workspaces: WorkspaceManager,
) {
  const journal = kernel.journal;
  kernel.registerLocal("inspect_tracker_commit", ({ authority }, action) => {
    const {
      controllerLeaseId: _lease,
      snapshot,
      ...record
    } = journal.trackerCommits.record(authority.runId, action.trackerCommitId);
    return {
      kind: "inspection",
      text: JSON.stringify({
        ...record,
        snapshot: snapshot
          ? {
              parentRevision: snapshot.parentRevision,
              fullTree: snapshot.fullTree,
              applicationTree: snapshot.applicationTree,
              snapshotRevision: snapshot.snapshotRevision,
              fingerprint: snapshot.fingerprint,
              manifestEntryCount: snapshot.manifest.length,
            }
          : null,
        warning:
          "Tracker-only descendant of the recorded reviewed application; this SHA is not itself independently reviewed or published",
      }),
      artifactIds: [],
    };
  });
  kernel.registerExternal("request_tracker_commit", async ({ authority, record, signal }) => {
    const intent = journal.trackerCommits.reserve(authority, record.actionId);
    let failure: unknown = null;
    try {
      await workspaces.writeTrackerCommit(authority, intent, signal);
    } catch (error) {
      failure = error;
    }
    const settled = await reconcileTrackerCommit(
      journal,
      workspaces,
      authority,
      intent.trackerCommitId,
    );
    if (settled.status !== "created" || !settled.sourceIntact)
      throw new OperationFailed(
        `Tracker commit ${settled.trackerCommitId}: ${settled.failure ?? String(failure)}`,
      );
    return { kind: "resource", resourceId: settled.trackerCommitId, generation: 1 };
  });
  kernel.registerExternal("reconcile_tracker_commit", async ({ authority }, action) => {
    const intent = journal.trackerCommits.record(authority.runId, action.trackerCommitId);
    if (kernel.operation(intent.operationId))
      throw new CapabilityRejected(
        "tracker_commit_live",
        "Inspect or interrupt the current tracker write before reconciliation; its live operation cannot be fenced as abandoned",
      );
    const settled = await reconcileTrackerCommit(
      journal,
      workspaces,
      authority,
      action.trackerCommitId,
      "request",
    );
    const parent = journal
      .actions(authority.runId)
      .find((entry) => entry.operationId === settled.operationId);
    if (
      parent &&
      (parent.status === "running" || parent.status === "indeterminate") &&
      !kernel.operation(parent.operationId)
    ) {
      if (settled.status === "created" && settled.sourceIntact)
        journal.settleAction(authority, parent.actionId, parent.status, {
          status: "succeeded",
          actionId: parent.actionId,
          result: { kind: "resource", resourceId: settled.trackerCommitId, generation: 1 },
        });
      else {
        const problemId = randomUUID();
        journal.appendObservation(authority, {
          source: "tracker-commit-reconciler",
          sourceEventId: problemId,
          kind: "tracker_commit.parent_failed",
          summary: `Tracker commit ${settled.trackerCommitId}: ${settled.failure ?? settled.status}`,
          artifactIds: [],
          identity: null,
          wakesOrchestrator: true,
        });
        journal.settleAction(authority, parent.actionId, parent.status, {
          status: "failed",
          actionId: parent.actionId,
          problemId,
        });
      }
    }
    return { kind: "resource", resourceId: settled.trackerCommitId, generation: 1 };
  });
}
export async function reconcileTrackerCommit(
  journal: OrchestrationJournal,
  workspaces: WorkspaceManager,
  authority: ControllerAuthority,
  id: string,
  inspectionMode: CommitInspectionMode = "recover",
) {
  journal.assertAuthority(authority);
  const record = journal.trackerCommits.record(authority.runId, id);
  if (["created", "failed"].includes(record.status)) return record;
  await reconcileCommitIO(journal, authority, { kind: "tracker", trackerCommitId: id });
  if (!record.dispatched) return journal.trackerCommits.cancelUndispatched(authority, id);
  const result = await workspaces.reconcileTrackerCommitInspection(
    authority,
    record,
    undefined,
    inspectionMode,
  );
  return journal.trackerCommits.finish(
    authority,
    id,
    result.created,
    result.sourceIntact,
    result.detail,
  );
}
