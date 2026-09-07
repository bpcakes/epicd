import type { ActionKernel } from "./actions.js";
import { KernelBeads } from "../adapters/kernel-beads.js";
import { TrackerAdapter } from "../adapters/tracker.js";
import { OperationFailed, CapabilityRejected } from "./guards.js";
import type { TrackerOperation } from "../domain/tracker.js";
import type { ControllerAuthority } from "../domain/orchestration.js";

const resource = (record: TrackerOperation) => ({
  kind: "resource" as const,
  resourceId: record.trackerOperationId,
  generation: 1,
});
export function registerTrackerCapabilities(kernel: ActionKernel, transport: KernelBeads) {
  const journal = kernel.journal;
  const adapter = new TrackerAdapter(journal, transport);
  kernel.registerLocal("inspect_tracker", ({ authority }, action) => {
    const snapshot = journal.tracker.snapshot(authority.runId, action.snapshotId ?? undefined);
    const content = {
      snapshotId: snapshot.snapshotId,
      digest: snapshot.digest,
      epicId: snapshot.graph.epicId,
      startedAt: snapshot.graph.startedAt,
      capturedAt: snapshot.graph.capturedAt,
      issues: snapshot.graph.issues
        .slice(action.offset, action.offset + action.limit)
        .map((issue) => ({
          ...issue,
          observedReady: snapshot.graph.readyIds.includes(issue.id),
          description: issue.description.slice(0, 2000),
          acceptanceCriteria: issue.acceptanceCriteria.slice(0, 2000),
          instructions: issue.instructions?.slice(0, 2000) ?? null,
          dependencies: issue.dependencies.slice(0, 25),
          dependents: issue.dependents.slice(0, 25),
          truncatedFields: (
            [
              "description",
              "acceptanceCriteria",
              "instructions",
              "dependencies",
              "dependents",
            ] as const
          ).filter(
            (field) =>
              (issue[field]?.length ?? 0) >
              (field === "dependencies" || field === "dependents" ? 25 : 2000),
          ),
        })),
      nextOffset: null as number | null,
      warning:
        "Captured graph; parent-child edges define scope. Read truncated fields with read_tracker_issue using this snapshot ID. Ready observations are advisory until the kernel's fresh claim gate.",
    };
    while (Buffer.byteLength(JSON.stringify(content)) > 64000 && content.issues.length > 1)
      content.issues.pop();
    if (Buffer.byteLength(JSON.stringify(content)) > 64000)
      throw new CapabilityRejected(
        "tracker_issue_too_large",
        "This issue exceeds the inspection budget; a paged text reader is required",
      );
    if (action.offset + content.issues.length < snapshot.graph.issues.length)
      content.nextOffset = action.offset + content.issues.length;
    return { kind: "inspection", text: JSON.stringify(content), artifactIds: [] };
  });
  kernel.registerLocal("read_tracker_issue", ({ authority }, action) => {
    const snapshot = journal.tracker.snapshot(authority.runId, action.snapshotId);
    const issue = snapshot.graph.issues.find((issue) => issue.id === action.taskId);
    if (!issue)
      throw new CapabilityRejected("tracker_issue_missing", "Issue is not in this snapshot");
    const value = issue[action.field];
    const full = Array.isArray(value) ? JSON.stringify(value) : (value ?? "");
    const content = {
      snapshotId: snapshot.snapshotId,
      digest: snapshot.digest,
      taskId: issue.id,
      field: action.field,
      offset: action.offset,
      text: full.slice(action.offset, action.offset + action.limit),
      nextOffset: null as number | null,
    };
    while (Buffer.byteLength(JSON.stringify(content)) > 60000)
      content.text = content.text.slice(0, Math.floor(content.text.length / 2));
    if (action.offset + content.text.length < full.length)
      content.nextOffset = action.offset + content.text.length;
    return { kind: "inspection", text: JSON.stringify(content), artifactIds: [] };
  });
  kernel.registerLocal("inspect_tracker_operation", ({ authority }, action) => {
    const {
      controllerLeaseId: _lease,
      ioLeaseId: _io,
      ...record
    } = journal.tracker.record(authority.runId, action.trackerOperationId);
    return { kind: "inspection", text: JSON.stringify(record), artifactIds: [] };
  });
  for (const kind of [
    "refresh_tracker",
    "export_tracker",
    "request_beads_transition",
    "complete_run",
  ] as const)
    kernel.registerExternal(kind, async ({ authority, record, signal }) => {
      const intent = journal.tracker.reserve(authority, record.actionId);
      const result = await adapter.execute(authority, intent.trackerOperationId, signal);
      if (result.kind === "complete" && result.completion) return resource(result);
      if (!result.outcome) throw new Error("Tracker effect requires explicit reconciliation");
      if (
        result.outcome !== "observed" &&
        result.outcome !== "exported" &&
        result.outcome !== "claimed" &&
        result.outcome !== "closed"
      )
        throw new OperationFailed(
          `Tracker ${result.trackerOperationId}: ${result.failure ?? result.outcome}`,
        );
      return resource(result);
    });
  kernel.registerExternal("reconcile_tracker_operation", async ({ authority, signal }, action) => {
    const record = await reconcileTracker(
      kernel,
      adapter,
      authority,
      action.trackerOperationId,
      signal,
    );
    if (!record.outcome && !(record.kind === "complete" && record.completion))
      throw new Error("Tracker reconciliation still awaits current authority");
    return resource(record);
  });
  return adapter;
}
export async function reconcileTracker(
  kernel: ActionKernel,
  adapter: TrackerAdapter,
  authority: ControllerAuthority,
  id: string,
  signal?: AbortSignal,
) {
  const record = await adapter.reconcile(authority, id, signal);
  // Read-only bootstrap inspection can run while paused. A stopped physical
  // effect with no admissible outcome must not terminally fail its parent.
  if (!record.outcome && !(record.kind === "complete" && record.completion)) return record;
  const action = kernel.journal.action(authority.runId, record.actionId);
  const terminalReconciler =
    record.kind === "complete" &&
    record.completion &&
    !record.outcome &&
    kernel.journal
      .actions(authority.runId)
      .some(
        (entry) =>
          entry.status === "running" &&
          entry.request.action.kind === "reconcile_tracker_operation" &&
          entry.request.action.trackerOperationId === id,
      );
  if (
    action &&
    (action.status === "running" || action.status === "indeterminate") &&
    !kernel.operation(action.operationId) &&
    !terminalReconciler
  ) {
    if (
      (["observed", "exported", "claimed", "closed", "completed"].includes(record.outcome ?? "") ||
        (record.kind === "complete" && record.completion)) &&
      action.policyDigest === kernel.journal.control(authority.runId).policyDigest
    )
      kernel.journal.settleAction(authority, action.actionId, action.status, {
        status: "succeeded",
        actionId: action.actionId,
        result: resource(record),
      });
    else
      kernel.journal.settleAction(authority, action.actionId, action.status, {
        status: "failed",
        actionId: action.actionId,
        problemId: `tracker-${id}`,
      });
  }
  return kernel.journal.tracker.record(authority.runId, id);
}
