import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { StateFileIdentitySchema } from "../domain/state-file-identity.js";
import { publicationIOScope, type PublicationIOAttempt } from "../domain/publication.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
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

export const PublicationIORequestSchema = z.strictObject({
  stateFile: StateFileIdentitySchema,
  authority: z.strictObject({
    runId: z.string().min(1),
    ownerToken: z.string().min(1),
    leaseId: z.string().min(1),
  }),
  publicationId: z.uuid(),
  attemptId: z.uuid(),
  phase: z.enum(["publish", "inspect"]),
});
type Request = z.infer<typeof PublicationIORequestSchema>;
const entrypoint = fileURLToPath(
  new URL("../../dist/adapters/publication-io-cli.js", import.meta.url),
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

export function assertPublicationWorker(journal: OrchestrationJournal, request: Request) {
  const { record, attempt } = journal.publications.assertIOOwned(
    request.authority,
    request.publicationId,
    request.attemptId,
  );
  if (
    digestJson(journal.storageIdentity()) !== digestJson(request.stateFile) ||
    attempt.phase !== request.phase ||
    !attempt.execution ||
    attempt.execution.launchDigest !== digestJson(launchFor(request))
  )
    throw new Error("Publication worker differs from its exact admitted request");
  return { record, attempt };
}

/** Recover only the original stop or atomically fence an unbound attempt. Never repeat publication. */
export async function reconcilePublicationIO(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  publicationId: string,
  attemptId: string,
) {
  journal.assertAuthority(authority);
  const record = journal.publications.record(authority.runId, publicationId);
  const attempt = record.ioAttempts.at(-1)!;
  if (attempt.attemptId !== attemptId)
    throw new Error("Publication recovery targeted a different attempt");
  if (attempt.execution && !attempt.stop) {
    const stop = await recoverCommandStop(attempt.execution);
    if (!stop)
      throw new NamespaceStopUnprovenError(
        "Independently prove the complete publication worker stopped; preserve every exclusion and owned lock",
      );
    journal.publications.recordIOStop(authority, publicationId, attemptId, stop);
  }
  return journal.publications.settleIO(authority, publicationId, attemptId);
}

export async function runPublicationIO(
  journal: OrchestrationJournal,
  authority: ControllerAuthority,
  publicationId: string,
  attempt: PublicationIOAttempt,
  signal?: AbortSignal,
) {
  const request = PublicationIORequestSchema.parse({
    stateFile: journal.storageIdentity(),
    authority,
    publicationId,
    attemptId: attempt.attemptId,
    phase: attempt.phase,
  });
  const launch = launchFor(request);
  try {
    signal?.throwIfAborted();
    const { record } = journal.publications.assertIOOwned(
      authority,
      publicationId,
      attempt.attemptId,
    );
    const intent = await prepareCommandLifetime(
      {
        runId: authority.runId,
        operationId: attempt.attemptId,
        controllerLeaseId: authority.leaseId,
        scopeDigest: publicationIOScope(record, attempt),
        timeoutMs: 120_000,
      },
      launch,
    );
    journal.publications.bindIO(authority, publicationId, attempt.attemptId, intent);
    assertPublicationWorker(journal, request);
    signal?.throwIfAborted();
    const handle = startDurableCommand(intent, launch),
      interrupt = () => handle.interrupt();
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
          sourceEventId: `publication-worker-${intent.ioId}`,
          kind: "publication.worker_stopped",
          summary: redactSensitiveText(
            `Publication ${attempt.phase} worker stopped: ${receipt.reason ?? receipt.error ?? `exit ${receipt.code}`}. ${diagnostics}`,
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
    journal.publications.noteIOFailure(
      authority,
      publicationId,
      error instanceof Error ? error.message : "Publication worker failed",
    );
  }
  return reconcilePublicationIO(journal, authority, publicationId, attempt.attemptId);
}
