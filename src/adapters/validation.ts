import type { ControllerAuthority } from "../domain/orchestration.js";
import type { ValidationEvidence } from "../domain/delivery.js";
import { startConfinedCommand, type ConfinedCommandHandle } from "./sandbox.js";
import type { WorkspaceManager } from "./workspaces.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { redactSensitiveText } from "../util/redact.js";

/** Executes a persisted check. There is no shell on the host, synthetic pass, or agent-report input. */
export async function runCandidateValidation(
  journal: OrchestrationJournal,
  workspaces: WorkspaceManager,
  authority: ControllerAuthority,
  evidence: ValidationEvidence,
  signal: AbortSignal,
): Promise<ValidationEvidence> {
  const candidate = journal.delivery.candidate(authority.runId, evidence);
  const plan = journal.delivery.plan(authority.runId, evidence.validationPlanId);
  const check = plan.checks.find((item) => item.id === evidence.checkId)!;
  const writablePaths = journal.policy(authority.runId).writableScratch;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const assertDispatch = () => {
    journal.assertAuthority(authority);
    const control = journal.control(authority.runId);
    if (control.status !== "active" || control.policyDigest !== evidence.policyDigest)
      throw new Error("Validation admission changed before execution");
    const current = journal.delivery.evidence(authority.runId, evidence.evidenceId);
    if (
      current.status !== "running" ||
      current.controllerLeaseId !== authority.leaseId ||
      journal.actionForOperation(authority.runId, evidence.operationId)?.status !== "running"
    )
      throw new Error("Validation intent is no longer dispatchable");
    controller.signal.throwIfAborted();
  };
  const health = setInterval(() => {
    try {
      assertDispatch();
    } catch (error) {
      controller.abort(error);
    }
  }, 250);
  let handle: ConfinedCommandHandle | null = null;
  let outcomeObserved = false;
  try {
    const snapshot = journal.delivery.snapshotAtRevision(
      authority.runId,
      candidate,
      evidence.phase === "pre_commit" ? null : evidence.revision,
    );
    const workspace = await workspaces.verifyValidationWorkspace(
      authority,
      evidence,
      snapshot,
      evidence.workspaceOperationId,
      writablePaths,
      true,
      controller.signal,
    );
    assertDispatch();
    handle = await startConfinedCommand(
      {
        workspace: workspace.path,
        sourceMode: "read-only",
        writablePaths,
        immutablePaths: snapshot.manifest.map((entry) => entry.path),
        command: check.command,
        args: check.args,
        cwd: check.cwd,
        timeoutMs: check.timeoutMs,
      },
      { signal: controller.signal, beforeSpawn: assertDispatch },
    );
    const result = await handle.result;
    outcomeObserved = true;
    let sourceUnchanged = false;
    try {
      // After a cancelled process, still inspect the stopped copy without the cancelled signal.
      await workspaces.verifyValidationWorkspace(
        authority,
        evidence,
        snapshot,
        evidence.workspaceOperationId,
        writablePaths,
        false,
      );
      sourceUnchanged = true;
    } catch (error) {
      journal.assertAuthority(authority);
      journal.appendObservation(authority, {
        source: "validation",
        sourceEventId: `source-${evidence.evidenceId}`,
        kind: "validation.source_invalid",
        summary: redactSensitiveText(
          error instanceof Error ? error.message : "Source inspection failed",
          7999,
        ),
        artifactIds: [],
        identity: null,
        wakesOrchestrator: true,
      });
    }
    return journal.delivery.finishValidation(
      authority,
      evidence.evidenceId,
      result,
      sourceUnchanged,
    );
  } catch (error) {
    // A returned handle remains owned until its result proves process closure, including startup errors.
    if (handle) {
      handle.interrupt();
      await handle.result.catch(() => undefined);
    }
    journal.assertAuthority(authority); // A replaced lease cannot turn late results into evidence.
    if (outcomeObserved) throw error; // Do not replace an observed result with an invented startup failure.
    const at = new Date().toISOString();
    return journal.delivery.finishValidation(
      authority,
      evidence.evidenceId,
      {
        status: controller.signal.aborted ? "cancelled" : "not_started",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: redactSensitiveText(
          error instanceof Error ? error.message : "Validation could not execute",
          65535,
        ),
        outputTruncated: false,
        startedAt: evidence.createdAt,
        endedAt: at,
        processTreeStopped: true,
      },
      false,
    );
  } finally {
    clearInterval(health);
    signal.removeEventListener("abort", abort);
  }
}
