import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { afterEach } from "vitest";
import { StateStore } from "../../src/adapters/store.js";
import { RepositoryPolicySchema } from "../../src/domain/repository-policy.js";
import { RunOperator } from "../../src/operator-controls.js";
import { initialRun } from "./orchestration/state.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Real SQLite and Unix socket metadata. The socket is not PostgreSQL and must never be queried. */
export async function operatorFixture(count = 1) {
  const root = mkdtempSync("/var/tmp/epicd-operator-");
  const executable = realpathSync("/usr/bin/true"); // Real ELF identity, never executed as a provider.
  let connections = 0;
  const socket = createServer((connection) => {
    connections++;
    connection.destroy();
  });
  socket.listen(join(root, ".s.PGSQL.5432"));
  await once(socket, "listening");
  const path = join(root, "state.sqlite3"),
    store = new StateStore(path);
  const state = store.create(
    initialRun(),
    RepositoryPolicySchema.parse({
      schemaVersion: 1,
      fixtures: Array.from({ length: count }, (_, index) => ({
        id: index ? `fixture-${index}` : "browser-db",
        provider: "postgresql",
        socketDirectory: root,
        port: 5432 + index,
        role: "fixture_manager",
        database: `disposable_browser_${index}`,
        expectedOwner: "fixture_app",
        operations: ["create"],
        environmentBinding: `browser-${index}`,
        cleanup: "retain",
      })),
      fixtureValidation: [
        {
          fixtureId: "browser-db",
          validationRole: "fixture_app",
          listenPort: 56432,
          connectionVariable: "DATABASE_URL",
          pgbouncerExecutable: executable,
        },
      ],
    }),
  );
  const operator = new RunOperator(store, state.runId);
  cleanup.push(async () => {
    await operator.settle();
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const question = () => {
    const lease = store.acquireLease(state.runId);
    try {
      return store.orchestration.setEscalation(
        { runId: state.runId, ...lease },
        "May I inspect this declared fixture?",
        "authority",
        [],
      );
    } finally {
      store.releaseLease(state.runId, lease.ownerToken);
    }
  };
  return {
    root,
    path,
    store,
    state,
    operator,
    executable,
    question,
    version: () => store.orchestration.control(state.runId).controlVersion,
    expiry: () => new Date(Date.now() + 60_000).toISOString(),
    get connections() {
      return connections;
    },
  };
}
