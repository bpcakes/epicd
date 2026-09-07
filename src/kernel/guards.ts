import type { OrchestrationJournal } from "../adapters/orchestration-journal.js";
import type { ActionRecord, ControllerAuthority } from "../domain/orchestration.js";

export class CapabilityRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityRejected";
  }
}

/** A provider may use this only when it has observed a definitive failed, stopped operation. */
export class OperationFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationFailed";
  }
}

/** Recheck immediately before an asynchronous handler starts an external operation. */
export function assertCurrentDispatch(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  action: ActionRecord,
): void {
  journal.assertAuthority(authority);
  const control = journal.control(authority.runId);
  const current = journal.action(authority.runId, action.actionId);
  if (
    current?.status !== "running" ||
    control.status !== "active" ||
    control.policyDigest !== action.policyDigest ||
    control.controlVersion !== action.request.expectedControlVersion
  ) {
    throw new CapabilityRejected(
      "stale_dispatch",
      "Control authority changed before external dispatch",
    );
  }
}
