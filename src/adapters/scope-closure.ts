import { digestJson } from "../domain/repository-policy.js";
import { trackerActor, type TrackerClosure } from "../domain/tracker.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { DeliveryError } from "./delivery-journal.js";

const fail = (message: string): never => {
  throw new DeliveryError("scope_closure", message);
};

/** Current journal authority. The transport must still inspect the live graph and hold exact refs. */
export function scopeClosure(
  journal: OrchestrationJournal,
  runId: string,
  kind: "close_container" | "close_epic" | "complete",
  taskId: string,
  revision: string | null,
  activeOperationId?: string,
): Omit<TrackerClosure, "reason" | "refsVerified" | "intervention"> {
  const rootId = journal.runObjective(runId).epicId;
  if ((kind === "close_container") === (taskId === rootId))
    return fail("Use epic closure for the root and container closure for a nested epic");
  const scope = journal.tracker.closedScope(runId, taskId, true, activeOperationId);
  const root = scope.snapshot.graph.issues.find((issue) => issue.id === rootId)!;
  if (
    kind !== "complete" &&
    scope.scope.status === "closed" &&
    (!activeOperationId ||
      journal.tracker.record(runId, activeOperationId).mutationDispatched === false)
  )
    return fail(
      "This container/root is already closed; inspect its recorded operation instead of closing again",
    );
  if (kind === "close_container" && ["closed", "tombstone"].includes(root.status))
    return fail("Container closure requires an open epic root");
  if (scope.scope.assignee?.trim() && scope.scope.assignee.trim() !== trackerActor(runId))
    return fail("Container/root belongs to another tracker owner");
  const repository = journal.publications.repository(runId);
  if (!repository?.lastPublishedId) return fail("Scope closure requires a verified publication");
  const publication = journal.publications.record(runId, repository.lastPublishedId);
  if (
    publication.outcome !== "published" ||
    !publication.ioStopped ||
    repository.publishedRevision !== publication.revision ||
    repository.privateRevision !== publication.revision ||
    journal.commits.latestCreated(runId)?.commitId !== publication.commitId ||
    journal.commits
      .records(runId)
      .some((entry) => ["preparing", "writing"].includes(entry.status)) ||
    (revision !== null && revision !== publication.revision)
  )
    return fail("Scope closure requires the complete settled and published private commit chain");
  journal.publications.assertIdle(runId);
  journal.trackerCommits.assertIdle(runId);
  journal.publications.objectRecord(runId, publication);
  const proof = {
    scopeDigest: scope.digest,
    closureOperationIds: scope.closures.map((entry) => entry.trackerOperationId),
    preexistingIds: scope.preexistingIds,
  };
  if (kind === "close_container")
    return {
      publicationId: publication.publicationId,
      revision: publication.revision,
      reviewEvidenceId: publication.reviewEvidenceId,
      proof: { ...proof, kind: "container" },
    };
  const candidate = journal.delivery.latestCandidate(runId, rootId);
  if (
    !candidate ||
    candidate.source.kind !== "published_epic" ||
    !journal.publications.trackerDescendsFrom(
      runId,
      publication.publicationId,
      candidate.source.publicationId,
    ) ||
    candidate.snapshot?.snapshotRevision !==
      journal.publications.record(runId, candidate.source.publicationId).revision
  )
    return fail("Epic closure requires a whole-epic target at this published revision");
  const reviewEvidenceId = journal.reviews.approval(
    runId,
    candidate,
    "exact_revision",
    activeOperationId,
  );
  if (!reviewEvidenceId)
    return fail(
      "Epic closure requires current independent final verification and no unresolved findings",
    );
  let rootClosureOperationId: string | null = null;
  if (kind === "complete") {
    if (
      publication.provenance.kind !== "tracker" ||
      journal.trackerCommits.record(runId, publication.provenance.trackerCommitId).exportMetadata
        .scopeDigest !== scope.snapshot.rawScopeDigest
    )
      return fail(
        "Completion requires a published tracker-only commit containing the current closed epic scope",
      );
    const closed = journal.tracker
      .operations(runId)
      .findLast((entry) => entry.kind === "close_epic" && entry.outcome === "closed");
    const witness = closed?.afterSnapshotId
      ? journal.tracker
          .snapshot(runId, closed.afterSnapshotId)
          .graph.issues.find((issue) => issue.id === rootId)
      : null;
    if (
      !closed?.closure ||
      !witness ||
      closed.closure.proof.kind !== "epic" ||
      closed.closure.proof.reviewScopeDigest !== candidate.source.scopeDigest ||
      !journal.publications.trackerDescendsFrom(
        runId,
        publication.publicationId,
        closed.closure.publicationId,
      ) ||
      root.status !== "closed" ||
      root.contentDigest !== witness.contentDigest ||
      root.assignee !== witness.assignee ||
      root.closedAt !== witness.closedAt ||
      root.closedBySession !== closed.operationId ||
      root.closeReason !== closed.closure.reason
    )
      return fail("Completion requires this run's unchanged proven epic-root closure");
    rootClosureOperationId = closed.trackerOperationId;
  }
  return {
    publicationId: publication.publicationId,
    revision: publication.revision,
    reviewEvidenceId,
    proof: {
      ...proof,
      kind: "epic",
      candidateId: candidate.candidateId,
      candidateGeneration: candidate.candidateGeneration,
      reviewScopeDigest: candidate.source.scopeDigest,
      rootClosureOperationId,
    },
  };
}

export function sameScopeClosure(
  record: TrackerClosure,
  current: ReturnType<typeof scopeClosure>,
): boolean {
  return (
    record.publicationId === current.publicationId &&
    record.revision === current.revision &&
    record.reviewEvidenceId === current.reviewEvidenceId &&
    digestJson(record.proof) === digestJson(current.proof)
  );
}
