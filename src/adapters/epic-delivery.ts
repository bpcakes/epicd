import type { EpicDeliveryBinding } from "../domain/delivery.js";
import { digestJson } from "../domain/repository-policy.js";
import type { ValidationPlan } from "../domain/delivery.js";
import type { WorkspaceSnapshot } from "../domain/workspaces.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { DeliveryError } from "./delivery-journal.js";
type RequiredCheck = ValidationPlan["checks"][number];
type CheckBinding = { taskId: string; checkId: string; finalCheckId: string };

/** Names are task-local; command equality is exact, never inferred from prose. */
export function collectEpicChecks(
  required: RequiredCheck[],
  tasks: { taskId: string; checks: RequiredCheck[] }[],
) {
  const checks = new Map<string, RequiredCheck>();
  const bindings: CheckBinding[] = [];
  const commandDigest = ({ id: _id, stage: _stage, ...command }: RequiredCheck) =>
    digestJson(command);
  for (const check of required) {
    const previous = checks.get(check.id);
    if (previous && commandDigest(previous) !== commandDigest(check))
      throw new DeliveryError(
        "epic_check_conflict",
        `A policy or epic reviewer requirement needs a distinct ID: ${check.id}`,
      );
    checks.set(check.id, { ...check, stage: "both" });
  }
  for (const task of tasks)
    for (const check of task.checks) {
      let canonical = [...checks.values()].find(
        (entry) => commandDigest(entry) === commandDigest(check),
      );
      if (!canonical) {
        const id = checks.has(check.id)
          ? `${check.id.slice(0, 160)}.${digestJson({ taskId: task.taskId, check }).slice(0, 32)}`
          : check.id;
        canonical = { ...check, id, stage: "both" };
        if (checks.has(id))
          throw new DeliveryError("epic_check_conflict", "Final check identity collision");
        checks.set(id, canonical);
      }
      const binding = { taskId: task.taskId, checkId: check.id, finalCheckId: canonical.id };
      if (!bindings.some((entry) => digestJson(entry) === digestJson(binding)))
        bindings.push(binding);
    }
  return { checks: [...checks.values()], bindings };
}

export type EpicDeliveryTarget = {
  taskId: string;
  epicOpen: boolean;
  binding: EpicDeliveryBinding;
  snapshot: WorkspaceSnapshot;
  checks: RequiredCheck[];
  context: ReturnType<typeof epicContext>;
};

function epicContext(
  journal: OrchestrationJournal,
  runId: string,
  scope: ReturnType<OrchestrationJournal["tracker"]["closedEpicScope"]>,
) {
  return {
    epicId: scope.snapshot.graph.epicId,
    requirements: [...scope.snapshot.graph.issues]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((issue) => ({
        id: issue.id,
        type: issue.type,
        title: issue.title,
        description: issue.description,
        acceptanceCriteria: issue.acceptanceCriteria,
        instructions: issue.instructions,
        dependencies: issue.dependencies
          .map(({ id, type }) => ({ id, type }))
          .sort((a, b) => a.id.localeCompare(b.id) || a.type.localeCompare(b.type)),
        dependents: issue.dependents
          .map(({ id, type }) => ({ id, type }))
          .sort((a, b) => a.id.localeCompare(b.id) || a.type.localeCompare(b.type)),
        // Requirements are untrusted repository data; the raw content digest binds redaction.
        contentDigest: issue.contentDigest,
      })),
    preexistingClosedTaskIds: scope.preexistingIds,
    checkBindings: [] as CheckBinding[],
    closedTasks: scope.closures.map((closure) => {
      const publication = journal.publications.record(runId, closure.closure!.publicationId);
      const candidate = journal.delivery.candidate(runId, publication);
      const plan = journal.delivery.plan(runId, candidate.validationPlanId);
      return {
        taskId: closure.taskId!,
        closureOperationId: closure.trackerOperationId,
        publicationId: publication.publicationId,
        revision: publication.revision,
        validationPlanId: plan.planId,
        acceptanceCriteria: plan.acceptanceCriteria,
        checks: plan.checks,
      };
    }),
    warning:
      "Tracker graph is an observation, not a live closure grant. Historical task evidence does not verify the final published revision. Review the whole epic against the run baseline, including interactions and every descendant requirement.",
  };
}

/** Derive a read-only target from kernel custody and tracker provenance, never model claims. */
export function observeEpicDelivery(
  journal: OrchestrationJournal,
  runId: string,
): EpicDeliveryTarget {
  journal.publications.assertIdle(runId);
  const scope = journal.tracker.closedEpicScope(runId);
  const repository = journal.publications.repository(runId);
  if (!repository?.lastPublishedId || !repository.workspace || !repository.canonicalRepository)
    throw new DeliveryError(
      "epic_not_published",
      "Epic review requires a published delivery revision in kernel custody",
    );
  const publication = journal.publications.record(runId, repository.lastPublishedId);
  if (
    publication.outcome !== "published" ||
    !publication.ioStopped ||
    repository.publishedRevision !== publication.revision ||
    repository.privateRevision !== publication.revision ||
    journal.commits.latestCreated(runId)?.revision !== publication.revision ||
    journal.commits
      .records(runId)
      .some((commit) => ["preparing", "writing"].includes(commit.status))
  )
    throw new DeliveryError(
      "epic_publication_unsettled",
      "Settle and publish the complete private commit chain before final review",
    );
  const snapshot = journal.delivery.snapshotAtRevision(runId, publication, publication.revision);
  const context = epicContext(journal, runId, scope);
  const descendants = [...scope.snapshot.graph.issues]
    .filter((issue) => issue.id !== scope.snapshot.graph.epicId)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const issue of descendants) {
    const candidate = journal.delivery.latestCandidate(runId, issue.id);
    if (
      journal.reviews.records(runId, issue.id).some((review) => review.status !== "finished") ||
      (candidate && journal.reviews.openFindings(runId, candidate).length)
    )
      throw new DeliveryError(
        "epic_descendant_review_unsettled",
        `Resolve descendant review evidence before final approval: ${issue.id}`,
      );
  }
  const collected = collectEpicChecks(
    [
      ...journal.policy(runId).requiredChecks,
      ...journal.reviews.requiredChecks(runId, scope.snapshot.graph.epicId),
    ],
    [
      ...context.closedTasks,
      ...descendants.map((issue) => ({
        taskId: issue.id,
        checks: journal.reviews.requiredChecks(runId, issue.id),
      })),
    ],
  );
  const checks = collected.checks;
  context.checkBindings = collected.bindings;
  return {
    taskId: scope.snapshot.graph.epicId,
    epicOpen:
      scope.snapshot.graph.issues.find((issue) => issue.id === scope.snapshot.graph.epicId)!
        .status !== "closed",
    binding: {
      publicationId: publication.publicationId,
      trackerSnapshotId: scope.snapshot.snapshotId,
      scopeDigest: digestJson({ graph: scope.digest, context, checks }),
      baselineRevision: repository.baseRevision,
      closureOperationIds: scope.closures.map((operation) => operation.trackerOperationId),
    },
    snapshot: { ...snapshot, ...repository.workspace },
    checks,
    context,
  };
}
