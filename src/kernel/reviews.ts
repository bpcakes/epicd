import type { AgentSessionContract } from "../domain/types.js";
import type { ReviewEvidence } from "../domain/reviews.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import type { OrchestrationJournal } from "../adapters/orchestration-journal.js";
import { WorkspaceError, type WorkspaceManager } from "../adapters/workspaces.js";
import { DeliveryError } from "../adapters/delivery-journal.js";
import { AgentCoordinationError } from "../adapters/agent-journal.js";
import type { ActionKernel } from "./actions.js";
import type { AgentDispatcher } from "../adapters/agent-dispatch.js";
import { CapabilityRejected, OperationFailed } from "./guards.js";
import { assertAgentDispatchReady } from "./agents.js";

/** Review mechanics only. The orchestrator still decides when to review, repair, or gather more evidence. */
export function registerReviewCapabilities(
  kernel: ActionKernel,
  workspaces: WorkspaceManager,
  dispatcher: AgentDispatcher,
  contractFor: () => AgentSessionContract,
) {
  const journal = kernel.journal;
  kernel.registerLocal("inspect_review", ({ authority }, action) => {
    const { controllerLeaseId: _private, ...review } = journal.reviews.evidence(
      authority.runId,
      action.evidenceId,
    );
    const approvalAssessment = journal.reviews.assessApproval(
      authority.runId,
      review,
      review.phase,
    );
    const content = {
      ...review,
      currentApproval: approvalAssessment.evidenceId === review.evidenceId,
      approvalAssessment,
      approvalWarning:
        "Derived current candidate/phase assessment; latestEvidenceId identifies the report evaluated. A blocker is the first unsatisfied condition, not an exhaustive list. Historical reports cannot replace the latest review.",
      evidenceWarning:
        review.phase === "pre_commit"
          ? "Independent judgment on a synthetic pre-commit snapshot, not exact-commit verification"
          : "Independent judgment on the actual private commit SHA; publication and tracker closure are separate obligations",
    };
    if (Buffer.byteLength(JSON.stringify(content)) > 64000)
      return {
        kind: "inspection",
        text: JSON.stringify({
          evidenceId: review.evidenceId,
          candidateId: review.candidateId,
          status: review.status,
          currentApproval: content.currentApproval,
          approvalAssessment,
          approvalWarning: content.approvalWarning,
          verdict: review.report?.verdict ?? null,
          failure: review.failure,
          reportOmitted: true,
          findingCount: review.report?.findings.length ?? 0,
          requiredCheckCount: review.report?.requiredChecks.length ?? 0,
          resolutionCount: review.report?.resolutions.length ?? 0,
          evidenceWarning: content.evidenceWarning,
          fullRecord:
            "Use read_review with UTF-16 character offset 0 and limit up to 8000; follow nextOffset until null. inspect_findings provides the task ledger.",
        }),
        artifactIds: [],
      };
    return { kind: "inspection", text: JSON.stringify(content), artifactIds: [] };
  });
  kernel.registerLocal("read_review", ({ authority }, action) => {
    const { controllerLeaseId: _private, ...review } = journal.reviews.evidence(
      authority.runId,
      action.evidenceId,
    );
    const serialized = JSON.stringify(review);
    const text = serialized.slice(action.offset, action.offset + action.limit);
    return {
      kind: "inspection",
      text: JSON.stringify({
        evidenceId: review.evidenceId,
        text,
        offset: action.offset,
        nextOffset:
          action.offset + text.length < serialized.length ? action.offset + text.length : null,
        totalCharacters: serialized.length,
      }),
      artifactIds: [],
    };
  });
  kernel.registerLocal("inspect_findings", ({ authority }, action) => {
    const findings = journal.reviews.findings(authority.runId, action.taskId);
    const candidate = journal.delivery.latestCandidate(authority.runId, action.taskId);
    const open = new Set(
      candidate
        ? journal.reviews
            .openFindings(authority.runId, candidate)
            .map((finding) => finding.findingId)
        : findings.map((finding) => finding.findingId),
    );
    const page = findings
      .slice(action.offset, action.offset + action.limit)
      .map((finding) => ({ ...finding, open: open.has(finding.findingId) }));
    const content = () => ({
      findings: page,
      total: findings.length,
      nextOffset:
        action.offset + page.length < findings.length ? action.offset + page.length : null,
    });
    while (Buffer.byteLength(JSON.stringify(content())) > 64000 && page.length > 1) page.pop();
    return { kind: "inspection", text: JSON.stringify(content()), artifactIds: [] };
  });
  kernel.registerExternal("run_review", async ({ authority, record, signal }) => {
    const contract = contractFor();
    assertAgentDispatchReady(dispatcher, contract);
    let review = journal.reviews.reserve(authority, record.actionId);
    const snapshot = journal.delivery.snapshotAtRevision(
      authority.runId,
      review,
      review.phase === "pre_commit" ? null : review.revision,
    );
    try {
      await workspaces.verifyValidationWorkspace(
        authority,
        review,
        snapshot,
        review.admissionOperationId,
        [],
        false,
        signal,
      );
      signal.throwIfAborted();
      review = journal.reviews.prepare(authority, review.evidenceId, contract);
      await dispatcher.run(authority, review.turnIdentity!, signal);
      // A pause or cancellation may prohibit a new inspection. Its stopped turn
      // is still recorded as failed review evidence, never promoted to approval.
      signal.throwIfAborted();
      review = journal.reviews.beginFinalInspection(authority, review.evidenceId);
      await workspaces.verifyValidationWorkspace(
        authority,
        review,
        snapshot,
        review.inspectionOperationId!,
        [],
        false,
        signal,
      );
      signal.throwIfAborted();
      const finished = journal.reviews.finish(authority, review.evidenceId, true, null);
      if (finished.failure)
        throw new OperationFailed(`Review ${review.evidenceId}: ${finished.failure}`);
      return {
        kind: "resource",
        resourceId: finished.evidenceId,
        generation: finished.candidateGeneration,
      };
    } catch (error) {
      journal.assertAuthority(authority);
      review = journal.reviews.evidence(authority.runId, review.evidenceId);
      if (review.status === "finished") throw error;
      if (review.turnIdentity) {
        await dispatcher.reconcile(authority, review.turnIdentity);
        if (
          !journal.agents.turnForRecovery(authority.runId, review.turnIdentity).turn?.stopEvidence
        )
          throw error;
      }
      // Only known, settled failures release inspection ownership. Storage/unknown
      // process failures remain indeterminate and block approval after restart.
      if (
        error instanceof WorkspaceError ||
        error instanceof DeliveryError ||
        error instanceof AgentCoordinationError ||
        signal.aborted
      ) {
        journal.reviews.finish(
          authority,
          review.evidenceId,
          false,
          error instanceof Error ? error.message : "Review cancelled",
        );
        if (error instanceof WorkspaceError && review.turnIdentity)
          journal.agents.revokeAgent(
            authority,
            review.turnIdentity,
            "Review source inspection failed; preserve the copy",
          );
        throw new OperationFailed(error instanceof Error ? error.message : "Review failed");
      }
      throw error;
    }
  });
}

/** Invoked by recovery, not a model action. Unknown admission/inspection I/O stays excluded. */
export async function reconcileReview(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  review: ReviewEvidence,
  dispatcher: AgentDispatcher,
) {
  journal.assertAuthority(authority);
  const current = journal.reviews.evidence(authority.runId, review.evidenceId);
  if (current.status === "finished") return current;
  if (current.turnIdentity) await dispatcher.reconcile(authority, current.turnIdentity);
  return journal.reviews.cancelStopped(authority, current.evidenceId);
}
