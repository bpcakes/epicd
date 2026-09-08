import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  bindFixtureExecutable,
  bindFixtureProvider,
  PostgreSqlFixtureInspector,
} from "../src/adapters/fixtures.js";
import { PostgreSqlFixtureCreator } from "../src/adapters/fixture-creation.js";
import { PostgreSqlFixtureValidationProvider } from "../src/adapters/fixture-validation-provider.js";
import { assertRuntimeHandoffReady } from "../src/adapters/runtime-handoff.js";
import {
  FixtureValidationUseSchema,
  fixtureCommandScope,
} from "../src/domain/fixture-validation.js";
import { registerFixtureCapabilities } from "../src/kernel/fixtures.js";
import { ActionKernel } from "../src/kernel/actions.js";
import {
  FixtureDefinitionSchema,
  RequiredCheckSchema,
  ValidationServiceSchema,
} from "../src/domain/repository-policy.js";
import { fixture, success, target, waitFor } from "./fixtures/review.js";
import { startFixturePostgreSql } from "./fixtures/postgresql-fixture.js";
import type { KernelAction } from "../src/domain/orchestration.js";
import type { OrchestrationJournal } from "../src/adapters/orchestration-journal.js";
import type { ControllerAuthority } from "../src/domain/orchestration.js";
import type { JournalRecordTarget } from "../src/domain/journal-records.js";
import { readCommandStop } from "../src/adapters/command-lifetime.js";
import * as commandLifetime from "../src/adapters/command-lifetime.js";
import { NamespaceStopUnprovenError } from "../src/adapters/pid-namespace.js";
import { startConfinedCommand } from "../src/adapters/sandbox.js";

const bin = process.env.EPICD_TEST_PG_BINDIR;
const broker = process.env.EPICD_TEST_PGBOUNCER;
async function setup(
  options: {
    create?: boolean;
    grant?: boolean;
    query?: string;
    timeoutMs?: number;
    localService?: boolean;
    diagnostic?: boolean;
  } = {},
) {
  const { root, sockets, manager, role, admin, sql, cleanup } = startFixturePostgreSql(bin!);
  try {
    const definition = FixtureDefinitionSchema.parse({
      id: "browser-db",
      provider: "postgresql",
      socketDirectory: sockets,
      port: 55432,
      role: manager,
      database: "browser_fixture",
      expectedOwner: role,
      operations: ["create"],
      environmentBinding: "browser",
      cleanup: "retain",
    });
    const validation = {
      fixtureId: definition.id,
      validationRole: role,
      listenPort: 55433,
      connectionVariable: "DATABASE_URL",
      pgbouncerExecutable: broker!,
    };
    const query =
      options.query ??
      "CREATE TABLE IF NOT EXISTS proof(value text); INSERT INTO proof VALUES ('green'); SELECT value FROM proof LIMIT 1";
    const check = RequiredCheckSchema.parse({
      id: "browser-sql",
      command: "/bin/sh",
      args: [
        "-c",
        `test "$(cat app.txt)" = green && ${
          options.localService
            ? `${bin}/psql -X -w -qAt -v ON_ERROR_STOP=1 "$SCRATCH_DATABASE_URL" -c 'SELECT current_database()' && `
            : ""
        }exec ${bin}/psql -X -w -qAt -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "$1"`,
        "fixture-check",
        query,
      ],
      environmentBindings: options.localService ? ["scratch-db", "browser"] : ["browser"],
      timeoutMs: options.timeoutMs ?? 5000,
    });
    const s = await fixture(check, "sha1", undefined, undefined, {
      fixtures: [definition],
      fixtureValidation: [validation],
      validationServices: options.localService
        ? [
            ValidationServiceSchema.parse({
              id: "scratch-db",
              provider: "postgresql",
              lifetime: "check",
              binDirectory: bin,
              database: "scratch_fixture",
              role: "scratch_owner",
              port: 55434,
              connectionVariable: "SCRATCH_DATABASE_URL",
            }),
          ]
        : [],
    });
    registerFixtureCapabilities(
      s.kernel,
      new PostgreSqlFixtureInspector(),
      new PostgreSqlFixtureCreator(),
    );
    const binding = await bindFixtureProvider(definition, join(bin!, "psql")),
      pgbouncer = await bindFixtureExecutable(broker!);
    const grant = () =>
      s.journal.fixtures.validation.grant(
        s.authority.runId,
        s.journal.control(s.authority.runId).controlVersion,
        {
          fixtureId: definition.id,
          binding,
          pgbouncer,
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        },
      );
    s.journal.fixtures.grant(
      s.authority.runId,
      s.journal.control(s.authority.runId).controlVersion,
      {
        fixtureId: definition.id,
        binding,
        operations: ["create", "inspect"],
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      },
    );
    if (options.grant !== false) grant();
    if (options.create !== false)
      success(
        await s.dispatch({
          kind: "provision_declared_fixture",
          fixtureId: definition.id,
          operation: "create",
          expectedGeneration: 0,
        }),
      );
    const planId = await s.define(),
      candidate = await s.capture(planId),
      copy = await s.copy(candidate);
    const { stage: _stage, ...diagnosticCheck } = check;
    const action: KernelAction = options.diagnostic
      ? {
          kind: "run_diagnostic_check",
          ...candidate,
          ...target(copy),
          validationPlanId: planId,
          check: diagnosticCheck,
        }
      : {
          kind: "run_validation",
          ...candidate,
          ...target(copy),
          validationPlanId: planId,
          checkId: check.id,
        };
    const validate = async () => {
      const result = success(await s.dispatch(action));
      if (result.kind !== "validation") throw new Error("Expected validation payload");
      return {
        result,
        evidence: s.journal.delivery.evidence(s.authority.runId, result.evidenceId),
        use: s.journal.fixtures.validation.uses(s.authority.runId).at(-1)!,
      };
    };
    return {
      s,
      root,
      definition,
      validation,
      binding,
      pgbouncer,
      grant,
      sql,
      role,
      admin,
      manager,
      action,
      validate,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Stop at the real durable reservation boundary; no repository command is launched. */
function reserveOnly(f: Awaited<ReturnType<typeof setup>>) {
  const { journal, authority } = f.s;
  const admitted = journal.acceptAction(authority, f.s.decision(f.action));
  if (admitted.kind !== "accepted") throw new Error("Expected validation admission");
  const parent = journal.startAction(authority, admitted.action.actionId);
  const evidence = journal.delivery.beginValidation(authority, parent.actionId);
  const use = journal.fixtures.validation.use(authority.runId, evidence.fixtureAccessIds[0]!);
  expect(use.status).toBe("reserved");
  return { parent, evidence, use };
}

function accessRecovery(journal: OrchestrationJournal, authority: ControllerAuthority) {
  const kernel = new ActionKernel(journal);
  registerFixtureCapabilities(kernel, new PostgreSqlFixtureInspector());
  const decision = (action: KernelAction) => {
    const ticket = journal.beginDecision(
      authority,
      journal.latestObservationCursor(authority.runId),
      journal.control(authority.runId).controlVersion,
    );
    return {
      explanation: "Inspect the unused SQL gate without replaying validation",
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
  return {
    kernel,
    decision,
    dispatch: async (action: KernelAction) => {
      const result = await kernel.execute(decision(action), authority);
      return result.status === "running" ? await kernel.operation(result.operationId)! : result;
    },
  };
}

describe.runIf(process.platform === "linux" && Boolean(bin) && Boolean(broker))(
  "granted fixture SQL through the real validation kernel",
  () => {
    it("reads original fixture and grant records without running SQL or renewing revoked authority", async () => {
      const f = await setup();
      try {
        const { evidence, use } = await f.validate(),
          { journal, authority } = f.s,
          run = authority.runId;
        const creation = journal.fixtures
          .creations(run)
          .find((item) => item.creationId === use.creationId)!;
        const records: JournalRecordTarget[] = [
          { recordKind: "fixture_creation", recordId: creation.creationId },
          { recordKind: "fixture_access", recordId: use.accessId },
          { recordKind: "fixture_grant", recordId: creation.grantId },
          { recordKind: "fixture_sql_grant", recordId: use.grantId },
        ];
        const originalGrants = journal.fixtures.grants(run),
          originalSqlGrants = journal.fixtures.validation.grants(run),
          originalUses = journal.fixtures.validation.uses(run);
        for (const record of records) {
          let offset: number | null = 0,
            expectedDigest: string | null = null,
            retained = "";
          do {
            const result = success(
              await f.s.dispatch({
                kind: "inspect_record",
                ...record,
                offset,
                limit: 4000,
                expectedDigest,
              }),
            );
            if (result.kind !== "inspection") throw new Error("Expected fixture record inspection");
            const page = JSON.parse(result.text);
            expect(page).toMatchObject({ ...record, settled: true });
            offset = page.nextOffset;
            expectedDigest = page.digest;
            retained += page.content;
          } while (offset !== null);
          const viewed = JSON.parse(retained);
          expect(viewed).toMatchObject({
            ...record,
            record: { runId: run, fixtureId: f.definition.id },
          });
          expect(viewed.record).not.toHaveProperty("controllerLeaseId");
          expect(viewed.record).not.toHaveProperty("ownerToken");
        }
        expect(journal.fixtures.grants(run)).toEqual(originalGrants);
        expect(journal.fixtures.validation.grants(run)).toEqual(originalSqlGrants);
        expect(journal.fixtures.validation.uses(run)).toEqual(originalUses);
        expect(f.sql("SELECT count(*) FROM proof", "browser_fixture")).toBe("1");
        const request = {
          kind: "inspect_record" as const,
          recordKind: "fixture_sql_grant" as const,
          recordId: use.grantId,
          offset: 0,
          limit: 4000,
          expectedDigest: null,
        };
        const oldView = success(await f.s.dispatch(request));
        if (oldView.kind !== "inspection") throw new Error("Expected original grant view");
        journal.fixtures.validation.revoke(run, journal.control(run).controlVersion, use.grantId);
        expect(
          await f.s.dispatch({
            ...request,
            offset: 1,
            expectedDigest: JSON.parse(oldView.text).digest,
          }),
        ).toMatchObject({ status: "rejected", code: "record_view_changed" });
        expect((await f.s.dispatch(request)).status).toBe("succeeded");
        expect(journal.fixtures.validation.grants(run).at(-1)?.revokedAt).not.toBeNull();
        expect(await f.s.dispatch(f.action)).toMatchObject({
          status: "rejected",
          code: "fixture_access_grant_required",
        });
        expect(journal.fixtures.validation.uses(run)).toEqual(originalUses);
        expect(journal.delivery.satisfiesCheck(run, evidence.evidenceId)).toBe(true);
        expect(f.sql("SELECT count(*) FROM proof", "browser_fixture")).toBe("1");
      } finally {
        f.cleanup();
      }
    });

    it.each([
      { diagnostic: false, preflight: false, replacement: false, revoked: false },
      { diagnostic: false, preflight: true, replacement: true, revoked: true },
      { diagnostic: true, preflight: false, replacement: true, revoked: true },
      { diagnostic: true, preflight: true, replacement: false, revoked: false },
    ])("closes only an unused SQL gate after interruption: %j", async (options) => {
      const f = await setup({ diagnostic: options.diagnostic });
      let observe: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const { parent, evidence, use } = reserveOnly(f);
        let preflight = null;
        if (options.preflight) {
          preflight = await new PostgreSqlFixtureValidationProvider().observe(
            f.definition,
            f.validation,
            use,
            () => f.s.journal.assertAuthority(f.s.authority),
            AbortSignal.timeout(5000),
          );
          f.s.journal.fixtures.validation.admit(f.s.authority, use.accessId, preflight);
        }
        const previousAuthority = f.s.authority;
        if (options.replacement) f.s.newLease();
        const journal = options.replacement ? f.s.reopen().orchestration : f.s.journal;
        const authority = f.s.authority;
        journal.markInterruptedActions(authority);
        if (options.revoked)
          journal.fixtures.validation.revoke(
            authority.runId,
            journal.control(authority.runId).controlVersion,
            use.grantId,
          );
        const retainedParent = journal.action(authority.runId, parent.actionId);
        const retainedWorkspace = journal.agents.workspaceOperation(
          authority.runId,
          evidence.workspaceOperationId,
        );
        const retainedGrants = journal.fixtures.validation.grants(authority.runId);
        expect(retainedParent?.status).toBe("indeterminate");
        expect(retainedWorkspace.stopEvidence).toBeNull();
        observe = vi.spyOn(PostgreSqlFixtureValidationProvider.prototype, "observe");
        const recovery = accessRecovery(journal, authority);
        const request = recovery.decision({
          kind: "reconcile_fixture_access",
          accessId: use.accessId,
        });
        const running = await recovery.kernel.execute(request, authority);
        if (running.status !== "running") throw new Error(JSON.stringify(running));
        const result = await recovery.kernel.operation(running.operationId)!;
        const payload = success(result);
        expect(payload.kind).toBe("inspection");
        const closed = journal.fixtures.validation.use(authority.runId, use.accessId);
        expect(closed).toEqual({
          ...use,
          preflight,
          status: "not_started",
          localStopped: true,
          remoteStopped: true,
          detail: expect.stringContaining(
            "Parent validation outcome and workspace I/O stop remain unverified",
          ),
        });
        expect(await recovery.kernel.execute(request, authority)).toEqual(result);
        expect(
          (await recovery.dispatch({ kind: "reconcile_fixture_access", accessId: use.accessId }))
            .status,
        ).toBe("succeeded");
        expect(observe).not.toHaveBeenCalled();
        expect(journal.fixtures.validation.use(authority.runId, use.accessId)).toEqual(closed);
        expect(journal.fixtures.validation.grants(authority.runId)).toEqual(retainedGrants);
        expect(journal.action(authority.runId, parent.actionId)).toEqual(retainedParent);
        expect(journal.delivery.evidence(authority.runId, evidence.evidenceId)).toEqual(evidence);
        expect(
          journal.agents.workspaceOperation(authority.runId, evidence.workspaceOperationId),
        ).toEqual(retainedWorkspace);
        expect(
          journal.agents.activeWorkspaceOperation(authority.runId, evidence)?.operationId,
        ).toBe(evidence.workspaceOperationId);
        expect(journal.fixtures.validation.eligible(authority.runId, use.accessId)).toBe(false);
        expect(journal.delivery.satisfiesCheck(authority.runId, evidence.evidenceId)).toBe(false);
        expect(() =>
          journal.fixtures.validation.dispatch(previousAuthority, use.accessId, use.localCommand!),
        ).toThrow();
        if (preflight)
          expect(() =>
            journal.fixtures.validation.admit(previousAuthority, use.accessId, preflight),
          ).toThrow();
        expect(journal.fixtures.validation.use(authority.runId, use.accessId)).toEqual(closed);
        expect(f.sql("SELECT to_regclass('public.proof') IS NULL", "browser_fixture")).toBe("t");
      } finally {
        observe?.mockRestore();
        f.cleanup();
      }
    });
    it("refuses a running parent and changed validation/creation provenance without closing its gate", async () => {
      const f = await setup(),
        db = new Database(f.s.path);
      try {
        const { parent, evidence, use } = reserveOnly(f);
        const before = f.s.journal.fixtures.validation.use(f.s.authority.runId, use.accessId);
        expect(
          await f.s.dispatch({ kind: "reconcile_fixture_access", accessId: use.accessId }),
        ).toMatchObject({
          status: "rejected",
          code: "fixture_access_action_live",
        });
        expect(f.s.journal.fixtures.validation.use(f.s.authority.runId, use.accessId)).toEqual(
          before,
        );
        f.s.journal.markInterruptedActions(f.s.authority);
        for (const delta of [
          { runId: randomUUID() },
          { evidenceId: randomUUID() },
          { operationId: randomUUID() },
        ]) {
          // Indexed identities are protected by SQLite before the capability
          // can see them. Do not disable those constraints for fault injection.
          expect(() =>
            db
              .prepare("UPDATE validation_evidence SET record_json=? WHERE evidence_id=?")
              .run(JSON.stringify({ ...evidence, ...delta }), evidence.evidenceId),
          ).toThrow("CHECK constraint failed");
          expect(f.s.journal.delivery.evidence(f.s.authority.runId, evidence.evidenceId)).toEqual(
            evidence,
          );
        }
        for (const delta of [
          { controllerLeaseId: randomUUID() },
          { fixtureAccessIds: [] },
          { policyDigest: "0".repeat(64) },
        ]) {
          db.prepare("UPDATE validation_evidence SET record_json=? WHERE evidence_id=?").run(
            JSON.stringify({ ...evidence, ...delta }),
            evidence.evidenceId,
          );
          expect(
            await f.s.dispatch({ kind: "reconcile_fixture_access", accessId: use.accessId }),
          ).toMatchObject({
            status: "rejected",
            code: "fixture_access_provenance_changed",
          });
          expect(f.s.journal.fixtures.validation.use(f.s.authority.runId, use.accessId)).toEqual(
            before,
          );
        }
        db.prepare("UPDATE validation_evidence SET record_json=? WHERE evidence_id=?").run(
          JSON.stringify(evidence),
          evidence.evidenceId,
        );
        for (const delta of [{ marker: "changed" }, { operationId: randomUUID() }]) {
          db.prepare("UPDATE fixture_validation_uses SET record_json=? WHERE access_id=?").run(
            JSON.stringify({ ...use, ...delta }),
            use.accessId,
          );
          expect(
            await f.s.dispatch({ kind: "reconcile_fixture_access", accessId: use.accessId }),
          ).toMatchObject({
            status: "rejected",
            code: "fixture_access_provenance_changed",
          });
        }
        db.prepare("UPDATE fixture_validation_uses SET record_json=? WHERE access_id=?").run(
          JSON.stringify(use),
          use.accessId,
        );
        expect(
          await f.s.dispatch({ kind: "reconcile_fixture_access", accessId: randomUUID() }),
        ).toMatchObject({ status: "rejected", code: "unknown_fixture_access" });
        expect(f.s.journal.action(f.s.authority.runId, parent.actionId)?.status).toBe(
          "indeterminate",
        );
        expect(f.s.journal.fixtures.validation.use(f.s.authority.runId, use.accessId)).toEqual(
          before,
        );
      } finally {
        db.close();
        f.cleanup();
      }
    });
    it("rolls back unused-gate closure when its journal observation cannot be recorded", async () => {
      const f = await setup(),
        db = new Database(f.s.path);
      try {
        const { use, evidence } = reserveOnly(f);
        f.s.journal.markInterruptedActions(f.s.authority);
        db.exec(
          "CREATE TRIGGER deny_unused_gate_observation BEFORE INSERT ON observations WHEN json_extract(NEW.observation_json,'$.kind')='fixture.validation_not_started' BEGIN SELECT RAISE(ABORT,'test unused gate observation failure'); END",
        );
        expect(
          (await f.s.dispatch({ kind: "reconcile_fixture_access", accessId: use.accessId })).status,
        ).toBe("indeterminate");
        expect(f.s.journal.fixtures.validation.use(f.s.authority.runId, use.accessId)).toEqual(use);
        expect(f.s.journal.delivery.evidence(f.s.authority.runId, evidence.evidenceId)).toEqual(
          evidence,
        );
        db.exec("DROP TRIGGER deny_unused_gate_observation");
        expect(
          (await f.s.dispatch({ kind: "reconcile_fixture_access", accessId: use.accessId })).status,
        ).toBe("succeeded");
      } finally {
        db.close();
        f.cleanup();
      }
    });
    it("does not close a reserved gate while its original kernel operation is still unwinding", async () => {
      const f = await setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      const prepare = commandLifetime.prepareCommandLifetime;
      const held = vi
        .spyOn(commandLifetime, "prepareCommandLifetime")
        .mockImplementation(async (...args) => {
          entered = true;
          await gate;
          return prepare(...args);
        });
      let settled: Promise<unknown> | undefined;
      try {
        const running = await f.s.kernel.execute(f.s.decision(f.action), f.s.authority);
        if (running.status !== "running") throw new Error(JSON.stringify(running));
        const pending = f.s.kernel.operation(running.operationId)!;
        settled = pending.then(
          (result) => result,
          (error: unknown) => error,
        );
        await waitFor(() => entered);
        const use = f.s.journal.fixtures.validation.uses(f.s.authority.runId).at(-1)!;
        expect(use.status).toBe("reserved");
        // Fault: durable action interruption is recorded before the still-owned
        // handler has acknowledged stop. The live operation must take precedence.
        f.s.journal.markInterruptedActions(f.s.authority);
        expect(f.s.kernel.operation(use.operationId)).toBe(pending);
        expect(
          await f.s.dispatch({ kind: "reconcile_fixture_access", accessId: use.accessId }),
        ).toMatchObject({
          status: "rejected",
          code: "fixture_access_action_live",
          detail: expect.stringContaining("still executing"),
        });
        expect(f.s.journal.fixtures.validation.use(f.s.authority.runId, use.accessId)).toEqual(use);
        expect(f.sql("SELECT to_regclass('public.proof') IS NULL", "browser_fixture")).toBe("t");
        release();
        // The deliberately interrupted action cannot overwrite its durable state
        // when the original handler later returns. Await that terminal failure.
        expect(await settled).toEqual(new Error("Action state changed before settlement"));
      } finally {
        release();
        await settled;
        held.mockRestore();
        f.cleanup();
      }
    });
    it("uses the same restricted fixture and stop proofs for diagnostics without satisfying delivery", async () => {
      const f = await setup({ diagnostic: true });
      try {
        const { result, evidence, use } = await f.validate();
        expect(result, JSON.stringify(evidence.outcome)).toMatchObject({
          outcome: "succeeded",
          satisfiesCheck: false,
        });
        expect(evidence).toMatchObject({
          purpose: "diagnostic",
          sourceUnchanged: true,
          environmentVerified: true,
        });
        expect(use).toMatchObject({ localStopped: true, remoteStopped: true });
        expect(f.sql("SELECT value FROM proof", "browser_fixture")).toBe("green");
      } finally {
        f.cleanup();
      }
    });
    it("does not grant diagnostic SQL through declaration, creation authority or a pre-existing database", async () => {
      const f = await setup({ diagnostic: true, create: false, grant: false });
      try {
        expect(await f.s.dispatch(f.action)).toMatchObject({
          status: "rejected",
          code: "fixture_access_grant_required",
        });
        f.grant();
        f.sql(`CREATE DATABASE browser_fixture OWNER ${f.role}`);
        expect(await f.s.dispatch(f.action)).toMatchObject({
          status: "rejected",
          code: "fixture_access_not_owned",
        });
        expect(f.s.journal.fixtures.validation.uses(f.s.authority.runId)).toEqual([]);
      } finally {
        f.cleanup();
      }
    });
    it("rejects an unsafe validation role for diagnostics before starting the repository command", async () => {
      const f = await setup({ diagnostic: true });
      try {
        f.sql(`ALTER ROLE ${f.role} SUPERUSER`);
        const { result, evidence } = await f.validate();
        expect(result).toMatchObject({ outcome: "not_started", satisfiesCheck: false });
        expect(evidence.outcome?.exitCode).toBeNull();
      } finally {
        f.cleanup();
      }
    });
    it("uses the operator CLI to grant and revoke SQL access separately from creation", async () => {
      const f = await setup({ grant: false });
      try {
        const cli = (...args: string[]) =>
          execFileSync(process.execPath, ["dist/cli.js", ...args, "--state", f.s.path], {
            encoding: "utf8",
            timeout: 5000,
          });
        expect(
          f.s.journal.fixtures.validation.requestAvailable(f.s.authority.runId, f.definition.id),
        ).toBe(false);
        const version = String(f.s.journal.control(f.s.authority.runId).controlVersion);
        expect(
          cli(
            "grant-fixture-validation",
            f.s.authority.runId,
            f.definition.id,
            "--control-version",
            version,
            "--expires-at",
            new Date(Date.now() + 60000).toISOString(),
            "--psql-path",
            join(bin!, "psql"),
          ),
        ).toContain("SQL-access grant");
        const grant = f.s.journal.fixtures.validation.grants(f.s.authority.runId).at(-1)!;
        expect(grant.binding).toEqual(f.binding);
        expect(
          f.s.journal.fixtures.validation.requestAvailable(f.s.authority.runId, f.definition.id),
        ).toBe(true);
        expect(
          cli(
            "revoke-fixture-validation",
            f.s.authority.runId,
            grant.grantId,
            "--control-version",
            String(f.s.journal.control(f.s.authority.runId).controlVersion),
          ),
        ).toContain("SQL access revoked");
        expect(await f.s.dispatch(f.action)).toMatchObject({
          status: "rejected",
          code: "fixture_access_grant_required",
        });
        expect(f.s.journal.fixtures.grants(f.s.authority.runId).at(-1)?.revokedAt).toBeNull();
      } finally {
        f.cleanup();
      }
    });
    it("creates the declared fixture, validates its actual data and records exact environment evidence", async () => {
      const f = await setup();
      try {
        const { result, evidence, use } = await f.validate();
        expect(result, JSON.stringify(evidence.outcome)).toMatchObject({
          outcome: "succeeded",
          satisfiesCheck: true,
        });
        expect(evidence).toMatchObject({
          environmentVerified: true,
          sourceUnchanged: true,
          fixtureAccessIds: [use.accessId],
          environmentGenerations: [],
        });
        expect(use).toMatchObject({
          status: "stopped",
          localStopped: true,
          remoteStopped: true,
          preflight: { otherConnections: 0 },
          finalObservation: { otherConnections: 0 },
        });
        expect(use.preflight?.role).toMatchObject({
          name: f.role,
          superuser: false,
          memberships: false,
          externalDependencies: false,
          unsafeFunctions: false,
        });
        expect(f.sql("SELECT value FROM proof", "browser_fixture")).toBe("green");
        expect(readFileSync(join(f.s.source, "app.txt"), "utf8")).toBe("red\n");
        const count = f.s.journal.fixtures.validation.uses(f.s.authority.runId).length;
        const repeated = await f.s.kernel.execute(
          f.s.decision({ kind: "inspect_fixture_access", accessId: use.accessId }),
          f.s.authority,
        );
        expect(repeated.status).toBe("succeeded");
        expect(f.s.journal.fixtures.validation.uses(f.s.authority.runId)).toHaveLength(count);
        f.s.journal.fixtures.validation.revoke(
          f.s.authority.runId,
          f.s.journal.control(f.s.authority.runId).controlVersion,
          use.grantId,
        );
        // Revocation prevents new SQL, but does not erase valid historical evidence.
        expect(f.s.journal.delivery.satisfiesCheck(f.s.authority.runId, evidence.evidenceId)).toBe(
          true,
        );
      } finally {
        f.cleanup();
      }
    });
    it("does not turn a creation grant or a pre-existing database into SQL-access authority", async () => {
      const f = await setup({ create: false, grant: false });
      try {
        expect(await f.s.dispatch(f.action)).toMatchObject({
          status: "rejected",
          code: "fixture_access_grant_required",
        });
        f.grant();
        f.sql(`CREATE DATABASE browser_fixture OWNER ${f.role}`);
        f.sql(
          "CREATE TABLE untouched(value text); INSERT INTO untouched VALUES ('operator')",
          "browser_fixture",
        );
        expect(await f.s.dispatch(f.action)).toMatchObject({
          status: "rejected",
          code: "fixture_access_not_owned",
        });
        expect(f.s.journal.fixtures.validation.uses(f.s.authority.runId)).toEqual([]);
        expect(f.sql("SELECT value FROM untouched", "browser_fixture")).toBe("operator");
      } finally {
        f.cleanup();
      }
    });
    it("binds both an isolated check-local service and the exact granted host fixture", async () => {
      const f = await setup({ localService: true, timeoutMs: 10000 });
      try {
        const { result, evidence, use } = await f.validate();
        expect(result, JSON.stringify(evidence.outcome)).toMatchObject({
          outcome: "succeeded",
          satisfiesCheck: true,
        });
        expect(evidence).toMatchObject({
          environmentVerified: true,
          fixtureAccessIds: [use.accessId],
          environmentGenerations: [{ bindingId: "scratch-db" }],
        });
        expect(evidence.outcome?.stdout).toBe("scratch_fixture\ngreen\n");
        expect(f.sql("SELECT value FROM proof", "browser_fixture")).toBe("green");
        expect(f.sql("SELECT count(*) FROM pg_database WHERE datname='scratch_fixture'")).toBe("0");
      } finally {
        f.cleanup();
      }
    });
    it.each([
      "SUPERUSER",
      "CREATEDB",
      "CREATEROLE",
      "REPLICATION",
      "BYPASSRLS",
      "membership",
      "externalOwnership",
      "externalAcl",
      "parameterPublic",
      "securityDefiner",
      "functionGrant",
      "foreignWrapper",
      "eventTrigger",
    ])("rejects %s authority before any repository SQL executes", async (variant) => {
      const f = await setup();
      try {
        if (["SUPERUSER", "CREATEDB", "CREATEROLE", "REPLICATION", "BYPASSRLS"].includes(variant))
          f.sql(`ALTER ROLE ${f.role} ${variant}`);
        if (variant === "membership") f.sql(`GRANT pg_read_server_files TO ${f.role}`);
        if (variant === "externalOwnership")
          f.sql(`CREATE DATABASE outside_fixture OWNER ${f.role}`);
        if (variant === "externalAcl") f.sql(`GRANT CREATE ON DATABASE postgres TO ${f.role}`);
        if (variant === "parameterPublic")
          f.sql("GRANT SET ON PARAMETER session_preload_libraries TO PUBLIC");
        if (variant === "securityDefiner")
          f.sql(
            "CREATE FUNCTION public.privileged() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'",
            "browser_fixture",
          );
        if (variant === "functionGrant")
          f.sql(
            `GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO ${f.role}`,
            "browser_fixture",
          );
        if (variant === "foreignWrapper")
          f.sql(
            `CREATE FOREIGN DATA WRAPPER unsafe_wrapper; GRANT USAGE ON FOREIGN DATA WRAPPER unsafe_wrapper TO ${f.role}`,
            "browser_fixture",
          );
        if (variant === "eventTrigger")
          f.sql(
            "CREATE FUNCTION public.ddl_hook() RETURNS event_trigger LANGUAGE plpgsql AS 'BEGIN END'; CREATE EVENT TRIGGER test_hook ON ddl_command_start EXECUTE FUNCTION public.ddl_hook()",
            "browser_fixture",
          );
        const { result, evidence, use } = await f.validate();
        expect(result).toMatchObject({ outcome: "not_started", satisfiesCheck: false });
        expect(evidence.outcome?.stderr).toContain("forbidden authority");
        expect(use).toMatchObject({
          status: "not_started",
          localStopped: true,
          remoteStopped: true,
          preflight: null,
        });
        expect(f.sql("SELECT to_regclass('public.proof') IS NULL", "browser_fixture")).toBe("t");
      } finally {
        f.cleanup();
      }
    });
    it("retains a remote query exclusion after local timeout and reconciles without upgrading failed evidence", async () => {
      const f = await setup({ query: "SELECT pg_sleep(20)", timeoutMs: 1200 });
      try {
        const { result, evidence, use } = await f.validate();
        expect(result, JSON.stringify(evidence.outcome)).toMatchObject({
          outcome: "timed_out",
          satisfiesCheck: false,
        });
        expect(use).toMatchObject({
          status: "dispatched",
          localStopped: true,
          remoteStopped: false,
        });
        expect(await f.s.dispatch(f.action)).toMatchObject({
          status: "rejected",
          code: "fixture_access_busy",
        });
        const control = (kind: "pause" | "resume") =>
          f.s.journal.operatorControl(
            f.s.authority.runId,
            f.s.journal.control(f.s.authority.runId).controlVersion,
            { kind },
          );
        control("pause");
        expect(() =>
          assertRuntimeHandoffReady(
            f.s.journal,
            f.s.authority,
            f.s.journal.control(f.s.authority.runId).controlVersion,
          ),
        ).toThrow("Settle retained delivery and fixture operations");
        control("resume");
        const pending = success(
          await f.s.dispatch({ kind: "reconcile_fixture_access", accessId: use.accessId }),
        );
        expect(pending.kind).toBe("inspection");
        if (pending.kind === "inspection")
          expect(JSON.parse(pending.text).remoteStopped).toBe(false);
        // Explicit test-owned server cancellation simulates the query ending. Production
        // reconciliation never terminates an unattributed or operator-owned backend.
        const identity = f
          .sql(
            "SELECT pid::text||':'||extract(epoch from backend_start)::text FROM pg_stat_activity WHERE datname='browser_fixture' AND query='SELECT pg_sleep(20)' AND state='active'",
          )
          .split(":");
        expect(identity[0]).toMatch(/^\d+$/);
        expect(identity[1]).toMatch(/^\d+\.\d+$/);
        expect(
          f.sql(
            `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid=${identity[0]} AND extract(epoch from backend_start)=${identity[1]}`,
          ),
        ).toBe("t");
        await expect
          .poll(
            () => f.sql("SELECT count(*) FROM pg_stat_activity WHERE datname='browser_fixture'"),
            { timeout: 5000 },
          )
          .toBe("0");
        const settled = success(
          await f.s.dispatch({ kind: "reconcile_fixture_access", accessId: use.accessId }),
        );
        if (settled.kind !== "inspection") throw new Error("Expected reconciliation inspection");
        expect(JSON.parse(settled.text)).toMatchObject({
          status: "stopped",
          localStopped: true,
          remoteStopped: true,
        });
        expect(
          f.s.journal.delivery.evidence(f.s.authority.runId, evidence.evidenceId)
            .environmentVerified,
        ).toBe(false);
        expect(f.s.journal.delivery.satisfiesCheck(f.s.authority.runId, evidence.evidenceId)).toBe(
          false,
        );
        control("pause");
        expect(() =>
          assertRuntimeHandoffReady(
            f.s.journal,
            f.s.authority,
            f.s.journal.control(f.s.authority.runId).controlVersion,
          ),
        ).not.toThrow();
      } finally {
        f.cleanup();
      }
    });
    it("revokes an in-flight grant without mistaking local cancellation for PostgreSQL stop", async () => {
      const f = await setup({ query: "SELECT pg_sleep(20)", timeoutMs: 15000 });
      const pending = f.validate();
      try {
        await expect
          .poll(
            () =>
              f.sql(
                "SELECT count(*) FROM pg_stat_activity WHERE datname='browser_fixture' AND query='SELECT pg_sleep(20)' AND state='active'",
              ),
            { timeout: 5000 },
          )
          .toBe("1");
        const grant = f.s.journal.fixtures.validation.grants(f.s.authority.runId).at(-1)!;
        f.s.journal.fixtures.validation.revoke(
          f.s.authority.runId,
          f.s.journal.control(f.s.authority.runId).controlVersion,
          grant.grantId,
        );
        const { evidence, use } = await pending;
        expect(evidence).toMatchObject({
          outcome: { status: "cancelled" },
          environmentVerified: false,
        });
        expect(use).toMatchObject({
          status: "dispatched",
          localStopped: true,
          remoteStopped: false,
        });
        expect(
          await f.s.dispatch({ kind: "reconcile_fixture_access", accessId: use.accessId }),
        ).toMatchObject({
          status: "rejected",
          code: "fixture_access_grant_required",
        });
        f.grant();
        expect(await f.s.dispatch(f.action)).toMatchObject({
          status: "rejected",
          code: "fixture_access_busy",
        });
        const read = success(
          await f.s.dispatch({ kind: "reconcile_fixture_access", accessId: use.accessId }),
        );
        if (read.kind !== "inspection") throw new Error("Expected inspection");
        expect(JSON.parse(read.text)).toMatchObject({ localStopped: true, remoteStopped: false });
        const observedUse = f.s.journal.fixtures.validation.use(f.s.authority.runId, use.accessId);
        const readGrant = f.s.journal.fixtures.validation.observationUse(
          f.s.authority.runId,
          use.accessId,
        );
        expect(observedUse.finalObservation).not.toBeNull();
        f.grant();
        expect(() =>
          f.s.journal.fixtures.validation.observationUse(
            f.s.authority.runId,
            use.accessId,
            readGrant.grantId,
          ),
        ).toThrow("operator SQL-access grant");
        expect(() =>
          f.s.journal.fixtures.validation.observeStopped(
            f.s.authority,
            use.accessId,
            observedUse.finalObservation!,
            readGrant.grantId,
          ),
        ).toThrow("operator SQL-access grant");
        expect(f.s.journal.fixtures.validation.use(f.s.authority.runId, use.accessId)).toEqual(
          observedUse,
        );
        expect(f.s.journal.delivery.evidence(f.s.authority.runId, evidence.evidenceId)).toEqual(
          evidence,
        );
      } finally {
        await pending.catch(() => undefined);
        f.cleanup();
      }
    });
    it("rejects stale or expired grants and rolls back revocation if the audit write fails", async () => {
      const f = await setup(),
        db = new Database(f.s.path);
      try {
        const journal = f.s.journal.fixtures.validation,
          run = f.s.authority.runId;
        const original = journal.grants(run),
          version = f.s.journal.control(run).controlVersion;
        const input = {
          fixtureId: f.definition.id,
          binding: f.binding,
          pgbouncer: f.pgbouncer,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        };
        expect(() => journal.grant(run, version - 1, input)).toThrow("Control changed");
        for (const expiresAt of [
          new Date(Date.now() - 1).toISOString(),
          new Date(Date.now() + 90000000).toISOString(),
        ])
          expect(() => journal.grant(run, version, { ...input, expiresAt })).toThrow(
            "Grant expiry",
          );
        expect(journal.grants(run)).toEqual(original);
        db.exec(
          "CREATE TRIGGER deny_fixture_grant_audit BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT,'test grant audit failure'); END",
        );
        expect(() => journal.revoke(run, version, original.at(-1)!.grantId)).toThrow(
          "test grant audit failure",
        );
        expect(journal.grants(run)).toEqual(original);
        expect(f.s.journal.control(run).controlVersion).toBe(version);
      } finally {
        db.close();
        f.cleanup();
      }
    });
    it("refuses changed access provenance and contradictory durable stop records", async () => {
      const f = await setup(),
        db = new Database(f.s.path);
      try {
        const { use } = await f.validate(),
          journal = f.s.journal.fixtures.validation;
        expect(journal.eligible(f.s.authority.runId, use.accessId)).toBe(true);
        for (const delta of [
          {
            binding: {
              ...use.binding,
              executable: { ...use.binding.executable, digest: "0".repeat(64) },
            },
          },
          { pgbouncer: { ...use.pgbouncer, digest: "0".repeat(64) } },
          { databaseOid: "999999" },
          { marker: "different-marker" },
          { generation: use.generation + 1 },
        ]) {
          db.prepare("UPDATE fixture_validation_uses SET record_json=? WHERE access_id=?").run(
            JSON.stringify({ ...use, ...delta }),
            use.accessId,
          );
          expect(journal.eligible(f.s.authority.runId, use.accessId)).toBe(false);
          expect(() => journal.observationUse(f.s.authority.runId, use.accessId)).toThrow(
            "recorded grant or creation",
          );
        }
        db.prepare("UPDATE fixture_validation_uses SET record_json=? WHERE access_id=?").run(
          JSON.stringify(use),
          use.accessId,
        );
        for (const delta of [
          { localStopped: false },
          { localCommand: null },
          { localReceipt: null },
          { localCommand: { ...use.localCommand!, runId: randomUUID() } },
          { localReceipt: { ...use.localReceipt!, kind: "not_started", code: null } },
          { remoteStopped: false },
          { preflight: null },
          { finalObservation: null },
          { status: "reserved" },
          { status: "dispatched" },
          { status: "not_started" },
        ])
          expect(FixtureValidationUseSchema.safeParse({ ...use, ...delta }).success).toBe(false);
      } finally {
        db.close();
        f.cleanup();
      }
    });
    it("does not repair missing independent stop evidence from server quiescence or a replacement lease", async () => {
      const f = await setup(),
        db = new Database(f.s.path);
      try {
        const { use, evidence } = await f.validate();
        // Lose the journal acknowledgment and published physical receipts for BOTH
        // enclosing and inner workers. Server quiescence alone is still insufficient.
        const workspaceOperation = f.s.journal.agents.workspaceOperation(
          f.s.authority.runId,
          evidence.workspaceOperationId,
        );
        for (const intent of [use.localCommand!, workspaceOperation.execution!])
          renameSync(
            join(intent.directory.path, "stopped.json"),
            join(intent.directory.path, "retained-original-stop.json"),
          );
        db.prepare("UPDATE workspace_operations SET record_json=? WHERE operation_id=?").run(
          JSON.stringify({
            ...workspaceOperation,
            status: "indeterminate",
            stopEvidence: null,
            executionStop: null,
          }),
          workspaceOperation.operationId,
        );
        db.prepare("UPDATE fixture_validation_uses SET record_json=? WHERE access_id=?").run(
          JSON.stringify({
            ...use,
            status: "dispatched",
            localStopped: false,
            localReceipt: null,
            remoteStopped: false,
            finalObservation: null,
          }),
          use.accessId,
        );
        const observer = new PostgreSqlFixtureValidationProvider();
        expect(() =>
          f.s.journal.fixtures.validation.noDispatch(f.s.authority, use.accessId),
        ).toThrow("Only an unused fixture SQL dispatch gate");
        const observation = await observer.observe(
          f.definition,
          f.validation,
          use,
          () => f.s.journal.assertAuthority(f.s.authority),
          AbortSignal.timeout(5000),
        );
        expect(observation.otherConnections).toBe(0);
        expect(() =>
          f.s.journal.fixtures.validation.observeStopped(
            f.s.authority,
            use.accessId,
            observation,
            use.grantId,
          ),
        ).toThrow("Remote quiescence alone");
        expect(
          await f.s.dispatch({ kind: "reconcile_fixture_access", accessId: use.accessId }),
        ).toMatchObject({
          status: "rejected",
          code: "fixture_access_local_unknown",
        });
        const reopened = f.s.reopen(),
          authority = f.s.newLease(),
          journal = reopened.orchestration;
        expect(() => journal.fixtures.validation.localStopped(authority, use.accessId)).toThrow(
          "replacement controller",
        );
        expect(journal.delivery.satisfiesCheck(authority.runId, evidence.evidenceId)).toBe(false);
        expect(journal.fixtures.validation.use(authority.runId, use.accessId)).toMatchObject({
          localStopped: false,
          remoteStopped: false,
        });
      } finally {
        db.close();
        f.cleanup();
      }
    });
    it.each([
      { revoked: false, missingInnerReceipt: false },
      { revoked: true, missingInnerReceipt: false },
      { revoked: false, missingInnerReceipt: true },
      { revoked: true, missingInnerReceipt: true },
    ])(
      "cold-recovers local stop after lost settlement (revoked=$revoked, missing inner receipt=$missingInnerReceipt), without changing validation evidence",
      async ({ revoked, missingInnerReceipt }) => {
        const f = await setup();
        const db = new Database(f.s.path);
        db.exec(
          "CREATE TRIGGER deny_fixture_local_stop BEFORE UPDATE ON fixture_validation_uses WHEN json_extract(NEW.record_json,'$.localStopped')=1 AND json_extract(NEW.record_json,'$.localCommand') IS NOT NULL BEGIN SELECT RAISE(ABORT,'Controller lost local-stop settlement'); END",
        );
        let observe: ReturnType<typeof vi.spyOn> | undefined;
        try {
          // The real worker cannot persist local settlement. Its enclosing stop
          // proves I/O closure, not a command result or remote SQL quiescence.
          expect((await f.s.dispatch(f.action)).status).toBe("failed");
          db.exec("DROP TRIGGER deny_fixture_local_stop");
          const use = f.s.journal.fixtures.validation.uses(f.s.authority.runId).at(-1)!;
          expect(use).toMatchObject({
            status: "dispatched",
            localStopped: false,
            localReceipt: null,
          });
          expect(await readCommandStop(use.localCommand!)).toMatchObject({
            kind: "stopped",
            code: 0,
          });
          if (missingInnerReceipt) {
            // Retain original receipt bytes, but make the inner monitor's published
            // receipt unavailable. Only the real enclosing worker receipt remains.
            renameSync(
              join(use.localCommand!.directory.path, "stopped.json"),
              join(use.localCommand!.directory.path, "retained-original-stop.json"),
            );
            expect(await readCommandStop(use.localCommand!)).toBeNull();
          }
          const reopened = f.s.reopen(),
            authority = f.s.newLease(),
            journal = reopened.orchestration;
          const evidence = journal.delivery.evidence(authority.runId, use.evidenceId);
          const workspace = journal.agents.workspaceOperation(
            authority.runId,
            evidence.workspaceOperationId,
          );
          const parent = journal.actionForOperation(authority.runId, use.operationId);
          expect(evidence).toMatchObject({ status: "interrupted", outcome: null });
          expect(workspace.executionStop).toMatchObject({ kind: "stopped", code: 1 });
          expect(workspace.stopEvidence).not.toBeNull();
          if (revoked)
            journal.fixtures.validation.revoke(
              authority.runId,
              journal.control(authority.runId).controlVersion,
              use.grantId,
            );
          const grants = journal.fixtures.validation.grants(authority.runId);
          observe = vi.spyOn(PostgreSqlFixtureValidationProvider.prototype, "observe");
          const recovery = accessRecovery(journal, authority);
          const result = await recovery.dispatch({
            kind: "reconcile_fixture_access",
            accessId: use.accessId,
          });
          expect(result.status).toBe(revoked ? "rejected" : "succeeded");
          expect(journal.fixtures.validation.use(authority.runId, use.accessId)).toMatchObject({
            localStopped: true,
            remoteStopped: !revoked,
            localCommand: use.localCommand,
            localReceipt: missingInnerReceipt ? null : { kind: "stopped", code: 0 },
            localWorkerStop: missingInnerReceipt
              ? {
                  operationId: workspace.operationId,
                  execution: workspace.execution,
                  receipt: workspace.executionStop,
                }
              : null,
          });
          if (revoked) expect(observe).not.toHaveBeenCalled();
          else expect(observe).toHaveBeenCalledTimes(1);
          expect(journal.fixtures.validation.grants(authority.runId)).toEqual(grants);
          expect(journal.delivery.evidence(authority.runId, use.evidenceId)).toEqual(evidence);
          expect(journal.actionForOperation(authority.runId, use.operationId)).toEqual(parent);
          expect(
            journal.agents.workspaceOperation(authority.runId, evidence.workspaceOperationId),
          ).toEqual(workspace);
          expect(journal.delivery.satisfiesCheck(authority.runId, use.evidenceId)).toBe(false);
          expect(f.sql("SELECT count(*) FROM proof", "browser_fixture")).toBe("1");
        } finally {
          observe?.mockRestore();
          db.close();
          f.cleanup();
        }
      },
    );
    it("seals an admitted but never-started supervisor across lease replacement and fences the delayed old launch", async () => {
      const f = await setup();
      const start = commandLifetime.startDurableCommand;
      const fault = vi.spyOn(commandLifetime, "startDurableCommand").mockImplementation(() => {
        throw new NamespaceStopUnprovenError(
          "Controller lost execution after durable dispatch intent",
        );
      });
      let observe: ReturnType<typeof vi.spyOn> | undefined;
      try {
        // Exercise the confined fixture-command boundary directly: the enclosing
        // worker is covered separately by validation-io's real process-loss test.
        const { evidence: admitted, use: reserved } = reserveOnly(f);
        const observation = await new PostgreSqlFixtureValidationProvider().observe(
          f.definition,
          f.validation,
          reserved,
          () => f.s.journal.assertAuthority(f.s.authority),
          AbortSignal.timeout(10_000),
        );
        f.s.journal.fixtures.validation.admit(f.s.authority, reserved.accessId, observation);
        const workspace = f.s.journal.agents.workspace(f.s.authority.runId, admitted);
        await expect(
          startConfinedCommand(
            {
              workspace: workspace.path,
              sourceMode: "read-only",
              ...admitted.check,
            },
            {
              fixtureBridge: {
                definition: f.definition,
                binding: reserved.binding,
                pgbouncer: reserved.pgbouncer,
                validationRole: f.validation.validationRole,
                listenPort: f.validation.listenPort,
                connectionVariable: f.validation.connectionVariable,
              },
              durableStop: {
                runId: reserved.runId,
                operationId: reserved.operationId,
                controllerLeaseId: reserved.controllerLeaseId,
                scopeDigest: fixtureCommandScope([reserved]),
                admit: (intent) =>
                  f.s.journal.fixtures.validation.dispatch(
                    f.s.authority,
                    reserved.accessId,
                    intent,
                  ),
              },
            },
          ),
        ).rejects.toThrow("Controller lost execution");
        f.s.journal.markInterruptedActions(f.s.authority);
        const [intent, launch] = fault.mock.calls[0]!;
        fault.mockRestore();
        const use = f.s.journal.fixtures.validation.uses(f.s.authority.runId).at(-1)!;
        expect(use).toMatchObject({
          status: "dispatched",
          localCommand: intent,
          localStopped: false,
        });
        expect(await readCommandStop(intent)).toBeNull();
        const reopened = f.s.reopen(),
          authority = f.s.newLease(),
          journal = reopened.orchestration;
        journal.fixtures.validation.revoke(
          authority.runId,
          journal.control(authority.runId).controlVersion,
          use.grantId,
        );
        const evidence = journal.delivery.evidence(authority.runId, use.evidenceId);
        const workspaceOperation = journal.agents.workspaceOperation(
          authority.runId,
          evidence.workspaceOperationId,
        );
        observe = vi.spyOn(PostgreSqlFixtureValidationProvider.prototype, "observe");
        expect(
          (
            await accessRecovery(journal, authority).dispatch({
              kind: "reconcile_fixture_access",
              accessId: use.accessId,
            })
          ).status,
        ).toBe("succeeded");
        expect(observe).not.toHaveBeenCalled();
        expect(journal.fixtures.validation.use(authority.runId, use.accessId)).toMatchObject({
          status: "not_started",
          localStopped: true,
          remoteStopped: true,
          localReceipt: { kind: "not_started" },
        });
        const delayed = start(intent, launch);
        delayed.child.stdout!.resume();
        delayed.child.stderr!.resume();
        await expect(delayed.result).rejects.toThrow("supervisor failed");
        expect(f.sql("SELECT to_regclass('public.proof') IS NULL", "browser_fixture")).toBe("t");
        expect(journal.delivery.evidence(authority.runId, use.evidenceId)).toEqual(evidence);
        expect(
          journal.agents.workspaceOperation(authority.runId, evidence.workspaceOperationId),
        ).toEqual(workspaceOperation);
        expect(workspaceOperation.stopEvidence).toBeNull();
        expect(journal.delivery.satisfiesCheck(authority.runId, use.evidenceId)).toBe(false);
      } finally {
        observe?.mockRestore();
        fault.mockRestore();
        f.cleanup();
      }
    });
    it("atomically rolls back evidence, workspace exclusion and fixture reservation if recording the use fails", async () => {
      const f = await setup(),
        db = new Database(f.s.path);
      try {
        db.exec(
          "CREATE TRIGGER deny_fixture_use BEFORE INSERT ON fixture_validation_uses BEGIN SELECT RAISE(ABORT,'test journal failure'); END",
        );
        const result = await f.s.dispatch(f.action);
        expect(result.status).not.toBe("succeeded");
        expect(db.prepare("SELECT count(*) AS n FROM validation_evidence").get()).toEqual({ n: 0 });
        expect(f.s.journal.fixtures.validation.uses(f.s.authority.runId)).toEqual([]);
        expect(
          f.s.journal.agents.activeWorkspaceOperation(
            f.s.authority.runId,
            f.action as Extract<KernelAction, { kind: "run_validation" }>,
          ),
        ).toBeNull();
        expect(f.sql("SELECT to_regclass('public.proof') IS NULL", "browser_fixture")).toBe("t");
      } finally {
        db.close();
        f.cleanup();
      }
    });
    it("cold-reconciles acknowledged local stop under a new lease without replaying SQL or rewriting failed evidence", async () => {
      const f = await setup({ query: "SELECT pg_sleep(20)", timeoutMs: 1200 });
      try {
        const { evidence, use } = await f.validate();
        expect(use).toMatchObject({ localStopped: true, remoteStopped: false });
        const reopened = f.s.reopen(),
          authority = f.s.newLease(),
          journal = reopened.orchestration;
        expect(journal.fixtures.validation.use(authority.runId, use.accessId)).toEqual(use);
        expect(() =>
          journal.fixtures.validation.dispatch(authority, use.accessId, use.localCommand!),
        ).toThrow();
        const kernel = new ActionKernel(journal);
        registerFixtureCapabilities(
          kernel,
          new PostgreSqlFixtureInspector(),
          new PostgreSqlFixtureCreator(),
        );
        const act = async (action: KernelAction) => {
          const ticket = journal.beginDecision(
            authority,
            journal.latestObservationCursor(authority.runId),
            journal.control(authority.runId).controlVersion,
          );
          const result = await kernel.execute(
            {
              explanation: "Reconcile existing database access without replay",
              evidenceIds: [],
              request: {
                schemaVersion: 1,
                decisionId: ticket.decisionId,
                observationCursor: ticket.observationCursor,
                expectedControlVersion: ticket.expectedControlVersion,
                action,
              },
            },
            authority,
          );
          return result.status === "running" ? await kernel.operation(result.operationId)! : result;
        };
        const [pid, startedAt] = f
          .sql(
            "SELECT pid::text||':'||extract(epoch from backend_start)::text FROM pg_stat_activity WHERE datname='browser_fixture' AND query='SELECT pg_sleep(20)' AND state='active'",
          )
          .split(":");
        expect(pid).toMatch(/^\d+$/);
        expect(startedAt).toMatch(/^\d+\.\d+$/);
        expect(
          f.sql(
            `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid=${pid} AND extract(epoch from backend_start)=${startedAt}`,
          ),
        ).toBe("t");
        await expect
          .poll(
            () => f.sql("SELECT count(*) FROM pg_stat_activity WHERE datname='browser_fixture'"),
            { timeout: 5000 },
          )
          .toBe("0");
        expect(
          (await act({ kind: "reconcile_fixture_access", accessId: use.accessId })).status,
        ).toBe("succeeded");
        expect(journal.fixtures.validation.use(authority.runId, use.accessId)).toMatchObject({
          status: "stopped",
          remoteStopped: true,
        });
        expect(journal.delivery.evidence(authority.runId, evidence.evidenceId)).toEqual(evidence);
        expect(journal.delivery.satisfiesCheck(authority.runId, evidence.evidenceId)).toBe(false);
      } finally {
        f.cleanup();
      }
    });
  },
);
