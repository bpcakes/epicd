import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import type { WorkspaceDisposal } from "../domain/workspace-disposal.js";
import { workspaceDisposalScope } from "../domain/workspace-disposal.js";
import { StateFileIdentitySchema } from "../domain/state-file-identity.js";
import { digestJson } from "../domain/repository-policy.js";
import {
  prepareCommandLifetime,
  startDurableCommand,
  recoverCommandStop,
  type CommandLaunch,
} from "./command-lifetime.js";
import { inspectWorkspaceDisposal } from "./workspace-disposal-files.js";
import { NamespaceStopUnprovenError } from "./pid-namespace.js";
import { redactSensitiveText } from "../util/redact.js";

export const WorkspaceDisposalRequestSchema = z.strictObject({
  stateFile: StateFileIdentitySchema,
  authority: z.strictObject({
    runId: z.string().min(1),
    ownerToken: z.string().min(1),
    leaseId: z.string().min(1),
  }),
  disposalId: z.uuid(),
});
type Request = z.infer<typeof WorkspaceDisposalRequestSchema>;
const entrypoint = fileURLToPath(
  new URL("../../dist/adapters/workspace-disposal-io-cli.js", import.meta.url),
);
function launchFor(request: Request, record: WorkspaceDisposal): CommandLaunch {
  return {
    command: process.execPath,
    args: [entrypoint],
    cwd: record.source.path,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    extraInput: JSON.stringify(request),
  };
}
export function assertWorkspaceDisposalWorker(journal: OrchestrationJournal, request: Request) {
  journal.assertAuthority(request.authority);
  const record = journal.workspaceDisposals.get(request.authority.runId, request.disposalId);
  const workspace = journal.agents.workspace(record.runId, record);
  const action = journal.actionForOperation(record.runId, record.operationId);
  if (
    digestJson(journal.storageIdentity()) !== digestJson(request.stateFile) ||
    record.controllerLeaseId !== request.authority.leaseId ||
    record.outcome ||
    record.stop ||
    !record.execution ||
    record.execution.launchDigest !== digestJson(launchFor(request, record)) ||
    workspace.status !== "retired" ||
    digestJson(workspace.directory) !== digestJson(record.source) ||
    action?.status !== "running" ||
    action.request.action.kind !== "dispose_workspace" ||
    action.policyDigest !== journal.control(record.runId).policyDigest ||
    journal.control(record.runId).status !== "active"
  )
    throw new Error("Workspace disposal differs from its live admitted intent");
  return record;
}

export async function reconcileWorkspaceDisposal(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  disposalId: string,
) {
  journal.assertAuthority(authority);
  let record = journal.workspaceDisposals.get(authority.runId, disposalId);
  if (record.outcome) return record;
  if (!record.execution)
    return journal.workspaceDisposals.finish(
      authority,
      disposalId,
      "not_moved",
      null,
      "Disposal was never bound to a worker; the original binder is now fenced. No move was replayed.",
    );
  if (!record.stop) {
    const stop = await recoverCommandStop(record.execution);
    if (!stop)
      throw new NamespaceStopUnprovenError(
        "Workspace disposal worker stop is unproven; preserve exclusion",
      );
    record = journal.workspaceDisposals.recordStop(authority, disposalId, stop);
  }
  if (record.stop!.kind === "not_started")
    return journal.workspaceDisposals.finish(
      authority,
      disposalId,
      "not_moved",
      null,
      "The original one-use gate proves this disposal never started; no move was replayed.",
    );
  const observed = await inspectWorkspaceDisposal(record);
  return journal.workspaceDisposals.finish(
    authority,
    disposalId,
    observed.outcome,
    observed.sourcePathOccupied,
    observed.detail,
  );
}

export async function runWorkspaceDisposal(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  record: WorkspaceDisposal,
  signal: AbortSignal,
) {
  const request = WorkspaceDisposalRequestSchema.parse({
    stateFile: journal.storageIdentity(),
    authority,
    disposalId: record.disposalId,
  });
  const launch = launchFor(request, record);
  let errorDetail: string | null = null;
  try {
    signal.throwIfAborted();
    const execution = await prepareCommandLifetime(
      {
        runId: record.runId,
        operationId: record.operationId,
        controllerLeaseId: authority.leaseId,
        scopeDigest: workspaceDisposalScope(record),
        timeoutMs: 120_000,
      },
      launch,
    );
    journal.workspaceDisposals.bind(authority, record.disposalId, execution);
    assertWorkspaceDisposalWorker(journal, request);
    signal.throwIfAborted();
    const handle = startDurableCommand(execution, launch);
    const interrupt = () => handle.interrupt();
    signal.addEventListener("abort", interrupt, { once: true });
    if (signal.aborted) interrupt();
    handle.child.stdout!.resume();
    let diagnostics = "";
    handle.child.stderr!.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString("utf8")).slice(-4000);
    });
    try {
      const result = await handle.result;
      if (result.receipt.code !== 0 || result.receipt.error || result.receipt.reason)
        errorDetail = `${result.receipt.reason ?? result.receipt.error ?? `exit ${result.receipt.code}`}: ${diagnostics}`;
    } finally {
      signal.removeEventListener("abort", interrupt);
    }
  } catch (error) {
    errorDetail = error instanceof Error ? error.message : "Workspace disposal worker failed";
  }
  journal.assertAuthority(authority);
  if (errorDetail)
    journal.appendObservation(authority, {
      source: "workspace-disposal",
      sourceEventId: `${record.disposalId}:worker_error`,
      kind: "workspace.disposal_worker_error",
      summary: redactSensitiveText(errorDetail, 3999),
      identity: null,
      artifactIds: [],
      wakesOrchestrator: true,
    });
  return reconcileWorkspaceDisposal(journal, authority, record.disposalId);
}
