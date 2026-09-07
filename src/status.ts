import { StateStore, RunNotFoundError } from "./adapters/store.js";
import { resolveAgentSettings } from "./domain/types.js";
import { actionContextRecord } from "./kernel/action-context.js";

/** Delivery status is a journal projection, never a caller-owned phase snapshot. */
export function runStatusView(store: StateStore, runId: string) {
  const state = store.get(runId);
  if (!state) throw new RunNotFoundError(runId);
  const journal = store.orchestration;
  return {
    runId,
    repoPath: state.repoPath,
    epicId: state.epicId,
    epicTitle: state.epicTitle,
    runtime: state.runtime,
    settings: resolveAgentSettings(state),
    control: journal.control(runId),
    controller: store.controllerLease(runId),
    escalation: journal.pendingEscalation(runId),
    agents: journal.agents.summaries(runId),
    actions: journal.actions(runId).slice(-20).map(actionContextRecord),
    delivery: journal.delivery.summaries(runId),
    reviews: journal.reviews.summaries(runId),
    commits: journal.commits.summaries(runId),
    publications: journal.publications.summaries(runId),
    tracker: journal.tracker.summary(runId),
    diagnostics: journal.diagnostics.summary(runId),
    events: store.events(runId, 20),
  };
}
export type RunStatus = ReturnType<typeof runStatusView>;
export function humanRunStatus(status: RunStatus): string {
  const lines = [
    `${status.epicId}: ${status.epicTitle}`,
    `Run ${status.runId} · ${status.control.status} · ${status.runtime}`,
    `Orchestrator ${status.settings.orchestrator.model} / ${status.settings.orchestrator.reasoningEffort}`,
    `Decisions ${status.control.decisionsUsed}/${status.control.maxDecisions} · control version ${status.control.controlVersion}`,
    `Controller ${status.controller ? `${status.controller.pid} (${status.controller.alive ? "alive" : "stale"}, lease ${status.controller.leaseId})` : "not attached"}`,
  ];
  if (status.escalation)
    lines.push(`Question ${status.escalation.escalationId}: ${status.escalation.question}`);
  for (const event of status.events.slice(-5))
    lines.push(`${event.at} ${event.kind}: ${event.message}`);
  return lines.join("\n");
}
