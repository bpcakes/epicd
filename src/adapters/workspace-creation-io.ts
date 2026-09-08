import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ControllerAuthority } from "../domain/orchestration.js";
import { StateFileIdentitySchema } from "../domain/state-file-identity.js";
import { workspaceCreationScope, type WorkspaceCreation } from "../domain/workspace-creation.js";
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

export const WorkspaceCreationRequestSchema = z.strictObject({
  stateFile: StateFileIdentitySchema,
  authority: z.strictObject({
    runId: z.string().min(1),
    ownerToken: z.string().min(1),
    leaseId: z.string().min(1),
  }),
  creationId: z.uuid(),
});
type Request = z.infer<typeof WorkspaceCreationRequestSchema>;
const entrypoint = fileURLToPath(
  new URL("../../dist/adapters/workspace-creation-io-cli.js", import.meta.url),
);
function launchFor(request: Request): CommandLaunch {
  // The destination may not exist; the exact state directory already does. It is never an agent mount.
  return {
    command: process.execPath,
    args: [entrypoint],
    cwd: dirname(request.stateFile.path),
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    extraInput: JSON.stringify(request),
  };
}
export function assertWorkspaceCreationWorker(journal: OrchestrationJournal, request: Request) {
  const record = journal.workspaceCreations.assertWritable(request.authority, request.creationId);
  if (
    digestJson(journal.storageIdentity()) !== digestJson(request.stateFile) ||
    !record.execution ||
    record.execution.launchDigest !== digestJson(launchFor(request))
  )
    throw new Error("Creation worker differs from the exact admitted request");
  return record;
}
/** Reads or fences the original one-use execution; never launches or repeats creation. */
export async function reconcileWorkspaceCreationIO(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  creationId: string,
) {
  journal.assertAuthority(authority);
  const record = journal.workspaceCreations.get(authority.runId, creationId);
  if (record.execution && !record.stop) {
    const stop = await recoverCommandStop(record.execution);
    if (!stop)
      throw new NamespaceStopUnprovenError(
        "Complete workspace creation has no independent stop receipt; preserve both copy resources",
      );
    journal.workspaceCreations.recordStop(authority, creationId, stop);
  }
  return journal.workspaceCreations.finish(authority, creationId);
}
export async function runWorkspaceCreationIO(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  record: WorkspaceCreation,
  signal?: AbortSignal,
) {
  const request = WorkspaceCreationRequestSchema.parse({
    stateFile: journal.storageIdentity(),
    authority,
    creationId: record.creationId,
  });
  const launch = launchFor(request);
  try {
    signal?.throwIfAborted();
    const intent = await prepareCommandLifetime(
      {
        runId: authority.runId,
        operationId: record.creationId,
        controllerLeaseId: authority.leaseId,
        scopeDigest: workspaceCreationScope(record),
        timeoutMs: 120_000,
      },
      launch,
    );
    journal.workspaceCreations.bind(authority, record.creationId, intent);
    assertWorkspaceCreationWorker(journal, request);
    signal?.throwIfAborted();
    const handle = startDurableCommand(intent, launch),
      interrupt = () => handle.interrupt();
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
    handle.child.stdout!.resume(); // Only the durable journal result confers creation custody.
    let diagnostics = "";
    handle.child.stderr!.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString("utf8")).slice(-8000);
    });
    try {
      const result = await handle.result;
      if (result.receipt.code !== 0 || result.receipt.reason || result.receipt.error)
        journal.appendObservation(authority, {
          source: "kernel",
          sourceEventId: `creation-worker-${intent.ioId}`,
          kind: "workspace.creation_worker_stopped",
          summary: redactSensitiveText(
            `Creation worker stopped: ${result.receipt.reason ?? result.receipt.error ?? `exit ${result.receipt.code}`}. ${diagnostics}`,
            7999,
          ),
          artifactIds: [],
          identity: null,
          wakesOrchestrator: true,
        });
    } finally {
      signal?.removeEventListener("abort", interrupt);
    }
  } catch (error) {
    journal.assertAuthority(authority);
    const settled = await reconcileWorkspaceCreationIO(journal, authority, record.creationId);
    journal.appendObservation(authority, {
      source: "kernel",
      sourceEventId: `creation-worker-error-${record.creationId}`,
      kind: "workspace.creation_worker_error",
      summary: redactSensitiveText(
        error instanceof Error ? error.message : "Creation worker failed",
        7999,
      ),
      artifactIds: [],
      identity: null,
      wakesOrchestrator: true,
    });
    return settled;
  }
  return reconcileWorkspaceCreationIO(journal, authority, record.creationId);
}
