import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ControllerAuthority, ObservationInput } from "../domain/orchestration.js";
import { StateFileIdentitySchema } from "../domain/state-file-identity.js";
import {
  workspaceInspectionScope,
  type WorkspaceInspection,
} from "../domain/workspace-inspection.js";
import { digestJson } from "../domain/repository-policy.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { NamespaceStopUnprovenError } from "./pid-namespace.js";
import {
  prepareCommandLifetime,
  startDurableCommand,
  recoverCommandStop,
  type CommandLaunch,
} from "./command-lifetime.js";
import { redactSensitiveText } from "../util/redact.js";

export const WorkspaceInspectionRequestSchema = z.strictObject({
  stateFile: StateFileIdentitySchema,
  authority: z.strictObject({
    runId: z.string().min(1),
    ownerToken: z.string().min(1),
    leaseId: z.string().min(1),
  }),
  inspectionId: z.uuid(),
});
type Request = z.infer<typeof WorkspaceInspectionRequestSchema>;
const entrypoint = fileURLToPath(
  new URL("../../dist/adapters/workspace-inspection-io-cli.js", import.meta.url),
);
function launchFor(request: Request): CommandLaunch {
  return {
    command: process.execPath,
    args: [entrypoint],
    cwd: dirname(request.stateFile.path),
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    extraInput: JSON.stringify(request),
  };
}
export function assertWorkspaceInspectionWorker(journal: OrchestrationJournal, request: Request) {
  const record = journal.workspaceInspections.assertOwned(request.authority, request.inspectionId);
  if (
    digestJson(journal.storageIdentity()) !== digestJson(request.stateFile) ||
    !record.execution ||
    record.execution.launchDigest !== digestJson(launchFor(request))
  )
    throw new Error("Inspection worker differs from the exact admitted request");
  return record;
}
/** Only recover the original receipt/gate. No new filesystem inspection is dispatched here. */
export async function reconcileWorkspaceInspectionIO(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  inspectionId: string,
) {
  journal.assertAuthority(authority);
  const record = journal.workspaceInspections.get(authority.runId, inspectionId);
  if (record.execution && !record.stop) {
    const stop = await recoverCommandStop(record.execution);
    if (!stop)
      throw new NamespaceStopUnprovenError(
        "Complete workspace inspection has no independent stop receipt; preserve its source exclusion",
      );
    journal.workspaceInspections.recordStop(authority, inspectionId, stop);
  }
  return journal.workspaceInspections.finish(authority, inspectionId);
}
export async function runWorkspaceInspectionIO(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  record: WorkspaceInspection,
  signal?: AbortSignal,
) {
  const request = WorkspaceInspectionRequestSchema.parse({
    stateFile: journal.storageIdentity(),
    authority,
    inspectionId: record.inspectionId,
  });
  const launch = launchFor(request);
  let diagnostic: ObservationInput | undefined;
  try {
    signal?.throwIfAborted();
    const intent = await prepareCommandLifetime(
      {
        runId: authority.runId,
        operationId: record.inspectionId,
        controllerLeaseId: authority.leaseId,
        scopeDigest: workspaceInspectionScope(record),
        timeoutMs: 120_000,
      },
      launch,
    );
    journal.workspaceInspections.bind(authority, record.inspectionId, intent);
    assertWorkspaceInspectionWorker(journal, request);
    signal?.throwIfAborted();
    const handle = startDurableCommand(intent, launch),
      interrupt = () => handle.interrupt();
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
    handle.child.stdout!.resume();
    let diagnostics = "";
    handle.child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      diagnostics = (diagnostics + chunk).slice(-8000);
    });
    try {
      const { receipt } = await handle.result;
      if (receipt.code !== 0 || receipt.reason || receipt.error)
        diagnostic = {
          source: "kernel",
          sourceEventId: `inspection-worker-${intent.ioId}`,
          kind: "workspace.inspection_worker_stopped",
          summary: redactSensitiveText(
            `Inspection worker stopped: ${receipt.reason ?? receipt.error ?? `exit ${receipt.code}`}. ${diagnostics}`,
            7999,
          ),
          artifactIds: [],
          identity: null,
          wakesOrchestrator: true,
        };
    } finally {
      signal?.removeEventListener("abort", interrupt);
    }
  } catch (error) {
    journal.assertAuthority(authority);
    diagnostic = {
      source: "kernel",
      sourceEventId: `inspection-worker-error-${record.inspectionId}`,
      kind: "workspace.inspection_worker_error",
      summary: redactSensitiveText(
        error instanceof Error ? error.message : "Inspection worker failed",
        7999,
      ),
      artifactIds: [],
      identity: null,
      wakesOrchestrator: true,
    };
  }
  // Durable settlement and caller completion are separate contracts. Never let
  // cancellation bypass stop proof, or let a retained observation erase cancellation.
  let settled: WorkspaceInspection;
  try {
    settled = await reconcileWorkspaceInspectionIO(journal, authority, record.inspectionId);
  } catch (error) {
    try {
      if (diagnostic) journal.appendObservation(authority, diagnostic);
    } catch {
      // An unavailable diagnostic sink must not mask unproven stop or failed settlement.
    }
    throw error;
  }
  try {
    if (diagnostic) journal.appendObservation(authority, diagnostic);
  } finally {
    signal?.throwIfAborted();
  }
  return settled;
}
