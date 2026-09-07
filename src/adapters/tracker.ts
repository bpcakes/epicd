import type { ControllerAuthority } from "../domain/orchestration.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { KernelBeads } from "./kernel-beads.js";
import { claimable } from "../domain/tracker.js";
import { PublicationGit, PublicationGitError } from "./publication-git.js";
import { NamespaceStopUnprovenError } from "./pid-namespace.js";

const detail = (error: unknown) =>
  error instanceof Error ? error.message : "Tracker operation failed";
export class TrackerAdapter {
  readonly git = new PublicationGit();
  constructor(
    readonly journal: OrchestrationJournal,
    readonly transport: KernelBeads,
  ) {}
  async execute(authority: ControllerAuthority, id: string, signal: AbortSignal) {
    const tracker = this.journal.tracker;
    const record = tracker.start(authority, id); // Duplicate dispatch cannot settle the original I/O.
    let failure: string | null = null;
    let stopUnproven = false;
    const guard = () => {
      signal.throwIfAborted();
      tracker.assertWritable(authority, id);
    };
    try {
      const run = tracker.run(authority.runId);
      const binding = await this.transport.bind(run.repoPath);
      tracker.bind(authority, id, binding);
      if (record.closure) {
        await this.withClosureRefs(authority, id, signal, async (lockedSignal) => {
          const closeGuard = () => {
            lockedSignal.throwIfAborted();
            tracker.assertWritable(authority, id);
          };
          tracker.recordSnapshot(
            authority,
            id,
            await this.transport.graph(binding, run.epicId, closeGuard, lockedSignal),
            "before",
          );
          tracker.mutation(authority, id);
          try {
            const report = await this.transport.close(
              binding,
              record.taskId!,
              record.runId,
              record.operationId,
              record.closure!.reason,
              closeGuard,
              lockedSignal,
            );
            tracker.closureReport(authority, id, report);
          } catch (error) {
            if (error instanceof NamespaceStopUnprovenError) throw error;
            failure = detail(error);
          }
          closeGuard();
          tracker.recordSnapshot(
            authority,
            id,
            await this.transport.graph(binding, run.epicId, closeGuard, lockedSignal),
            "after",
          );
        });
        tracker.closureRefs(authority, id, true);
      } else {
        const graph = await this.transport.graph(binding, run.epicId, guard, signal);
        tracker.recordSnapshot(
          authority,
          id,
          graph,
          record.kind === "refresh" ? "after" : "before",
        );
        if (record.kind !== "refresh") {
          if (record.kind === "close_task") throw new Error("Closure grant missing");
          claimable(graph, record.taskId!, record.kind);
          tracker.mutation(authority, id);
          try {
            await this.transport.claim(binding, record.taskId!, record.runId, guard, signal);
          } catch (error) {
            if (error instanceof NamespaceStopUnprovenError) throw error;
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
      }
    } catch (error) {
      if (error instanceof NamespaceStopUnprovenError) {
        stopUnproven = true;
        throw error;
      }
      failure = detail(error);
      if (record.closure)
        tracker.closureRefs(authority, id, false, error instanceof PublicationGitError);
    } finally {
      if (!stopUnproven) tracker.stopIO(authority, id, failure);
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
    if (record.closure) tracker.closureRefs(authority, id, false);
    let failure: string | null = null;
    let stopUnproven = false;
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
        if (record.closure) {
          try {
            await this.withClosureRefs(authority, id, signal, async (lockedSignal) => {
              lockedSignal.throwIfAborted();
              tracker.assertIOOwned(authority, id);
            });
            tracker.closureRefs(authority, id, true);
          } catch (error) {
            if (!(error instanceof PublicationGitError)) throw error;
            tracker.closureRefs(authority, id, false, true);
            // A known ref conflict is terminal evidence, not permission to re-close.
          }
        }
      }
    } catch (error) {
      if (error instanceof NamespaceStopUnprovenError) {
        stopUnproven = true;
        throw error;
      }
      failure = detail(error);
    } finally {
      if (!stopUnproven) tracker.stopIO(authority, id, failure);
    }
    if (failure) throw new Error(`Tracker reconciliation remains unsettled: ${failure}`);
    return tracker.finish(authority, id);
  }
  private async withClosureRefs(
    authority: ControllerAuthority,
    id: string,
    signal: AbortSignal,
    body: (signal: AbortSignal) => Promise<void>,
  ) {
    const record = this.journal.tracker.record(authority.runId, id);
    if (!record.closure) throw new Error("Closure grant missing");
    const publication = this.journal.publications.record(
      authority.runId,
      record.closure.publicationId,
    );
    if (!publication.canonicalRef || !publication.publicRef)
      throw new Error("Publication ref identities missing");
    await this.git.withPublishedRefs(
      publication.canonicalRef,
      (lockedSignal) => this.git.withPublishedRefs(publication.publicRef!, body, lockedSignal),
      signal,
    );
  }
}
