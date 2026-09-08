import type { ControllerAuthority } from "../domain/orchestration.js";
import type { ValidationEvidence } from "../domain/delivery.js";
import { NamespaceStopUnprovenError } from "./pid-namespace.js";
import { startConfinedCommand, type ConfinedCommandHandle } from "./sandbox.js";
import type { WorkspaceManager } from "./workspaces.js";
import type { OrchestrationJournal } from "./orchestration-journal.js";
import { redactSensitiveText } from "../util/redact.js";
import { PostgreSqlFixtureValidationProvider } from "./fixture-validation-provider.js";
import type { FixtureBridgeTransport } from "./fixture-bridge.js";
import {
  bindValidationService,
  verifyValidationServices,
  withValidationServices,
  type BoundValidationService,
} from "./validation-services.js";

/** Executes a persisted check. There is no shell on the host, synthetic pass, or agent-report input. */
export async function runCandidateValidation(
  journal: OrchestrationJournal,
  workspaces: WorkspaceManager,
  authority: ControllerAuthority,
  evidence: ValidationEvidence,
  signal: AbortSignal,
): Promise<ValidationEvidence> {
  const candidate = journal.delivery.candidate(authority.runId, evidence);
  const check = evidence.check;
  const writablePaths = journal.policy(authority.runId).writableScratch;
  const fixtureJournal = journal.fixtures.validation;
  const fixtureUses = evidence.fixtureAccessIds.map((id) =>
    fixtureJournal.use(authority.runId, id),
  );
  const fixtureProvider = new PostgreSqlFixtureValidationProvider();
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
    for (const use of fixtureUses) fixtureJournal.assertDispatch(authority, use.accessId);
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
  let services: BoundValidationService[] = [];
  let fixtureBridge: FixtureBridgeTransport | undefined;
  const settleFixtures = async () => {
    for (const use of fixtureUses) {
      fixtureJournal.localStopped(authority, use.accessId);
      if (fixtureJournal.use(authority.runId, use.accessId).status !== "dispatched") continue;
      try {
        const observedUse = fixtureJournal.observationUse(authority.runId, use.accessId);
        const observation = await fixtureProvider.observe(
          journal.fixtures.definition(authority.runId, use.fixtureId),
          fixtureJournal.policy(authority.runId, use.fixtureId),
          observedUse,
          () => {
            journal.assertAuthority(authority);
            fixtureJournal.observationUse(authority.runId, use.accessId, observedUse.grantId);
          },
          AbortSignal.timeout(10_000),
        );
        fixtureJournal.observeStopped(authority, use.accessId, observation, observedUse.grantId);
      } catch (error) {
        journal.assertAuthority(authority);
        journal.appendObservation(authority, {
          source: "validation",
          sourceEventId: `fixture-stop-${use.accessId}`,
          kind: "validation.fixture_unsettled",
          summary: redactSensitiveText(
            `Fixture ${use.accessId} needs reconciliation: ${String(error)}`,
            7999,
          ),
          artifactIds: [],
          identity: null,
          wakesOrchestrator: true,
        });
      }
    }
  };
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
    for (const use of fixtureUses) {
      const definition = journal.fixtures.definition(authority.runId, use.fixtureId),
        policy = fixtureJournal.policy(authority.runId, use.fixtureId);
      const observation = await fixtureProvider.observe(
        definition,
        policy,
        use,
        assertDispatch,
        controller.signal,
      );
      fixtureJournal.admit(authority, use.accessId, observation);
      fixtureBridge = {
        definition,
        binding: use.binding,
        pgbouncer: use.pgbouncer,
        validationRole: policy.validationRole,
        listenPort: policy.listenPort,
        connectionVariable: policy.connectionVariable,
      };
    }
    if (evidence.environmentGenerations.length) {
      const definitions = evidence.environmentGenerations.map((entry) =>
        journal
          .policy(authority.runId)
          .validationServices.find((service) => service.id === entry.bindingId)!,
      );
      const runtimes = await Promise.all(definitions.map(bindValidationService));
      assertDispatch();
      const bound = journal.delivery.bindValidationServices(
        authority,
        evidence.evidenceId,
        runtimes,
      );
      services = bound.environmentGenerations.map((environment, index) => ({
        definition: definitions[index]!,
        environment,
      }));
    }
    handle = await startConfinedCommand(
      withValidationServices(
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
        services,
      ),
      {
        signal: controller.signal,
        ...(fixtureBridge ? { fixtureBridge } : {}),
        beforeSpawn: async () => {
          await verifyValidationServices(services);
          assertDispatch();
          for (const use of fixtureUses) fixtureJournal.dispatch(authority, use.accessId);
        },
      },
    );
    const result = await handle.result;
    outcomeObserved = true;
    clearInterval(health);
    await settleFixtures();
    let sourceUnchanged = false;
    let environmentVerified = services.length === 0;
    if (services.length) {
      try {
        await verifyValidationServices(services);
        environmentVerified = true;
      } catch (error) {
        journal.assertAuthority(authority);
        journal.appendObservation(authority, {
          source: "validation",
          sourceEventId: `environment-${evidence.evidenceId}`,
          kind: "validation.environment_invalid",
          summary: redactSensitiveText(String(error), 7999),
          artifactIds: [],
          identity: null,
          wakesOrchestrator: true,
        });
      }
    }
    environmentVerified =
      environmentVerified &&
      fixtureUses.every((use) => fixtureJournal.eligible(authority.runId, use.accessId));
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
      environmentVerified,
    );
  } catch (error) {
    // A returned handle remains owned until its result proves process closure, including startup errors.
    if (handle) {
      handle.interrupt();
      await handle.result.catch((stopError) => {
        if (stopError instanceof NamespaceStopUnprovenError) throw stopError;
      });
    }
    journal.assertAuthority(authority); // A replaced lease cannot turn late results into evidence.
    if (error instanceof NamespaceStopUnprovenError) throw error;
    if (outcomeObserved) throw error; // Do not replace an observed result with an invented startup failure.
    clearInterval(health);
    await settleFixtures();
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
