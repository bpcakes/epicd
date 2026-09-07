import type { ControllerAuthority } from "../domain/orchestration.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { KernelBeads } from "./kernel-beads.js";
import { claimable } from "../domain/tracker.js";

const detail = (error: unknown) =>
  error instanceof Error ? error.message : "Tracker operation failed";
export class TrackerAdapter {
  constructor(
    readonly journal: OrchestrationJournal,
    readonly transport: KernelBeads,
  ) {}
  async execute(authority: ControllerAuthority, id: string, signal: AbortSignal) {
    const tracker = this.journal.tracker;
    const record = tracker.start(authority, id); // Duplicate dispatch cannot settle the original I/O.
    let failure: string | null = null;
    const guard = () => {
      signal.throwIfAborted();
      tracker.assertWritable(authority, id);
    };
    try {
      const run = tracker.run(authority.runId);
      const binding = await this.transport.bind(run.repoPath);
      tracker.bind(authority, id, binding);
      const graph = await this.transport.graph(binding, run.epicId, guard, signal);
      tracker.recordSnapshot(authority, id, graph, record.kind === "refresh" ? "after" : "before");
      if (record.kind !== "refresh") {
        claimable(graph, record.taskId!, record.kind);
        tracker.mutation(authority, id);
        try {
          await this.transport.claim(binding, record.taskId!, record.runId, guard, signal);
        } catch (error) {
          failure = detail(error);
        }
        guard();
        tracker.recordSnapshot(
          authority,
          id,
          await this.transport.graph(binding, run.epicId, guard, signal),
          "after",
        );
      }
    } catch (error) {
      failure = detail(error);
    } finally {
      tracker.stopIO(authority, id, failure);
    }
    return tracker.finish(authority, id);
  }
  async reconcile(
    authority: ControllerAuthority,
    id: string,
    signal: AbortSignal = new AbortController().signal,
  ) {
    const tracker = this.journal.tracker;
    const initial = tracker.record(authority.runId, id);
    if (initial.outcome) return initial;
    const record = tracker.beginInspection(authority, id);
    let failure: string | null = null;
    try {
      if (record.mutationDispatched || (record.kind === "refresh" && initial.dispatched)) {
        const run = tracker.run(authority.runId);
        const binding = tracker.binding(authority.runId);
        if (!binding && record.mutationDispatched)
          throw new Error("Tracker storage binding is missing; preserve the unsettled operation");
        if (binding)
          tracker.recordSnapshot(
            authority,
            id,
            await this.transport.graph(
              binding,
              run.epicId,
              () => {
                signal.throwIfAborted();
                tracker.assertIOOwned(authority, id);
              },
              signal,
            ),
            "after",
          );
      }
    } catch (error) {
      failure = detail(error);
    } finally {
      tracker.stopIO(authority, id, failure);
    }
    if (failure) throw new Error(`Tracker reconciliation remains unsettled: ${failure}`);
    return tracker.finish(authority, id);
  }
}
