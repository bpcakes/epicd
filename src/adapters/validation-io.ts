import { fileURLToPath } from "node:url";
import { z } from "zod";
import { StateFileIdentitySchema } from "../domain/state-file-identity.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import type { ValidationEvidence } from "../domain/delivery.js";
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

/** Kernel-private request, delivered on a private descriptor, never a model capability. */
export const ValidationIORequestSchema = z.strictObject({
  stateFile: StateFileIdentitySchema,
  workspaceRoot: z.string().startsWith("/"),
  authority: z.strictObject({
    runId: z.string().min(1),
    ownerToken: z.string().min(1),
    leaseId: z.string().min(1),
  }),
  evidenceId: z.uuid(),
});
type ValidationIORequest = z.infer<typeof ValidationIORequestSchema>;
const entrypoint = fileURLToPath(
  new URL("../../dist/adapters/validation-io-cli.js", import.meta.url),
);

function launchFor(request: ValidationIORequest, workspace: string): CommandLaunch {
  return {
    command: process.execPath,
    args: [entrypoint],
    cwd: workspace,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    extraInput: JSON.stringify(request),
  };
}

/** Also checked inside the worker before any repository/environment I/O. */
export function assertValidationWorker(
  journal: OrchestrationJournal,
  request: ValidationIORequest,
) {
  const { authority } = request;
  journal.assertAuthority(authority);
  const evidence = journal.delivery.evidence(authority.runId, request.evidenceId);
  const operation = journal.agents.workspaceOperation(
    authority.runId,
    evidence.workspaceOperationId,
  );
  const control = journal.control(authority.runId);
  const workspace = journal.agents.workspace(authority.runId, evidence);
  if (
    digestJson(journal.storageIdentity()) !== digestJson(request.stateFile) ||
    evidence.status !== "running" ||
    evidence.controllerLeaseId !== authority.leaseId ||
    control.status !== "active" ||
    control.policyDigest !== evidence.policyDigest ||
    journal.actionForOperation(authority.runId, evidence.operationId)?.status !== "running" ||
    operation.kind !== "validation" ||
    operation.workspaceId !== evidence.workspaceId ||
    operation.workspaceGeneration !== evidence.workspaceGeneration ||
    operation.stopEvidence ||
    operation.executionStop ||
    !operation.execution ||
    operation.execution.scopeDigest !== workspaceExecutionScope(operation) ||
    operation.execution.launchDigest !== digestJson(launchFor(request, workspace.path))
  )
    throw new Error("Complete validation worker differs from its live admitted intent");
  return evidence;
}

/** Observe/fence the original execution only. Never launch, replay, or infer a check result. */
export async function reconcileValidationIO(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  evidenceId: string,
) {
  journal.assertAuthority(authority);
  const evidence = journal.delivery.evidence(authority.runId, evidenceId);
  const operation = journal.agents.workspaceOperation(
    authority.runId,
    evidence.workspaceOperationId,
  );
  if (operation.execution && !operation.executionStop) {
    const receipt = await recoverCommandStop(operation.execution);
    if (!receipt)
      throw new NamespaceStopUnprovenError(
        "Complete validation worker has no independent stop receipt; preserve workspace exclusion",
      );
    journal.agents.recordWorkspaceExecutionStop(authority, operation.operationId, receipt);
  }
  return journal.delivery.finishValidationIO(authority, evidenceId);
}

/** One supervisor covers preflight, the confined check, service handling and postinspection. */
export async function runValidationIO(
  journal: OrchestrationJournal,
  workspaces: WorkspaceManager,
  authority: ControllerAuthority,
  evidence: ValidationEvidence,
  signal: AbortSignal,
): Promise<ValidationEvidence> {
  const operation = journal.agents.workspaceOperation(
    authority.runId,
    evidence.workspaceOperationId,
  );
  const workspace = journal.agents.workspace(authority.runId, evidence);
  const request = ValidationIORequestSchema.parse({
    stateFile: journal.storageIdentity(),
    workspaceRoot: workspaces.storageRoot(),
    authority,
    evidenceId: evidence.evidenceId,
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
        // Admission and postinspection have a bounded two-minute allowance. The
        // repository command retains its independently enforced exact check timeout.
        timeoutMs: Math.min(2_147_483_647, evidence.check.timeoutMs + 120_000),
      },
      launch,
    );
    journal.agents.bindWorkspaceExecution(authority, operation.operationId, intent);
    assertValidationWorker(journal, request);
    signal.throwIfAborted();
    const handle = startDurableCommand(intent, launch);
    const interrupt = () => handle.interrupt();
    signal.addEventListener("abort", interrupt, { once: true });
    if (signal.aborted) interrupt();
    // Outcomes are transactionally retained by the worker. Pipe output is not evidence.
    handle.child.stdout!.resume();
    let diagnostics = "";
    handle.child.stderr!.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString("utf8")).slice(-8000);
    });
    try {
      const result = await handle.result;
      if (result.receipt.code !== 0 || result.receipt.reason || result.receipt.error)
        journal.appendObservation(authority, {
          source: "validation",
          sourceEventId: `worker-${intent.ioId}`,
          kind: "validation.worker_stopped",
          summary: redactSensitiveText(
            `Complete validation worker stopped: ${result.receipt.reason ?? result.receipt.error ?? `exit ${result.receipt.code}`}. ${diagnostics}`,
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
    // A supervisor error may still have a genuine receipt. Reconcile the exact
    // binding; missing proof throws and retains exclusion instead of a false stop.
    journal.assertAuthority(authority);
    const settled = await reconcileValidationIO(journal, authority, evidence.evidenceId);
    journal.appendObservation(authority, {
      source: "validation",
      sourceEventId: `worker-error-${evidence.evidenceId}`,
      kind: "validation.worker_error",
      summary: redactSensitiveText(
        error instanceof Error ? error.message : "Validation worker execution failed",
        7999,
      ),
      artifactIds: [],
      identity: null,
      wakesOrchestrator: true,
    });
    if (settled.status === "interrupted") return settled;
    throw error;
  }
  return reconcileValidationIO(journal, authority, evidence.evidenceId);
}
