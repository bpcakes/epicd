import type { ActionContext, ActionKernel } from "./actions.js";
import { CapabilityRejected, OperationFailed } from "./guards.js";
import { WorkspaceError, type WorkspaceManager } from "../adapters/workspaces.js";
import { AgentCoordinationError } from "../adapters/agent-journal.js";
import { DeliveryError } from "../adapters/delivery-journal.js";
import { KernelGitError } from "../adapters/kernel-git.js";
import { runCandidateValidation } from "../adapters/validation.js";
import { redactSensitiveText } from "../util/redact.js";
import { FixtureAuthorityError } from "../adapters/fixture-journal.js";

/** Installs executable capabilities; it does not select any follow-up action. */
export function registerDeliveryCapabilities(
  kernel: ActionKernel,
  workspaces: WorkspaceManager,
): void {
  const journal = kernel.journal;
  kernel.registerLocal("prepare_epic_delivery", ({ authority, record }) => {
    const candidate = journal.delivery.prepareEpicDelivery(authority, record.actionId);
    return {
      kind: "resource",
      resourceId: candidate.candidateId,
      generation: candidate.candidateGeneration,
    };
  });
  kernel.registerLocal("define_validation_plan", ({ authority, record }) => {
    const plan = journal.delivery.definePlan(authority, record.actionId);
    return { kind: "resource", resourceId: plan.planId, generation: plan.generation };
  });
  kernel.registerLocal("inspect_validation_plan", ({ authority }, action) => ({
    kind: "inspection",
    text: JSON.stringify(journal.delivery.plan(authority.runId, action.validationPlanId)),
    artifactIds: [],
  }));
  kernel.registerLocal("inspect_candidate", ({ authority }, action) => {
    const { snapshot, ...candidate } = journal.delivery.candidate(authority.runId, action);
    return {
      kind: "inspection",
      text: JSON.stringify({
        ...candidate,
        snapshot: snapshot
          ? { ...snapshot, manifest: undefined, files: snapshot.manifest.length }
          : null,
        current: journal.delivery.candidateCurrent(authority.runId, action),
        approval: "No independent review or exact-commit verification is implied by capture",
      }),
      artifactIds: [],
    };
  });
  kernel.registerLocal("inspect_evidence", ({ authority }, action) => {
    const { controllerLeaseId: _lease, ...evidence } = journal.delivery.evidence(
      authority.runId,
      action.evidenceId,
    );
    const content = {
      ...evidence,
      io: journal.delivery.validationIO(authority.runId, action.evidenceId),
      evidenceWarning:
        evidence.purpose === "diagnostic"
          ? "Kernel-observed diagnostic command on this snapshot. Never satisfies a required delivery check or independent approval."
          : "Kernel validation evidence; current check eligibility is reported separately, not independent approval.",
      outcome: evidence.outcome
        ? {
            ...evidence.outcome,
            stdout: redactSensitiveText(evidence.outcome.stdout, 8000),
            stderr: redactSensitiveText(evidence.outcome.stderr, 8000),
            inspectionTruncated:
              evidence.outcome.stdout.length > 8000 || evidence.outcome.stderr.length > 8000,
          }
        : null,
      satisfiesCheck: journal.delivery.satisfiesCheck(authority.runId, action.evidenceId),
    };
    // JSON escaping can expand binary/control-character output beyond its original byte bound.
    while (
      Buffer.byteLength(JSON.stringify(content)) > 64000 &&
      content.outcome &&
      (content.outcome.stdout.length || content.outcome.stderr.length)
    ) {
      content.outcome.stdout = content.outcome.stdout.slice(
        0,
        Math.floor(content.outcome.stdout.length / 2),
      );
      content.outcome.stderr = content.outcome.stderr.slice(
        0,
        Math.floor(content.outcome.stderr.length / 2),
      );
      content.outcome.inspectionTruncated = true;
    }
    return { kind: "inspection", text: JSON.stringify(content), artifactIds: [] };
  });
  kernel.registerExternal("capture_candidate", async ({ authority, record, signal }) => {
    const candidate = journal.delivery.reserveCandidate(authority, record.actionId);
    if (candidate.status !== "capturing")
      throw new CapabilityRejected(
        "capture_settled",
        "Inspect the already recorded candidate outcome",
      );
    try {
      const snapshot = await workspaces.capture(
        authority,
        candidate,
        candidate.candidateId,
        signal,
      );
      journal.delivery.finishCapture(authority, candidate, snapshot);
      return {
        kind: "resource",
        resourceId: candidate.candidateId,
        generation: candidate.candidateGeneration,
      };
    } catch (error) {
      if (
        error instanceof WorkspaceError ||
        error instanceof AgentCoordinationError ||
        error instanceof DeliveryError ||
        error instanceof KernelGitError ||
        signal.aborted
      ) {
        journal.delivery.failCapture(
          authority,
          candidate,
          error instanceof Error ? error.message : "Capture cancelled",
        );
        throw new OperationFailed(error instanceof Error ? error.message : "Capture failed");
      }
      throw error; // Unknown I/O/persistence failures need reconciliation, never blind replay.
    }
  });
  kernel.registerExternal(
    "create_review_workspace",
    async ({ authority, record, signal }, action) => {
      const candidate = journal.delivery.candidate(authority.runId, action);
      if (!candidate.snapshot)
        throw new CapabilityRejected(
          "candidate_not_captured",
          "Candidate capture has not completed",
        );
      const workspace = await workspaces.createSnapshotCopy(
        authority,
        journal.delivery.snapshotAtRevision(authority.runId, candidate, action.revision),
        signal,
        record.operationId,
        action.revision === null ? "review" : "verification",
      );
      journal.delivery.bindReviewCopy(authority, record.actionId, workspace);
      return {
        kind: "resource",
        resourceId: workspace.workspaceId,
        generation: workspace.workspaceGeneration,
      };
    },
  );
  const runCheck = async ({ authority, record, signal }: ActionContext) => {
    let intent;
    try {
      intent = journal.delivery.beginValidation(authority, record.actionId);
    } catch (error) {
      if (error instanceof FixtureAuthorityError)
        throw new CapabilityRejected(error.code, error.message);
      throw error;
    }
    const evidence = await runCandidateValidation(journal, workspaces, authority, intent, signal);
    if (!evidence.outcome)
      throw new OperationFailed(
        "Validation worker stopped without a retained check outcome; no pass inferred",
      );
    return {
      kind: "validation" as const,
      evidenceId: evidence.evidenceId,
      outcome: evidence.outcome.status,
      satisfiesCheck: journal.delivery.satisfiesCheck(authority.runId, evidence.evidenceId),
    };
  };
  kernel.registerExternal("run_validation", runCheck);
  kernel.registerExternal("run_diagnostic_check", runCheck);
}
