import { digestJson } from "../domain/repository-policy.js";
import { trackerActor, type EpicRepairBinding } from "../domain/tracker.js";
import type { WorkspaceIdentity } from "../domain/agents.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { DeliveryError } from "./delivery-journal.js";

/** Scope authority, independent of the repair's own writer count or publication progress. */
export function repairScope(journal: OrchestrationJournal, runId: string, taskId: string | null) {
  const rootId = journal.runObjective(runId).epicId;
  if (taskId !== rootId)
    throw new DeliveryError(
      "epic_repair_scope",
      "Epic repair must name this run's root, never a task or null scope",
    );
  const scope = journal.tracker.closedEpicScope(runId);
  if (
    ["closed", "tombstone"].includes(scope.scope.status) ||
    (scope.scope.assignee?.trim() && scope.scope.assignee.trim() !== trackerActor(runId))
  )
    throw new DeliveryError(
      "epic_repair_scope",
      "Epic repair requires an open root without a competing tracker owner",
    );
  return digestJson({
    graph: scope.digest,
    closures: scope.closures.map((entry) => entry.trackerOperationId),
    preexisting: scope.preexistingIds,
  });
}

export function bindEpicRepair(
  journal: OrchestrationJournal,
  runId: string,
  taskId: string | null,
  candidateId: string | null,
  workspace: WorkspaceIdentity,
): EpicRepairBinding {
  const scopeDigest = repairScope(journal, runId, taskId);
  const candidate = journal.delivery.latestCandidate(runId, taskId!);
  if (!candidate || candidate.candidateId !== candidateId || candidate.status !== "captured")
    throw new DeliveryError(
      "epic_repair_target",
      "Repair must identify the latest captured epic target; inspect its findings and requirements",
    );
  const commit = journal.commits.latestCreated(runId);
  if (!commit)
    throw new DeliveryError(
      "epic_repair_base",
      "Repair requires an existing verified delivery lineage",
    );
  const base = journal.commits.implementationBase(runId, commit.commitId);
  if (journal.agents.workspace(runId, workspace).baselineRevision !== base.revision)
    throw new DeliveryError(
      "epic_repair_base",
      "Create a fresh implementation workspace at the latest private commit before repair",
    );
  return {
    scopeDigest,
    epicBaselineRevision: journal.runObjective(runId).baselineRevision,
    baseCommitId: commit.commitId,
    baseRevision: base.revision,
  };
}

export function assertEpicRepair(
  journal: OrchestrationJournal,
  runId: string,
  taskId: string | null,
  binding: EpicRepairBinding,
  workspace: WorkspaceIdentity,
  requireLatestBase: boolean,
): void {
  if (
    requireLatestBase &&
    journal.commits.implementationBase(runId, binding.baseCommitId).revision !==
      binding.baseRevision
  )
    throw new DeliveryError(
      "epic_repair_stale",
      "Repair must extend the current complete delivery tip",
    );
  const base = journal.commits.retainedBase(runId, binding.baseCommitId, binding.baseRevision);
  if (
    repairScope(journal, runId, taskId) !== binding.scopeDigest ||
    binding.epicBaselineRevision !== journal.runObjective(runId).baselineRevision ||
    base.status !== "created" ||
    base.revision !== binding.baseRevision ||
    !base.sourceIntact ||
    journal.agents.workspace(runId, workspace).baselineRevision !== binding.baseRevision
  )
    throw new DeliveryError(
      "epic_repair_stale",
      "Repair scope or parent changed; inspect and create a new assignment at the current private tip",
    );
}
