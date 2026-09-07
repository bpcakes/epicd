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
    if (action.status !== "indeterminate") continue;
    journal.assertAuthority(authority);
    const outcome = await inspect(action);
    journal.assertAuthority(authority);
    if (outcome.status === "succeeded") {
      journal.settleAction(authority, action.actionId, "indeterminate", {
        status: "succeeded",
        actionId: action.actionId,
        result: outcome.result,
      });
      continue;
    }
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
    if (outcome.status === "failed")
      journal.settleAction(authority, action.actionId, "indeterminate", {
        status: "failed",
        actionId: action.actionId,
        problemId,
      });
  }
}
