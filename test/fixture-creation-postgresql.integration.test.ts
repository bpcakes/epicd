import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { bindFixtureProvider, PostgreSqlFixtureInspector } from "../src/adapters/fixtures.js";
import {
  PostgreSqlFixtureCreator,
  fixtureCreationScript,
} from "../src/adapters/fixture-creation.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { registerFixtureCapabilities } from "../src/kernel/fixtures.js";
import {
  FixtureDefinitionSchema,
  RepositoryPolicySchema,
} from "../src/domain/repository-policy.js";
import type { KernelAction } from "../src/domain/orchestration.js";
import { FixtureBackendSchema } from "../src/domain/fixtures.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const bin = process.env.EPICD_TEST_PG_BINDIR;
async function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-pg-create-");
  const data = join(root, "cluster"),
    sockets = join(root, "sockets");
  mkdirSync(sockets);
  const role = userInfo().username;
  const admin = role === "epicd_test_bootstrap" ? "epicd_test_bootstrap2" : "epicd_test_bootstrap";
  const run = (name: string, args: string[], input?: string) =>
    execFileSync(join(bin!, name), args, {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
      ...(input === undefined ? {} : { input }),
    }).trim();
  const sqlArgs = [
    "-X",
    "-w",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    sockets,
    "-p",
    "55432",
    "-U",
    admin,
    "-d",
    "postgres",
  ];
  const sql = (query: string) => run("psql", [...sqlArgs, "-c", query]);
  let started = false,
    store: StateStore | null = null;
  const cleanup = () => {
    store?.close();
    if (started) {
      try {
        run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
      } catch (error) {
        throw new Error(`Preserved uncertain test-owned PostgreSQL service at ${root}`, {
          cause: error,
        });
      }
    }
    rmSync(root, { recursive: true, force: true });
  };
  try {
    run("initdb", [
      "-D",
      data,
      "--auth-local=peer",
      "--auth-host=reject",
      "--no-sync",
      "--locale=C.UTF-8",
      "-U",
      admin,
    ]);
    // Test-owned cluster only: keep a separate bootstrap administrator, and use
    // peer authentication for the non-superuser role exercised by the provider.
    writeFileSync(join(data, "pg_hba.conf"), `local all ${admin} trust\nlocal all all peer\n`);
    started = true;
    run("pg_ctl", [
      "-D",
      data,
      "-l",
      join(root, "server.log"),
      "-w",
      "start",
      "-o",
      `-k ${sockets} -p 55432 -c listen_addresses='' -c fsync=off`,
    ]);
    sql(`CREATE ROLE "${role.replaceAll('"', '""')}" LOGIN NOSUPERUSER CREATEDB`);
    const definition = FixtureDefinitionSchema.parse({
      id: "browser-db",
      provider: "postgresql",
      socketDirectory: sockets,
      port: 55432,
      role,
      database: "browser_fixture",
      expectedOwner: role,
      operations: ["create"],
      environmentBinding: "browser",
      cleanup: "retain",
    });
    const path = join(root, "state.sqlite3");
    store = new StateStore(path);
    const state = store.create(
      initialRun(),
      RepositoryPolicySchema.parse({ schemaVersion: 1, fixtures: [definition] }),
    );
    const journal = store.orchestration;
    journal.fixtures.grant(state.runId, journal.control(state.runId).controlVersion, {
      fixtureId: definition.id,
      binding: await bindFixtureProvider(definition, join(bin!, "psql")),
      operations: ["create", "inspect"],
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const lease = store.acquireLease(state.runId),
      authority = { runId: state.runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
    const creator = new PostgreSqlFixtureCreator(),
      kernel = new ActionKernel(journal);
    registerFixtureCapabilities(kernel, new PostgreSqlFixtureInspector(), creator);
    const request = (action: KernelAction) => {
      const ticket = journal.beginDecision(
        authority,
        journal.latestObservationCursor(state.runId),
        journal.control(state.runId).controlVersion,
      );
      return {
        explanation: "Create only the authorized disposable fixture",
        evidenceIds: [],
        request: {
          schemaVersion: 1 as const,
          decisionId: ticket.decisionId,
          observationCursor: ticket.observationCursor,
          expectedControlVersion: ticket.expectedControlVersion,
          action,
        },
      };
    };
    const dispatch = async (input: ReturnType<typeof request>) => {
      const result = await kernel.execute(input, authority);
      return result.status === "running" ? await kernel.operation(result.operationId)! : result;
    };
    return {
      root,
      path,
      store,
      state,
      journal,
      authority,
      definition,
      creator,
      kernel,
      request,
      dispatch,
      sql,
      run,
      sqlArgs,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

describe.runIf(process.platform === "linux" && Boolean(bin))(
  "real PostgreSQL fixture creation",
  () => {
    it("creates with a non-superuser CREATEDB role, pins OID/marker, and never repeats a replayed action", async () => {
      const f = await fixture();
      try {
        expect(
          f.sql(
            `SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname = '${f.definition.role.replaceAll("'", "''")}'`,
          ),
        ).toBe("f|t");
        const before = f.sql("SELECT oid, datname, datdba FROM pg_database ORDER BY oid");
        const request = f.request({
          kind: "provision_declared_fixture",
          fixtureId: f.definition.id,
          operation: "create",
          expectedGeneration: 0,
        });
        const result = await f.dispatch(request);
        if (result.status !== "succeeded")
          throw new Error(
            JSON.stringify({
              result,
              creations: f.journal.fixtures.creations(f.state.runId),
              observations: f.journal.observations(f.state.runId, 0, 100),
            }),
          );
        const created = f.journal.fixtures.creations(f.state.runId)[0]!;
        expect(created).toMatchObject({
          status: "owned",
          generation: 1,
          backend: { pid: expect.any(Number), startedAt: expect.any(String) },
          clientStopEvidence: expect.any(String),
          observation: {
            backendStopped: true,
            database: { markerMatches: true, allowConnections: true },
          },
        });
        const actual = JSON.parse(
          f.sql(
            "SELECT json_build_object('oid', d.oid::text, 'name', datname, 'owner', r.rolname, 'marker', shobj_description(d.oid, 'pg_database')) FROM pg_database d JOIN pg_roles r ON r.oid = datdba WHERE datname = 'browser_fixture'",
          ),
        );
        expect(actual).toEqual({
          oid: String(created.plannedOid),
          name: f.definition.database,
          owner: f.definition.expectedOwner,
          marker: created.marker,
        });
        expect(
          f.sql(
            "SELECT oid, datname, datdba FROM pg_database WHERE datname != 'browser_fixture' ORDER BY oid",
          ),
        ).toBe(before);
        expect(f.sql("SELECT datname FROM pg_database WHERE datname LIKE 'epicd_lock_%'")).toBe("");
        expect(await f.dispatch(request)).toEqual(result);
        expect(f.journal.fixtures.creations(f.state.runId)).toHaveLength(1);
        expect(
          (
            await f.dispatch(
              f.request({
                kind: "provision_declared_fixture",
                fixtureId: f.definition.id,
                operation: "create",
                expectedGeneration: 1,
              }),
            )
          ).status,
        ).toBe("rejected");
        expect(
          (
            await f.dispatch(
              f.request({ kind: "reconcile_fixture_creation", creationId: created.creationId }),
            )
          ).status,
        ).toBe("succeeded");
      } finally {
        f.cleanup();
      }
    }, 60_000);

    it("preserves an existing database and its comment without dispatching CREATE", async () => {
      const f = await fixture();
      try {
        f.sql("CREATE DATABASE browser_fixture");
        f.sql("COMMENT ON DATABASE browser_fixture IS 'user-owned: preserve'");
        const before = f.sql(
          "SELECT oid, datdba, shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'browser_fixture'",
        );
        expect(
          (
            await f.dispatch(
              f.request({
                kind: "provision_declared_fixture",
                fixtureId: f.definition.id,
                operation: "create",
                expectedGeneration: 0,
              }),
            )
          ).status,
        ).toBe("failed");
        expect(f.journal.fixtures.creations(f.state.runId)[0]).toMatchObject({
          status: "not_created",
          backend: null,
        });
        expect(
          f.sql(
            "SELECT oid, datdba, shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'browser_fixture'",
          ),
        ).toBe(before);
      } finally {
        f.cleanup();
      }
    }, 60_000);

    it("rolls back ownership marking if a simulated concurrent user replaces the created object", async () => {
      const f = await fixture();
      try {
        const request = f.request({
          kind: "provision_declared_fixture",
          fixtureId: f.definition.id,
          operation: "create",
          expectedGeneration: 0,
        });
        // Reserve through normal admission, but simulate the external post-CREATE crash state.
        const temporary = new ActionKernel(f.journal);
        temporary.registerExternal("provision_declared_fixture", async ({ authority, record }) => {
          f.journal.fixtures.reserveCreation(authority, record.actionId);
          throw new Error("Simulated unused admission");
        });
        const admitted = await temporary.execute(request, f.authority);
        if (admitted.status === "running") await temporary.operation(admitted.operationId);
        const intent = f.journal.fixtures.creations(f.state.runId)[0]!;
        f.sql("CREATE DATABASE browser_fixture");
        f.sql("COMMENT ON DATABASE browser_fixture IS 'replacement comment: preserve'");
        const before = f.sql(
          "SELECT oid, datname, datdba, shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'browser_fixture'",
        );
        const markerTransaction = fixtureCreationScript(f.definition, intent)
          .split("\n")
          .slice(1)
          .join("\n");
        expect(() => f.run("psql", [...f.sqlArgs, "--file", "-"], markerTransaction)).toThrow();
        expect(
          f.sql(
            "SELECT oid, datname, datdba, shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'browser_fixture'",
          ),
        ).toBe(before);
        expect(f.sql("SELECT datname FROM pg_database WHERE datname LIKE 'epicd_lock_%'")).toBe("");
      } finally {
        f.cleanup();
      }
    }, 60_000);

    it("observes a live backend and preserves a database left between CREATE and ownership marking", async () => {
      const f = await fixture();
      try {
        const interrupted = new ActionKernel(f.journal);
        registerFixtureCapabilities(interrupted, new PostgreSqlFixtureInspector(), {
          observe: f.creator.observe.bind(f.creator),
          async create(definition, intent, dispatch, guard, signal) {
            // Fault injection on this test-owned server only: run exactly the
            // first CREATE statement, then close before the marking transaction.
            const args = f.sqlArgs.map((arg, index) =>
              f.sqlArgs[index - 1] === "-U" ? definition.role : arg,
            );
            const child = spawn(join(bin!, "psql"), [...args, "--file", "-"], {
              stdio: ["pipe", "pipe", "pipe"],
              env: { PATH: "/usr/bin:/bin" },
            });
            const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
            let errors = "";
            child.stderr.on("data", (chunk: Buffer) => {
              errors += chunk.toString();
            });
            try {
              const ready = new Promise<string>((resolve, reject) => {
                let output = "";
                const timeout = setTimeout(
                  () => reject(new Error("Test backend did not identify itself")),
                  5000,
                );
                const finish = () => clearTimeout(timeout);
                child.once("close", () => {
                  finish();
                  reject(new Error(`Backend closed: ${errors}`));
                });
                child.once("error", (error) => {
                  finish();
                  reject(error);
                });
                child.stdout.on("data", (chunk: Buffer) => {
                  output += chunk.toString();
                  if (output.includes("\n")) {
                    finish();
                    resolve(output.slice(0, output.indexOf("\n")));
                  }
                });
              });
              child.stdin.write(
                "SELECT json_build_object('pid', pg_backend_pid(), 'startedAt', (SELECT EXTRACT(EPOCH FROM backend_start)::text FROM pg_stat_activity WHERE pid = pg_backend_pid()));\n",
              );
              guard();
              dispatch(FixtureBackendSchema.parse(JSON.parse(await ready)));
              const current = f.journal.fixtures.creation(f.state.runId, intent.creationId);
              expect(
                await f.creator.observe(definition, current, intent.binding, guard, signal),
              ).toEqual({ backendStopped: false, database: null });
              child.stdin.end(fixtureCreationScript(definition, intent).split("\n")[0] + "\n");
              expect(await closed, errors).toBe(0);
            } finally {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
              await closed;
            }
          },
        });
        const request = f.request({
          kind: "provision_declared_fixture",
          fixtureId: f.definition.id,
          operation: "create",
          expectedGeneration: 0,
        });
        const pending = await interrupted.execute(request, f.authority);
        const result =
          pending.status === "running" ? await interrupted.operation(pending.operationId) : pending;
        expect(result?.status).toBe("indeterminate");
        const creation = f.journal.fixtures.creations(f.state.runId)[0]!;
        expect(creation).toMatchObject({
          status: "uncertain",
          observation: {
            backendStopped: true,
            database: {
              oid: String(creation.plannedOid),
              markerMatches: false,
              allowConnections: false,
            },
          },
        });
        const before = f.sql(
          "SELECT oid, datname, datdba, datallowconn, shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'browser_fixture'",
        );
        const reconciled = await f.dispatch(
          f.request({ kind: "reconcile_fixture_creation", creationId: creation.creationId }),
        );
        expect(reconciled.status).toBe("succeeded");
        expect(f.journal.fixtures.creation(f.state.runId, creation.creationId).status).toBe(
          "uncertain",
        );
        expect(
          f.sql(
            "SELECT oid, datname, datdba, datallowconn, shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'browser_fixture'",
          ),
        ).toBe(before);
        expect(f.journal.fixtures.creations(f.state.runId)).toHaveLength(1);
      } finally {
        f.cleanup();
      }
    }, 60_000);
  },
);
