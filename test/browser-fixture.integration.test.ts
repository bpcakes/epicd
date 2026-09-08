import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBrowserBundle, browserProject } from "./fixtures/browser-incident.js";
import { startFixturePostgreSql } from "./fixtures/postgresql-fixture.js";
import { fixture, success, target } from "./fixtures/review.js";
import { FixtureDefinitionSchema, RequiredCheckSchema } from "../src/domain/repository-policy.js";
import {
  bindFixtureExecutable,
  bindFixtureProvider,
  PostgreSqlFixtureInspector,
} from "../src/adapters/fixtures.js";
import { PostgreSqlFixtureCreator } from "../src/adapters/fixture-creation.js";
import { registerFixtureCapabilities } from "../src/kernel/fixtures.js";

const bin = process.env.EPICD_TEST_PG_BINDIR,
  broker = process.env.EPICD_TEST_PGBOUNCER,
  toolchain = process.env.EPICD_TEST_PLAYWRIGHT_ROOT,
  browser = process.env.EPICD_TEST_BROWSER_DIRECTORY;
describe.runIf(process.platform === "linux" && Boolean(bin && broker && toolchain && browser))(
  "real browser fixture through confined validation",
  () => {
    it("fails real sign-in without a database URL, then passes through the owned fixture and preserves its oracle", async () => {
      const bundle = buildBrowserBundle(toolchain!, browser!),
        pg = startFixturePostgreSql(bin!);
      try {
        const definition = FixtureDefinitionSchema.parse({
          id: "browser-db",
          provider: "postgresql",
          socketDirectory: pg.sockets,
          port: 55432,
          role: pg.manager,
          database: "browser_fixture",
          expectedOwner: pg.role,
          operations: ["create"],
          environmentBinding: "browser",
          cleanup: "retain",
        });
        const validation = {
          fixtureId: definition.id,
          validationRole: pg.role,
          listenPort: 55433,
          connectionVariable: "DATABASE_URL",
          pgbouncerExecutable: broker!,
        };
        const check = RequiredCheckSchema.parse({
          id: "browser-login",
          command: "/bin/sh",
          args: ["tools/browser-check.sh"],
          timeoutMs: 30000,
          environmentBindings: ["browser"],
        });
        const s = await fixture(
          check,
          "sha1",
          undefined,
          (source) => {
            writeFileSync(join(source, "source.txt"), "green\n");
            browserProject(source, bundle, join(bin!, "psql"));
          },
          { fixtures: [definition], fixtureValidation: [validation] },
        );
        registerFixtureCapabilities(
          s.kernel,
          new PostgreSqlFixtureInspector(),
          new PostgreSqlFixtureCreator(),
        );
        expect(pg.sql("SELECT count(*) FROM pg_database WHERE datname='browser_fixture'")).toBe(
          "0",
        );
        const plan = await s.define(),
          candidate = await s.capture(plan),
          copy = await s.copy(candidate);
        const { stage: _stage, ...diagnosticCheck } = check;
        const diagnostic = success(
          await s.dispatch({
            kind: "run_diagnostic_check",
            ...candidate,
            ...target(copy),
            validationPlanId: plan,
            check: { ...diagnosticCheck, environmentBindings: [] },
          }),
        );
        if (diagnostic.kind !== "validation") throw new Error("Expected diagnostic command result");
        expect(diagnostic.satisfiesCheck).toBe(false);
        const observed = s.journal.delivery.evidence(s.authority.runId, diagnostic.evidenceId);
        expect(observed).toMatchObject({
          purpose: "diagnostic",
          sourceUnchanged: true,
          environmentVerified: true,
          fixtureAccessIds: [],
        });
        expect(
          s.journal.delivery.preCommitEvidence(s.authority.runId, candidate).missingCheckIds,
        ).toContain(check.id);
        const failure = observed.outcome!;
        expect(failure.status, failure.stderr).toBe("failed");
        expect(failure.stdout).toContain("1 failed");
        expect(failure.stderr).toContain("Browser fixture authentication failed");
        expect(failure.stderr).toContain("database URL is unavailable");
        const binding = await bindFixtureProvider(definition, join(bin!, "psql"));
        s.journal.fixtures.grant(
          s.authority.runId,
          s.journal.control(s.authority.runId).controlVersion,
          {
            fixtureId: definition.id,
            binding,
            operations: ["inspect", "create"],
            expiresAt: new Date(Date.now() + 120000).toISOString(),
          },
        );
        s.journal.fixtures.validation.grant(
          s.authority.runId,
          s.journal.control(s.authority.runId).controlVersion,
          {
            fixtureId: definition.id,
            binding,
            pgbouncer: await bindFixtureExecutable(broker!),
            expiresAt: new Date(Date.now() + 120000).toISOString(),
          },
        );
        success(
          await s.dispatch({
            kind: "provision_declared_fixture",
            fixtureId: definition.id,
            operation: "create",
            expectedGeneration: 0,
          }),
        );
        const payload = success(
          await s.dispatch({
            kind: "run_validation",
            ...candidate,
            ...target(copy),
            validationPlanId: plan,
            checkId: check.id,
          }),
        );
        if (payload.kind !== "validation") throw new Error("Expected validation result");
        const evidence = s.journal.delivery.evidence(s.authority.runId, payload.evidenceId);
        expect(payload, JSON.stringify(evidence.outcome)).toMatchObject({
          outcome: "succeeded",
          satisfiesCheck: true,
        });
        expect(evidence).toMatchObject({ sourceUnchanged: true, environmentVerified: true });
        expect(evidence.outcome?.stdout).toContain("1 passed");
        expect(pg.sql("SELECT username FROM e2e_users", "browser_fixture")).toBe("fixture-user");
      } finally {
        pg.cleanup();
      }
    }, 180000);
  },
);
