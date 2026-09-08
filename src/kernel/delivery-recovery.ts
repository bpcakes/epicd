import type { OrchestrationJournal } from "../adapters/orchestration-journal.js";
import type { WorkspaceManager } from "../adapters/workspaces.js";
import type { ActionRecord, ControllerAuthority } from "../domain/orchestration.js";
import { digestJson } from "../domain/repository-policy.js";
import { redactSensitiveText } from "../util/redact.js";
import type { ActionKernel } from "./actions.js";
import type { ControlledAgentDriver } from "./agents.js";
import { reconcileCommit } from "./commits.js";
import { reconcileReview } from "./reviews.js";
import { CapabilityRejected } from "./guards.js";
import { settleRecoveryObservation, type RecoveryObservation } from "./reconcile.js";

const supported = new Set<ActionRecord["request"]["action"]["kind"]>([
  "capture_candidate",
  "create_review_workspace",
  "create_implementation_workspace",
  "run_validation",
  "run_diagnostic_check",
  "run_review",
  "request_commit",
  "reconcile_action",
  "reconcile_fixture_access",
]);
const failed = (detail: string): RecoveryObservation => ({ status: "failed", detail });
const unresolved = (detail: string): RecoveryObservation => ({ status: "unresolved", detail });
const resource = (resourceId: string, generation: number): RecoveryObservation => ({
  status: "succeeded",
  result: { kind: "resource", resourceId, generation },
});

/** The model chooses the interrupted action. Its original intent chooses the inspector, never a new effect. */
export function registerDeliveryRecoveryCapabilities(
  kernel: ActionKernel,
  workspaces: WorkspaceManager,
  driver: ControlledAgentDriver,
) {
  kernel.registerExternal("reconcile_action", async ({ authority, signal }, request) => {
    const parent = kernel.journal.action(authority.runId, request.actionId);
    if (!parent)
      throw new CapabilityRejected(
        "unknown_recovery_action",
        "Action is missing or belongs to another run",
      );
    if (kernel.operation(parent.operationId) || ["running", "accepted"].includes(parent.status))
      throw new CapabilityRejected(
        "recovery_action_live",
        "Do not reconcile a live or undispatched action; inspect it or interrupt its exact operation",
      );
    let detail = "Recorded terminal action; no external I/O was repeated";
    if (parent.status === "indeterminate") {
      const outcome = await reconcileDeliveryAction(
        kernel.journal,
        workspaces,
        driver,
        authority,
        parent,
        signal,
      );
      if (!outcome)
        throw new CapabilityRejected(
          "recovery_unavailable",
          "Use the resource-specific reconciliation capability for this action kind",
        );
      const settled = settleRecoveryObservation(kernel.journal, authority, parent, outcome);
      detail =
        outcome.status === "succeeded"
          ? settled.status === "succeeded"
            ? "Recovered the recorded resource; current delivery eligibility remains a separate check"
            : "The resource was inspected but the original action could not settle successfully under current authority; inspect its recorded outcome"
          : outcome.detail;
    }
    const current = kernel.journal.action(authority.runId, parent.actionId)!;
    const result =
      current.result?.status === "succeeded" &&
      ["resource", "validation"].includes(current.result.result.kind)
        ? current.result.result
        : null;
    return {
      kind: "inspection",
      text: JSON.stringify({
        actionId: current.actionId,
        kind: current.request.action.kind,
        status: current.status,
        result,
        detail: redactSensitiveText(detail, 7999),
        warning:
          "No command, copy, review turn or commit write was replayed. Historical action success is not fresh review or publication authority.",
      }),
      artifactIds: [],
    };
  });
}

/** Shared with cold bootstrap. Unknown source/inspection I/O stays excluded; it is never inferred stopped. */
export async function reconcileDeliveryAction(
  journal: OrchestrationJournal,
  workspaces: WorkspaceManager,
  driver: ControlledAgentDriver,
  authority: ControllerAuthority,
  input: ActionRecord,
  signal?: AbortSignal,
): Promise<RecoveryObservation | null> {
  journal.assertAuthority(authority);
  const record = journal.action(authority.runId, input.actionId);
  if (input.runId !== authority.runId || !record || record.status !== "indeterminate")
    throw new CapabilityRejected(
      "recovery_action_state",
      "Only this run's interrupted action may be inspected",
    );
  if (!supported.has(record.request.action.kind)) return null;
  try {
    signal?.throwIfAborted();
    const run = authority.runId,
      action = record.request.action;
    if (action.kind === "reconcile_action" || action.kind === "reconcile_fixture_access")
      return failed(
        "Interrupted reconciliation lost its acknowledgement. Inspect the original action again; no resource stop was inferred and no delivery effect was replayed.",
      );
    if (action.kind === "request_commit") {
      const intent = journal.commits
        .records(run)
        .find((entry) => entry.operationId === record.operationId);
      if (!intent) return failed("No private commit intent exists; no Git write was admitted");
      const commit = await reconcileCommit(journal, workspaces, authority, intent.commitId, signal);
      const operation = journal.agents.workspaceOperation(run, commit.workspaceOperationId);
      if (
        !operation.stopEvidence ||
        operation.kind !== "commit" ||
        operation.workspaceId !== commit.workspaceId ||
        operation.workspaceGeneration !== commit.workspaceGeneration
      )
        return unresolved("Private commit lacks its matching source I/O stop evidence");
      return commit.status === "created" && commit.sourceIntact
        ? resource(commit.commitId, commit.candidateGeneration)
        : failed(
            commit.failure ?? "Private commit was not retained intact; preserve its resources",
          );
    }
    if (action.kind === "run_review") {
      const intent = journal.reviews
        .records(run)
        .find((entry) => entry.operationId === record.operationId);
      if (!intent) return failed("No review admission exists; no independent turn was authorized");
      const review = await reconcileReview(journal, authority, intent, driver);
      return review.failure === null &&
        review.status === "finished" &&
        review.sourceIntact &&
        review.report
        ? resource(review.evidenceId, review.candidateGeneration)
        : failed(
            review.failure ?? "Review did not durably establish independently inspected evidence",
          );
    }
    if (action.kind === "run_validation" || action.kind === "run_diagnostic_check") {
      const evidence = journal.delivery.validationForOperation(run, record.operationId);
      if (!evidence) return failed("No validation intent exists; no check command was admitted");
      const operation = journal.agents.workspaceOperation(run, evidence.workspaceOperationId);
      if (
        operation.kind !== "validation" ||
        operation.workspaceId !== evidence.workspaceId ||
        operation.workspaceGeneration !== evidence.workspaceGeneration ||
        !operation.stopEvidence ||
        evidence.status !== "finished" ||
        !evidence.outcome
      )
        return unresolved(
          "Validation lacks a durable outcome and matching I/O stop proof; no check was rerun and no pass was inferred",
        );
      return {
        status: "succeeded",
        result: {
          kind: "validation",
          evidenceId: evidence.evidenceId,
          outcome: evidence.outcome.status,
          satisfiesCheck: journal.delivery.satisfiesCheck(run, evidence.evidenceId),
        },
      };
    }
    if (action.kind === "capture_candidate") {
      const candidate = journal.delivery.candidateForOperation(run, record.operationId);
      if (!candidate) return failed("No capture intent exists; no candidate write was admitted");
      if (candidate.status === "captured" && candidate.snapshot) {
        if (digestJson(candidate.snapshot.manifest) !== candidate.snapshot.fingerprint)
          return unresolved("Captured manifest integrity changed; preserve the original state");
        return resource(candidate.candidateId, candidate.candidateGeneration);
      }
      if (candidate.status === "failed")
        return failed(candidate.failure ?? "Capture previously failed");
      if (
        journal.agents.activeWorkspaceOperation(run, candidate) ||
        journal.agents.workspace(run, candidate).activeTurnId
      )
        return unresolved("Capture or source work may still be active; no snapshot was recreated");
      const detail =
        "Stopped capture did not durably retain its snapshot; preserve any private objects and choose a new capture if useful";
      journal.delivery.failCapture(authority, candidate, detail);
      return failed(detail);
    }
    if (
      action.kind === "create_review_workspace" ||
      action.kind === "create_implementation_workspace"
    ) {
      const workspace = journal.agents.workspaceForOperation(run, record.operationId);
      if (
        !workspace ||
        workspace.activeTurnId ||
        journal.agents.activeWorkspaceOperation(run, workspace)
      )
        return unresolved(
          "Workspace materialization is not independently stopped and identifiable; no copy was recreated",
        );
      if (action.kind === "create_review_workspace") {
        const candidate = journal.delivery.candidate(run, action);
        const binding = journal.delivery.reviewCopyForOperation(run, record.operationId);
        if (journal.agents.activeWorkspaceOperation(run, candidate))
          return unresolved("Review-copy source I/O remains unsettled; preserve both copies");
        if (!binding)
          return failed(
            "The materialized copy has no durable review binding. Preserve it; a new review copy requires a new requested action.",
          );
        if (
          binding.workspaceId !== workspace.workspaceId ||
          binding.workspaceGeneration !== workspace.workspaceGeneration ||
          binding.candidateId !== candidate.candidateId ||
          binding.candidateGeneration !== candidate.candidateGeneration ||
          !candidate.snapshot ||
          workspace.baselineFingerprint !== candidate.snapshot.fingerprint ||
          workspace.baselineRevision !== binding.revision ||
          workspace.sourceMode !== "immutable" ||
          workspace.purpose !== (action.revision === null ? "review" : "verification") ||
          binding.revision !== (action.revision ?? candidate.snapshot.snapshotRevision)
        )
          return unresolved(
            "Review-copy identity differs from its original action and candidate; preserve it",
          );
      } else {
        if (workspace.purpose !== "implementation" || workspace.sourceMode !== "mutable")
          return unresolved("Implementation-copy purpose changed; preserve it");
        if (action.baseCommitId === null) {
          if (workspace.baselineRevision !== journal.runObjective(run).baselineRevision)
            return unresolved("Implementation copy does not match the frozen run baseline");
        } else {
          const base = journal.commits.retainedBase(
            run,
            action.baseCommitId,
            workspace.baselineRevision,
          );
          const canonical = journal.publications.repository(run)?.workspace;
          if (
            base.status !== "created" ||
            !base.sourceIntact ||
            journal.agents.activeWorkspaceOperation(run, base) ||
            (canonical && journal.agents.activeWorkspaceOperation(run, canonical))
          )
            return unresolved("Implementation-copy base lacks intact, stopped custody");
        }
      }
      if ((await workspaces.inspectMaterialization(authority, workspace, signal)) !== "ready")
        return unresolved(
          "Recorded workspace is incomplete or changed; no files were restored or discarded",
        );
      return resource(workspace.workspaceId, workspace.workspaceGeneration);
    }
    return null;
  } catch (error) {
    journal.assertAuthority(authority);
    return unresolved(
      `Delivery recovery remains unproven: ${String(error)}. No delivery effect was replayed.`,
    );
  }
}
