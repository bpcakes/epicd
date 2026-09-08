import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import { RunStateSchema } from "../domain/types.js";
import { digestJson } from "../domain/repository-policy.js";
import {
  RuntimeHandoffTargetSchema,
  type RuntimeHandoffTarget,
} from "../domain/runtime-handoff.js";

/** Read-only preflight, repeated in the final transaction. A dead lease is never stop proof. */
export function assertRuntimeHandoffReady(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  expectedVersion: number,
) {
  journal.assertAuthority(authority);
  const runId = authority.runId,
    control = journal.control(runId);
  if (control.controlVersion !== expectedVersion)
    throw new Error("Control changed; inspect the run before runtime handoff");
  if (!["paused", "awaiting_user", "blocked"].includes(control.status))
    throw new Error(
      "Pause or resolve active delivery before runtime handoff; completed runs cannot switch",
    );
  if (
    journal
      .actions(runId)
      .some((action) => ["accepted", "running", "indeterminate"].includes(action.status))
  )
    throw new Error("Reconcile all unfinished actions in the recorded runtime before handoff");
  if (
    journal.decisionSource.unsettled(runId) ||
    journal.agents
      .turns(runId)
      .some((turn) => !turn.stopEvidence || (turn.launch !== null && turn.launch.stop === null))
  )
    throw new Error(
      "Runtime handoff requires confirmed stop of every turn and coordinator request",
    );
  for (const workspace of journal.agents.workspaces(runId))
    if (workspace.activeTurnId || journal.agents.activeWorkspaceOperation(runId, workspace))
      throw new Error(
        "Runtime handoff cannot infer workspace I/O stop from controller replacement",
      );
  if (journal.workspaceDisposals.records(runId).some((record) => record.outcome === null))
    throw new Error("Reconcile pending workspace disposal before runtime handoff");
  for (const agent of journal.agents.instances(runId))
    if (
      agent.activeTurnId ||
      journal.agents
        .messages(runId, agent)
        .some((message) => !["acknowledged", "superseded"].includes(message.status))
    )
      throw new Error(
        "Settle pending agent instructions before runtime handoff; no messages are discarded",
      );
  if (
    journal.publications
      .records(runId)
      .some((record) => !record.ioStopped || record.outcome === null) ||
    journal.tracker
      .operations(runId)
      .some((record) => !record.ioStopped || record.outcome === null) ||
    journal.commits
      .records(runId)
      .some((record) => ["preparing", "writing"].includes(record.status)) ||
    journal.trackerCommits
      .records(runId)
      .some((record) => ["preparing", "writing"].includes(record.status)) ||
    journal.reviews.records(runId).some((record) => record.status !== "finished") ||
    journal.fixtures
      .creations(runId)
      .some(
        (record) =>
          !["owned", "not_created"].includes(record.status) ||
          (record.status === "owned" &&
            (!record.clientStopEvidence || !record.observation?.backendStopped)),
      ) ||
    journal.fixtures.validation
      .uses(runId)
      .some((record) => !record.localStopped || !record.remoteStopped)
  )
    throw new Error("Settle retained delivery and fixture operations before runtime handoff");
}

/** Called only in the journal's lease-fenced transaction. No external runtime effect occurs here. */
export function commitRuntimeHandoff(
  db: Database.Database,
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  expectedVersion: number,
  input: RuntimeHandoffTarget,
) {
  if (!db.inTransaction) throw new Error("Runtime handoff must be atomic");
  assertRuntimeHandoffReady(journal, authority, expectedVersion);
  const admission = journal.repositoryAdmission.record(authority.runId);
  if (admission?.phase !== "owned" || !admission.ioStopped)
    throw new Error("Runtime handoff requires settled repository ownership");
  const target = RuntimeHandoffTargetSchema.parse(input);
  const row = db.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(authority.runId) as {
    state_json: string;
  };
  const state = RunStateSchema.parse(JSON.parse(row.state_json));
  if (!state.runtimeConfiguration) throw new Error("Run has no runtime configuration");
  const previous = RuntimeHandoffTargetSchema.parse({
    runtime: state.runtime,
    executable: state.runtimeConfiguration.executable,
    herdr: state.runtimeConfiguration.herdr,
  });
  if (digestJson(previous) === digestJson(target))
    throw new Error("The selected runtime endpoint is already recorded");
  const next = RunStateSchema.parse({
    ...state,
    runtime: target.runtime,
    runtimeConfiguration: {
      ...state.runtimeConfiguration,
      executable: target.executable,
      herdr: target.herdr,
    },
    updatedAt: new Date().toISOString(),
  });
  const retired = journal.agents
    .instances(authority.runId)
    .filter((agent) => agent.status !== "released");
  for (const agent of retired) journal.agents.retireStoppedAgent(authority, agent);
  db.prepare("UPDATE runs SET state_json = ?, updated_at = ? WHERE run_id = ?").run(
    JSON.stringify(next),
    next.updatedAt,
    authority.runId,
  );
  db.prepare(
    "UPDATE decisions SET status = 'cancelled' WHERE run_id = ? AND status = 'pending'",
  ).run(authority.runId);
  journal.noteSettingsChange(authority.runId);
  journal.appendObservation(authority, {
    source: "operator",
    sourceEventId: randomUUID(),
    kind: "operator.runtime_handoff",
    summary: JSON.stringify({
      previous,
      target,
      retiredAgents: retired.length,
      continuity:
        "Fresh conversations; retained evidence, findings, memory, policy, budgets, workspaces and native endpoints. No model started, resource deleted, message discarded or permission granted.",
    }),
    identity: null,
    artifactIds: [],
    wakesOrchestrator: true,
  });
  return next;
}
