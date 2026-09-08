import { fileURLToPath } from "node:url";
import { z } from "zod";
import { StateFileIdentitySchema } from "../domain/state-file-identity.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import type { CommitRecord } from "../domain/commits.js";
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

/** Fixed kernel worker request, never an orchestrator-selected command or pathname. */
export const CommitIORequestSchema = z.strictObject({
  stateFile: StateFileIdentitySchema,
  workspaceRoot: z.string().startsWith("/"),
  authority: z.strictObject({
    runId: z.string().min(1),
    ownerToken: z.string().min(1),
    leaseId: z.string().min(1),
  }),
  commitId: z.uuid(),
});
type CommitIORequest = z.infer<typeof CommitIORequestSchema>;
const entrypoint = fileURLToPath(new URL("../../dist/adapters/commit-io-cli.js", import.meta.url));
function launchFor(request: CommitIORequest, workspace: string): CommandLaunch {
  return {
    command: process.execPath,
    args: [entrypoint],
    cwd: workspace,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    extraInput: JSON.stringify(request),
  };
}

/** Check the original live intent again inside the worker before any repository I/O. */
export function assertCommitWorker(journal: OrchestrationJournal, request: CommitIORequest) {
  const { authority } = request;
  const record = journal.commits.assertWritable(authority, request.commitId);
  const operation = journal.agents.workspaceOperation(authority.runId, record.workspaceOperationId);
  const workspace = journal.agents.workspace(authority.runId, record);
  if (
    digestJson(journal.storageIdentity()) !== digestJson(request.stateFile) ||
    record.status !== "preparing" ||
    operation.kind !== "commit" ||
    operation.workspaceId !== record.workspaceId ||
    operation.workspaceGeneration !== record.workspaceGeneration ||
    operation.stopEvidence ||
    operation.executionStop ||
    !operation.execution ||
    operation.execution.scopeDigest !== workspaceExecutionScope(operation) ||
    operation.execution.launchDigest !== digestJson(launchFor(request, workspace.path))
  )
    throw new Error("Private commit worker differs from its live admitted intent");
  return record;
}

/** Only stop/fence the original writer. A receipt cannot establish a commit or approval. */
export async function reconcileCommitIO(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  commitId: string,
) {
  journal.assertAuthority(authority);
  const record = journal.commits.record(authority.runId, commitId);
  let operation = journal.agents.workspaceOperation(authority.runId, record.workspaceOperationId);
  // An unbound/unknown operation still needs its own independent stop proof. In
  // particular, a missing ref or a lost lease cannot release an old exclusion.
  if (!operation.execution || operation.stopEvidence) return;
  if (!operation.executionStop) {
    const receipt = await recoverCommandStop(operation.execution);
    if (!receipt)
      throw new NamespaceStopUnprovenError(
        "Private commit writer has no independent stop receipt; preserve workspace exclusion",
      );
    operation = journal.agents.recordWorkspaceExecutionStop(
      authority,
      operation.operationId,
      receipt,
    );
  }
  const receipt = operation.executionStop!;
  const complete =
    receipt.kind === "stopped" &&
    receipt.code === 0 &&
    receipt.reason === null &&
    receipt.error === null;
  journal.agents.finishWorkspaceOperation(
    authority,
    operation.operationId,
    complete ? "succeeded" : "failed",
    "Independent complete private-commit writer stop receipt retained; commit existence, source integrity and exact-revision approval remain separate",
  );
}

/** Supervise preflight, tree/object writes and retention-ref write as one lifetime. */
export async function runCommitIO(
  journal: OrchestrationJournal,
  workspaces: WorkspaceManager,
  authority: ControllerAuthority,
  record: CommitRecord,
  signal?: AbortSignal,
) {
  journal.commits.assertWritable(authority, record.commitId);
  const operation = journal.agents.workspaceOperation(authority.runId, record.workspaceOperationId);
  const workspace = journal.agents.workspace(authority.runId, record);
  const request = CommitIORequestSchema.parse({
    stateFile: journal.storageIdentity(),
    workspaceRoot: workspaces.storageRoot(),
    authority,
    commitId: record.commitId,
  });
  const launch = launchFor(request, workspace.path);
  try {
    signal?.throwIfAborted();
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
    assertCommitWorker(journal, request);
    signal?.throwIfAborted();
    const handle = startDurableCommand(intent, launch);
    const interrupt = () => handle.interrupt();
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
    handle.child.stdout!.resume();
    let diagnostics = "";
    handle.child.stderr!.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString("utf8")).slice(-8000);
    });
    try {
      const { receipt } = await handle.result;
      if (receipt.code !== 0 || receipt.reason || receipt.error)
        journal.appendObservation(authority, {
          source: "kernel",
          sourceEventId: `commit-worker-${intent.ioId}`,
          kind: "commit.worker_stopped",
          summary: redactSensitiveText(
            `Private commit writer stopped: ${receipt.reason ?? receipt.error ?? `exit ${receipt.code}`}. ${diagnostics}`,
            7999,
          ),
          artifactIds: [],
          identity: null,
          wakesOrchestrator: true,
        });
    } finally {
      signal?.removeEventListener("abort", interrupt);
    }
  } finally {
    // Reconciliation reads the original one-use gate/receipt even if dispatch or
    // result delivery failed. Missing proof deliberately keeps the exclusion.
    await reconcileCommitIO(journal, authority, record.commitId);
  }
}
