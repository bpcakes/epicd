import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { bindFixtureProvider, PostgreSqlFixtureInspector } from "../src/adapters/fixtures.js";
import {
  FixtureDefinitionSchema,
  RepositoryPolicySchema,
} from "../src/domain/repository-policy.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { registerFixtureCapabilities } from "../src/kernel/fixtures.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const bin = process.env.EPICD_TEST_PG_BINDIR;
// Opt-in only. Never connects to a user's PostgreSQL service: creates an owned, Unix-only cluster.
describe.runIf(process.platform === "linux" && Boolean(bin))(
  "real disposable PostgreSQL fixture inspection",
  () => {
    it("uses peer auth and exact CLI grants to inspect absent/present databases without adopting or mutating them", async () => {
      const root = mkdtempSync("/var/tmp/epicd-pg-contract-");
      const data = join(root, "cluster"),
        sockets = join(root, "sockets"),
        executable = join(bin!, "psql");
      mkdirSync(sockets);
      const role = userInfo().username;
      const run = (name: string, args: string[]) =>
        execFileSync(join(bin!, name), args, {
          encoding: "utf8",
          timeout: 15_000,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      const sql = (query: string) =>
        run("psql", [
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
          role,
          "-d",
          "postgres",
          "-c",
          query,
        ]);
      let started = false;
      let store: StateStore | null = null;
      try {
        run("initdb", [
          "-D",
          data,
          "--auth-local=peer",
          "--auth-host=reject",
          "--no-sync",
          "--locale=C.UTF-8",
          "-U",
          role,
        ]);
        // Record startup intent before invoking a service launcher; cleanup must establish stop.
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
        const statePath = join(root, "state.sqlite3");
        store = new StateStore(statePath);
        const state = store.create(
          initialRun(),
          RepositoryPolicySchema.parse({ schemaVersion: 1, fixtures: [definition] }),
        );
        const journal = store.orchestration;
        const grantCli = (version: number) =>
          execFileSync(
            process.execPath,
            [
              "dist/cli.js",
              "grant-fixture",
              state.runId,
              definition.id,
              "--state",
              statePath,
              "--control-version",
              String(version),
              "--operations",
              "inspect",
              "--expires-at",
              new Date(Date.now() + 60_000).toISOString(),
              "--psql-path",
              executable,
            ],
            { encoding: "utf8", timeout: 15_000 },
          );
        expect(grantCli(journal.control(state.runId).controlVersion)).toContain(
          "No database mutation",
        );
        const grant = journal.fixtures.grants(state.runId)[0]!;
        const lease = store.acquireLease(state.runId),
          authority = { runId: state.runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
        const kernel = new ActionKernel(journal),
          provider = new PostgreSqlFixtureInspector();
        registerFixtureCapabilities(kernel, provider);
        const inspect = async () => {
          const ticket = journal.beginDecision(
            authority,
            journal.latestObservationCursor(state.runId),
            journal.control(state.runId).controlVersion,
          );
          const admission = await kernel.execute(
            {
              explanation: "Observe only this declared fixture",
              evidenceIds: [],
              request: {
                schemaVersion: 1,
                decisionId: ticket.decisionId,
                observationCursor: ticket.observationCursor,
                expectedControlVersion: ticket.expectedControlVersion,
                action: { kind: "inspect_fixture", fixtureId: definition.id },
              },
            },
            authority,
          );
          const result =
            admission.status === "running"
              ? await kernel.operation(admission.operationId)!
              : admission;
          if (result.status !== "succeeded" || result.result.kind !== "inspection")
            throw new Error(
              JSON.stringify({ result, observations: journal.observations(state.runId, 0, 100) }),
            );
          return JSON.parse(result.result.text);
        };
        const before = sql("SELECT oid, datname, datdba FROM pg_database ORDER BY oid");
        expect(await inspect()).toMatchObject({
          status: "database_absent",
          ownership: "not_established",
          environmentBindingAvailable: false,
          catalog: { role, roleIsSuperuser: true, database: null },
        });
        expect(sql("SELECT oid, datname, datdba FROM pg_database ORDER BY oid")).toBe(before);
        // Test setup owns this database; its creation is not attributed to the inspected capability.
        sql('CREATE DATABASE "browser_fixture"');
        sql("COMMENT ON DATABASE browser_fixture IS 'test-owned marker: preserve'");
        const existing = sql(
          "SELECT oid, datname, datdba, shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'browser_fixture'",
        );
        expect(await inspect()).toMatchObject({
          status: "present",
          expectedOwnerMatches: true,
          ownership: "not_established",
          environmentBindingAvailable: false,
        });
        expect(
          sql(
            "SELECT oid, datname, datdba, shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'browser_fixture'",
          ),
        ).toBe(existing);
        const unusual = { ...definition, database: "x'; DROP DATABASE browser_fixture; --" };
        expect(
          (
            await provider.inspect(
              unusual,
              await bindFixtureProvider(unusual, executable),
              () => {},
              new AbortController().signal,
            )
          )?.database,
        ).toBeNull();
        expect(
          sql(
            "SELECT oid, datname, datdba, shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'browser_fixture'",
          ),
        ).toBe(existing);
        const wrapper = join(root, "psql-wrapper");
        const wrongRole = { ...definition, role: "epicd_unrelated_role" };
        await expect(
          provider.inspect(
            wrongRole,
            await bindFixtureProvider(wrongRole, executable),
            () => {},
            new AbortController().signal,
          ),
        ).rejects.toThrow("catalog query failed");
        writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        await expect(bindFixtureProvider(definition, wrapper)).rejects.toThrow("native ELF");
        execFileSync(
          process.execPath,
          [
            "dist/cli.js",
            "revoke-fixture-grant",
            state.runId,
            grant.grantId,
            "--state",
            statePath,
            "--control-version",
            String(journal.control(state.runId).controlVersion),
          ],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(journal.fixtures.grants(state.runId)[0]?.revokedAt).not.toBeNull();
        expect(
          sql(
            "SELECT oid, datname, datdba, shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'browser_fixture'",
          ),
        ).toBe(existing);
      } finally {
        store?.close();
        if (started) {
          try {
            run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
          } catch (error) {
            throw new Error(`Preserved owned PostgreSQL cluster with uncertain stop at ${root}`, {
              cause: error,
            });
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
