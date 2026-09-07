import { randomUUID } from "node:crypto";
import type { ActionKernel } from "./actions.js";
import { CapabilityRejected, OperationFailed } from "./guards.js";
import { FixtureAuthorityError } from "../adapters/fixture-journal.js";
import { FixtureTransportError, type FixtureInspector } from "../adapters/fixtures.js";
import type { FixtureCreationProvider } from "../adapters/fixture-creation.js";
import type { OrchestrationJournal } from "../adapters/orchestration-journal.js";
import type { ControllerAuthority } from "../domain/orchestration.js";
import type { FixtureCreation } from "../domain/fixtures.js";

export function registerFixtureCapabilities(
  kernel: ActionKernel,
  provider: FixtureInspector,
  creator?: FixtureCreationProvider,
): void {
  const journal = kernel.journal;
  if (creator) {
    kernel.registerExternal(
      "provision_declared_fixture",
      async ({ authority, record, signal }, action) => {
        if (action.operation !== "create")
          throw new CapabilityRejected(
            "fixture_operation_unavailable",
            "Reset and cleanup require additional ownership/lifecycle safeguards and are not implemented",
          );
        let intent: FixtureCreation;
        try {
          intent = journal.fixtures.reserveCreation(authority, record.actionId);
        } catch (error) {
          if (error instanceof FixtureAuthorityError)
            throw new CapabilityRejected(error.code, error.message);
          throw error;
        }
        const guard = () => {
          journal.assertAuthority(authority);
          journal.fixtures.authorize(authority.runId, intent.fixtureId, "create", intent.grantId);
          const current = journal.fixtures.creation(authority.runId, intent.creationId);
          if (
            current.controllerLeaseId !== authority.leaseId ||
            !["reserved", "dispatching"].includes(current.status)
          )
            throw new FixtureAuthorityError(
              "fixture_dispatch_closed",
              "Creation dispatch gate has been closed or fenced",
            );
        };
        let failure: unknown;
        try {
          await creator.create(
            journal.fixtures.definition(authority.runId, intent.fixtureId),
            intent,
            (backend) => {
              journal.fixtures.dispatchCreation(authority, intent.creationId, backend);
            },
            guard,
            signal,
          );
        } catch (error) {
          failure = error;
        }
        journal.assertAuthority(authority);
        const current = journal.fixtures.creation(authority.runId, intent.creationId);
        if (!current.backend) {
          const stopped = journal.fixtures.noDispatch(
            authority,
            intent.creationId,
            failure instanceof Error ? failure.message : "No CREATE was dispatched",
          );
          throw new OperationFailed(stopped.detail!);
        }
        journal.fixtures.clientStopped(authority, intent.creationId);
        // Client exit is not PostgreSQL stop proof. A separate read checks the exact
        // bound backend and marker. Revocation/pause prevents new provider access.
        const readGuard = () => {
          journal.assertAuthority(authority);
          journal.fixtures.authorize(authority.runId, intent.fixtureId, "create", intent.grantId);
        };
        readGuard();
        const observed = await creator.observe(
          journal.fixtures.definition(authority.runId, intent.fixtureId),
          current,
          intent.binding,
          readGuard,
          signal,
        );
        readGuard();
        const settled = journal.fixtures.observeCreation(authority, intent.creationId, observed);
        if (settled.status === "not_created") throw new OperationFailed(settled.detail!);
        if (settled.status !== "owned")
          throw new Error(
            settled.detail ?? "Fixture creation remains uncertain; reconcile without replay",
          );
        return { kind: "resource", resourceId: settled.creationId, generation: settled.generation };
      },
    );
    kernel.registerExternal("reconcile_fixture_creation", async ({ authority, signal }, action) => {
      try {
        const creation = journal.fixtures.creation(authority.runId, action.creationId);
        const parent = journal.actionForOperation(authority.runId, creation.operationId);
        if (!parent || parent.status === "running")
          throw new CapabilityRejected(
            "fixture_creation_running",
            "Do not reconcile a creation whose provider call is still running",
          );
        const settled = await reconcileFixtureCreation(
          journal,
          creator,
          authority,
          action.creationId,
          signal,
        );
        if (parent.status === "indeterminate" && settled.status === "owned")
          journal.settleAction(authority, parent.actionId, "indeterminate", {
            status: "succeeded",
            actionId: parent.actionId,
            result: {
              kind: "resource",
              resourceId: settled.creationId,
              generation: settled.generation,
            },
          });
        if (parent.status === "indeterminate" && settled.status === "not_created") {
          const problemId = randomUUID();
          journal.appendObservation(authority, {
            source: "fixture-kernel",
            sourceEventId: problemId,
            kind: "fixture.creation_not_created",
            summary: settled.detail ?? "No fixture was created",
            identity: null,
            artifactIds: [],
            wakesOrchestrator: true,
          });
          journal.settleAction(authority, parent.actionId, "indeterminate", {
            status: "failed",
            actionId: parent.actionId,
            problemId,
          });
        }
        return {
          kind: "inspection",
          artifactIds: [],
          text: JSON.stringify({
            creationId: settled.creationId,
            generation: settled.generation,
            status: settled.status,
            detail: settled.detail,
            environmentBindingAvailable: false,
          }),
        };
      } catch (error) {
        if (error instanceof FixtureAuthorityError)
          throw new CapabilityRejected(error.code, error.message);
        if (error instanceof FixtureTransportError) throw new OperationFailed(error.message);
        throw error;
      }
    });
  }
  kernel.registerExternal("inspect_fixture", async ({ authority, signal }, action) => {
    try {
      const grant = journal.fixtures.authorize(authority.runId, action.fixtureId, "inspect");
      const definition = journal.fixtures.definition(authority.runId, action.fixtureId);
      const guard = () => {
        journal.assertAuthority(authority);
        journal.fixtures.authorize(authority.runId, action.fixtureId, "inspect", grant.grantId);
      };
      const catalog = await provider.inspect(definition, grant.binding, guard, signal);
      guard();
      const creation = journal.fixtures
        .creations(authority.runId)
        .findLast((item) => item.fixtureId === definition.id);
      return {
        kind: "inspection",
        artifactIds: [],
        text: JSON.stringify({
          fixtureId: definition.id,
          generation: creation?.generation ?? 0,
          creation: creation
            ? { creationId: creation.creationId, recordedStatus: creation.status }
            : null,
          grantId: grant.grantId,
          observedAt: new Date().toISOString(),
          status: !catalog ? "socket_missing" : catalog.database ? "present" : "database_absent",
          catalog,
          expectedOwner: definition.expectedOwner,
          expectedOwnerMatches: catalog?.database
            ? catalog.database.owner === definition.expectedOwner
            : null,
          ownership: "not_established",
          environmentBindingAvailable: false,
          limitation:
            "Catalog-only observation, not fixture connectivity, run ownership, provisioning authority, or repository validation access. Peer authentication is not inferred from connection success.",
        }),
      };
    } catch (error) {
      if (error instanceof FixtureAuthorityError)
        throw new CapabilityRejected(error.code, error.message);
      if (error instanceof FixtureTransportError) throw new OperationFailed(error.message);
      throw error;
    }
  });
}

/** Never reissues CREATE, COMMENT or ALTER. Unknown/unmarked resources remain preserved. */
export async function reconcileFixtureCreation(
  journal: OrchestrationJournal,
  creator: FixtureCreationProvider,
  authority: ControllerAuthority,
  creationId: string,
  signal: AbortSignal,
): Promise<FixtureCreation> {
  journal.assertAuthority(authority);
  const record = journal.fixtures.creation(authority.runId, creationId);
  if (record.status === "not_created") return record;
  if (record.status === "reserved")
    return journal.fixtures.noDispatch(
      authority,
      creationId,
      "Unused creation dispatch gate closed during reconciliation; no mutation was authorized",
    );
  const grant = journal.fixtures.authorize(authority.runId, record.fixtureId, "inspect");
  const guard = () => {
    journal.assertAuthority(authority);
    journal.fixtures.authorize(authority.runId, record.fixtureId, "inspect", grant.grantId);
  };
  const observed = await creator.observe(
    journal.fixtures.definition(authority.runId, record.fixtureId),
    record,
    grant.binding,
    guard,
    signal,
  );
  guard();
  return journal.fixtures.observeCreation(authority, creationId, observed);
}
