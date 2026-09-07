import { randomUUID } from "node:crypto";
import type { OrchestrationJournal } from "../adapters/orchestration-journal.js";
import type { ActionPayload, ActionRecord, ControllerAuthority } from "../domain/orchestration.js";
import { redactSensitiveText } from "../util/redact.js";

export type RecoveryObservation =
  | { status: "succeeded"; result: ActionPayload }
  | { status: "failed"; detail: string }
  | { status: "unresolved"; detail: string };

/** Reconcile existing commitments; never choose a new delivery action or repeat an effect. */
export async function reconcileActions(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  inspect: (action: ActionRecord) => Promise<RecoveryObservation>,
): Promise<void> {
  journal.markInterruptedActions(authority);
  for (const action of journal.actions(authority.runId)) {
    // Recovering one dependency can atomically settle its related acknowledgement.
    if (journal.action(authority.runId, action.actionId)?.status !== "indeterminate") continue;
    journal.assertAuthority(authority);
    const outcome = await inspect(action);
    journal.assertAuthority(authority);
    settleRecoveryObservation(journal, authority, action, outcome);
  }
}

/** Settle only the inspected parent. Another observer may already have settled it. */
export function settleRecoveryObservation(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  action: ActionRecord,
  input: RecoveryObservation,
) {
  journal.assertAuthority(authority);
  const current = journal.action(authority.runId, action.actionId);
  if (!current) throw new Error("Recovery parent is missing");
  if (current.status !== "indeterminate") return current;
  const outcome: RecoveryObservation =
    input.status === "succeeded" &&
    current.policyDigest !== journal.control(authority.runId).policyDigest
      ? {
          status: "failed",
          detail:
            "The recorded resource remains available, but superseded policy cannot authorize successful action settlement",
        }
      : input;
  if (outcome.status === "succeeded")
    return journal.settleAction(authority, action.actionId, "indeterminate", {
      status: "succeeded",
      actionId: action.actionId,
      result: outcome.result,
    });
  const problemId = randomUUID();
  journal.appendObservation(authority, {
    source: "reconciler",
    sourceEventId: problemId,
    kind: `recovery.${outcome.status}`,
    summary: redactSensitiveText(outcome.detail, 7999),
    artifactIds: [],
    identity: null,
    wakesOrchestrator: true,
  });
  return outcome.status === "failed"
    ? journal.settleAction(authority, action.actionId, "indeterminate", {
        status: "failed",
        actionId: action.actionId,
        problemId,
      })
    : current;
}
