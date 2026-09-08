import { fileURLToPath } from "node:url";
import { z } from "zod";
import { StateFileIdentitySchema } from "../domain/state-file-identity.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import { CandidateIdentitySchema, type CandidateIdentity } from "../domain/delivery.js";
import { workspaceExecutionScope } from "../domain/workspaces.js";
import { digestJson } from "../domain/repository-policy.js";
import { redactSensitiveText } from "../util/redact.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import type { WorkspaceManager } from "./workspaces.js";
import { NamespaceStopUnprovenError } from "./pid-namespace.js";
import {
  prepareCommandLifetime,
  startDurableCommand,
  recoverCommandStop,
  type CommandLaunch,
} from "./command-lifetime.js";

/** Kernel-generated request on a private descriptor, never model-selected executable input. */
export const CaptureIORequestSchema = z.strictObject({
  stateFile: StateFileIdentitySchema,
  workspaceRoot: z.string().startsWith("/"),
  authority: z.strictObject({
    runId: z.string().min(1),
    ownerToken: z.string().min(1),
    leaseId: z.string().min(1),
  }),
  candidate: CandidateIdentitySchema,
});
type CaptureIORequest = z.infer<typeof CaptureIORequestSchema>;
const entrypoint = fileURLToPath(new URL("../../dist/adapters/capture-io-cli.js", import.meta.url));
function launchFor(request: CaptureIORequest, workspace: string): CommandLaunch {
  return {
    command: process.execPath,
    args: [entrypoint],
    cwd: workspace,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    extraInput: JSON.stringify(request),
  };
}

/** Rechecked in the fixed child before touching repository files or objects. */
export function assertCaptureWorker(journal: OrchestrationJournal, request: CaptureIORequest) {
  const { authority } = request;
  journal.assertAuthority(authority);
  const candidate = journal.delivery.candidate(authority.runId, request.candidate);
  const io = candidate.captureIO;
  if (!io) throw new Error("Candidate has no capture-worker intent");
  const operation = journal.agents.workspaceOperation(authority.runId, io.workspaceOperationId);
  const workspace = journal.agents.workspace(authority.runId, candidate);
  const control = journal.control(authority.runId);
  if (
    digestJson(journal.storageIdentity()) !== digestJson(request.stateFile) ||
    candidate.status !== "capturing" ||
    io.pendingSnapshot ||
    candidate.failure !== null ||
    io.controllerLeaseId !== authority.leaseId ||
    control.status !== "active" ||
    control.policyDigest !== candidate.policyDigest ||
    journal.actionForOperation(authority.runId, candidate.operationId)?.status !== "running" ||
    operation.kind !== "capture" ||
    operation.workspaceId !== candidate.workspaceId ||
    operation.workspaceGeneration !== candidate.workspaceGeneration ||
    operation.controllerLeaseId !== io.controllerLeaseId ||
    operation.stopEvidence ||
    operation.executionStop ||
    !operation.execution ||
    operation.execution.scopeDigest !== workspaceExecutionScope(operation) ||
    operation.execution.launchDigest !== digestJson(launchFor(request, workspace.path))
  )
    throw new Error("Complete capture worker differs from its live admitted intent");
  return candidate;
}

/** Recover only the original worker. Never reconstruct a manifest or launch a replacement. */
export async function reconcileCaptureIO(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  identity: CandidateIdentity,
) {
  journal.assertAuthority(authority);
  const candidate = journal.delivery.candidate(authority.runId, identity);
  if (!candidate.captureIO) throw new Error("Candidate has no capture-worker intent");
  const operation = journal.agents.workspaceOperation(
    authority.runId,
    candidate.captureIO.workspaceOperationId,
  );
  if (operation.execution && !operation.executionStop) {
    const receipt = await recoverCommandStop(operation.execution);
    if (!receipt)
      throw new NamespaceStopUnprovenError(
        "Complete capture worker has no independent stop receipt; preserve workspace exclusion",
      );
    journal.agents.recordWorkspaceExecutionStop(authority, operation.operationId, receipt);
  }
  return journal.delivery.finishCaptureIO(authority, identity);
}

/** Covers preflight, scanning, object/tree/ref writes and durable snapshot retention. */
export async function runCaptureIO(
  journal: OrchestrationJournal,
  workspaces: WorkspaceManager,
  authority: ControllerAuthority,
  identity: CandidateIdentity,
  signal: AbortSignal,
) {
  const candidate = journal.delivery.candidate(authority.runId, identity);
  if (!candidate.captureIO) throw new Error("Candidate has no capture-worker intent");
  const operation = journal.agents.workspaceOperation(
    authority.runId,
    candidate.captureIO.workspaceOperationId,
  );
  const workspace = journal.agents.workspace(authority.runId, candidate);
  const request = CaptureIORequestSchema.parse({
    stateFile: journal.storageIdentity(),
    workspaceRoot: workspaces.storageRoot(),
    authority,
    candidate: {
      candidateId: candidate.candidateId,
      candidateGeneration: candidate.candidateGeneration,
    },
  });
  const launch = launchFor(request, workspace.path);
  try {
    signal.throwIfAborted();
    const intent = await prepareCommandLifetime(
      {
        runId: authority.runId,
        operationId: operation.operationId,
        controllerLeaseId: authority.leaseId,
        scopeDigest: workspaceExecutionScope(operation),
        timeoutMs: 120_000,
      },
      launch,
    );
    journal.agents.bindWorkspaceExecution(authority, operation.operationId, intent);
    assertCaptureWorker(journal, request);
    signal.throwIfAborted();
    const handle = startDurableCommand(intent, launch);
    const interrupt = () => handle.interrupt();
    signal.addEventListener("abort", interrupt, { once: true });
    if (signal.aborted) interrupt();
    // Pipe output cannot confer snapshot custody or prove stop.
    handle.child.stdout!.resume();
    let diagnostics = "";
    handle.child.stderr!.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString("utf8")).slice(-8000);
    });
    try {
      const result = await handle.result;
      if (result.receipt.code !== 0 || result.receipt.reason || result.receipt.error)
        journal.appendObservation(authority, {
          source: "kernel",
          sourceEventId: `capture-worker-${intent.ioId}`,
          kind: "candidate.worker_stopped",
          summary: redactSensitiveText(
            `Complete capture worker stopped: ${result.receipt.reason ?? result.receipt.error ?? `exit ${result.receipt.code}`}. ${diagnostics}`,
            7999,
          ),
          artifactIds: [],
          identity: null,
          wakesOrchestrator: true,
        });
    } finally {
      signal.removeEventListener("abort", interrupt);
    }
  } catch (error) {
    journal.assertAuthority(authority);
    const settled = await reconcileCaptureIO(journal, authority, identity);
    journal.appendObservation(authority, {
      source: "kernel",
      sourceEventId: `capture-worker-error-${candidate.candidateId}`,
      kind: "candidate.worker_error",
      summary: redactSensitiveText(
        error instanceof Error ? error.message : "Capture worker failed",
        7999,
      ),
      artifactIds: [],
      identity: null,
      wakesOrchestrator: true,
    });
    return settled;
  }
  return reconcileCaptureIO(journal, authority, identity);
}
