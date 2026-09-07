import type { ActionKernel } from "./actions.js";
import { CapabilityRejected, OperationFailed } from "./guards.js";
import { FixtureAuthorityError } from "../adapters/fixture-journal.js";
import { FixtureTransportError, type FixtureInspector } from "../adapters/fixtures.js";

export function registerFixtureCapabilities(
  kernel: ActionKernel,
  provider: FixtureInspector,
): void {
  const journal = kernel.journal;
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
      return {
        kind: "inspection",
        artifactIds: [],
        text: JSON.stringify({
          fixtureId: definition.id,
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
