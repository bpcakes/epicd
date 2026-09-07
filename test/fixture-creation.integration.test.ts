import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { registerFixtureCapabilities } from "../src/kernel/fixtures.js";
import {
  PostgreSqlFixtureCreator,
  fixtureCreationObservationSql,
  type FixtureCreationProvider,
} from "../src/adapters/fixture-creation.js";
import {
  FixtureDefinitionSchema,
  RepositoryPolicySchema,
} from "../src/domain/repository-policy.js";
import type {
  FixtureBackend,
  FixtureCreation,
  FixtureCreationObservation,
  FixtureProviderBinding,
} from "../src/domain/fixtures.js";
import type { ControllerAuthority, KernelAction } from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
const backend: FixtureBackend = { pid: 12345, startedAt: "1700000000.123456" };
const binding: FixtureProviderBinding = {
  executable: { path: "/native/psql", device: "1", inode: "2", digest: "a".repeat(64) },
  directory: { path: "/fixture-socket", device: "1", inode: "3" },
  socket: { path: "/fixture-socket/.s.PGSQL.5432", device: "1", inode: "4", changeTimeNs: "1" },
};
const owned = (record: FixtureCreation): FixtureCreationObservation => ({
  backendStopped: true,
  database: {
    oid: String(record.plannedOid),
    name: "browser_fixture",
    owner: "fixture_role",
    markerMatches: true,
    allowConnections: true,
  },
});
function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-fixture-create-");
  const path = join(root, "state.sqlite3");
  let store = new StateStore(path);
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const definition = FixtureDefinitionSchema.parse({
    id: "browser-db",
    provider: "postgresql",
    socketDirectory: "/fixture-socket",
    port: 5432,
    role: "fixture_role",
    database: "browser_fixture",
    expectedOwner: "fixture_role",
    operations: ["create"],
    environmentBinding: "browser",
    cleanup: "retain",
  });
  const state = store.create(
    initialRun(),
    RepositoryPolicySchema.parse({ schemaVersion: 1, fixtures: [definition] }),
  );
  const lease = store.acquireLease(state.runId);
  let authority: ControllerAuthority = {
    runId: state.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const creator = {
    create: vi.fn<FixtureCreationProvider["create"]>(
      async (_definition, _intent, dispatch, guard) => {
        guard();
        dispatch(backend);
      },
    ),
    observe: vi.fn<FixtureCreationProvider["observe"]>(
      async (_definition, intent, _binding, guard) => {
        guard();
        return owned(intent);
      },
    ),
  };
  let kernel = new ActionKernel(store.orchestration);
  const register = () =>
    registerFixtureCapabilities(kernel, { inspect: async () => null }, creator);
  register();
  const grant = (operations: ("inspect" | "create")[] = ["inspect", "create"]) =>
    store.orchestration.fixtures.grant(
      state.runId,
      store.orchestration.control(state.runId).controlVersion,
      {
        fixtureId: definition.id,
        binding,
        operations,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );
  const request = (
    action: KernelAction = {
      kind: "provision_declared_fixture",
      fixtureId: definition.id,
      operation: "create",
      expectedGeneration: 0,
    },
  ) => {
    const journal = store.orchestration;
    const ticket = journal.beginDecision(
      authority,
      journal.latestObservationCursor(state.runId),
      journal.control(state.runId).controlVersion,
    );
    return {
      explanation: "Choose a bounded fixture capability",
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
  const dispatch = async (input = request()) => {
    const result = await kernel.execute(input, authority);
    return result.status === "running" ? await kernel.operation(result.operationId)! : result;
  };
  const reopen = () => {
    store.releaseLease(state.runId, authority.ownerToken);
    store.close();
    store = new StateStore(path);
    const next = store.acquireLease(state.runId);
    authority = { runId: state.runId, ownerToken: next.ownerToken, leaseId: next.leaseId };
    kernel = new ActionKernel(store.orchestration);
    register();
  };
  return {
    root,
    path,
    state,
    definition,
    creator,
    grant,
    request,
    dispatch,
    reopen,
    get store() {
      return store;
    },
    get journal() {
      return store.orchestration;
    },
    get kernel() {
      return kernel;
    },
    get authority() {
      return authority;
    },
  };
}
describe("durable fixture creation", () => {
  it("requires create authority, freezes one identity before dispatch, and replays without a second mutation", async () => {
    const f = fixture();
    f.grant(["inspect"]);
    expect(await f.dispatch()).toMatchObject({
      status: "rejected",
      code: "fixture_grant_required",
    });
    expect(f.creator.create).not.toHaveBeenCalled();
    f.grant();
    const request = f.request(),
      result = await f.dispatch(request);
    expect(result.status).toBe("succeeded");
    const created = f.journal.fixtures.creations(f.state.runId)[0]!;
    expect(created).toMatchObject({
      status: "owned",
      generation: 1,
      backend,
      clientStopEvidence: expect.any(String),
    });
    expect(created.plannedOid).toBeGreaterThanOrEqual(16384);
    expect(f.creator.create.mock.calls[0]?.[1]).toMatchObject({
      status: "reserved",
      backend: null,
      plannedOid: created.plannedOid,
      marker: created.marker,
    });
    expect(await f.dispatch(request)).toEqual(result);
    expect(f.creator.create).toHaveBeenCalledTimes(1);
    f.reopen();
    expect(f.journal.fixtures.creation(f.state.runId, created.creationId)).toEqual(created);
    expect(await f.dispatch(request)).toEqual(result);
    expect(
      f.journal
        .observations(f.state.runId, 0, 100)
        .filter((item) => item.kind === "fixture.creation_dispatch")[0]?.source,
    ).toBe("fixture-kernel");
  });
  it.each(["backend_live", "unmarked", "wrong_oid", "wrong_owner", "renamed", "disabled"] as const)(
    "preserves %s without adoption, re-creation or inventing stop",
    async (reason) => {
      const f = fixture();
      f.grant();
      f.creator.observe.mockImplementation(async (_def, record) => {
        const result = owned(record);
        if (reason === "backend_live") result.backendStopped = false;
        if (reason === "unmarked") result.database!.markerMatches = false;
        if (reason === "wrong_oid")
          result.database!.oid = String(record.plannedOid === 16384 ? 16385 : 16384);
        if (reason === "wrong_owner") result.database!.owner = "someone_else";
        if (reason === "renamed") result.database!.name = "user_renamed_it";
        if (reason === "disabled") result.database!.allowConnections = false;
        return result;
      });
      expect((await f.dispatch()).status).toBe("indeterminate");
      const created = f.journal.fixtures.creations(f.state.runId)[0]!;
      expect(created.status).toBe("uncertain");
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
      expect(f.creator.create).toHaveBeenCalledTimes(1);
      f.reopen();
      const result = await f.dispatch(
        f.request({ kind: "reconcile_fixture_creation", creationId: created.creationId }),
      );
      expect(result.status).toBe("succeeded");
      expect(f.journal.fixtures.creation(f.state.runId, created.creationId).status).toBe(
        "uncertain",
      );
      expect(f.creator.create).toHaveBeenCalledTimes(1);
    },
  );
  it("recovers a lost post-create observation on a new controller without replaying CREATE", async () => {
    const f = fixture();
    f.grant();
    f.creator.observe.mockRejectedValueOnce(new Error("lost observation"));
    const request = f.request();
    expect((await f.dispatch(request)).status).toBe("indeterminate");
    const created = f.journal.fixtures.creations(f.state.runId)[0]!;
    expect(created).toMatchObject({
      status: "dispatching",
      backend,
      clientStopEvidence: expect.any(String),
    });
    f.reopen();
    expect(
      (
        await f.dispatch(
          f.request({ kind: "reconcile_fixture_creation", creationId: created.creationId }),
        )
      ).status,
    ).toBe("succeeded");
    expect((await f.dispatch(request)).status).toBe("succeeded");
    expect(f.creator.create).toHaveBeenCalledTimes(1);
  });
  it("allows a new generation only after a stopped backend and absent resource are observed", async () => {
    const f = fixture();
    f.grant();
    f.creator.observe.mockResolvedValueOnce({ backendStopped: true, database: null });
    expect((await f.dispatch()).status).toBe("failed");
    expect(f.journal.fixtures.creations(f.state.runId)[0]?.status).toBe("not_created");
    expect((await f.dispatch()).status).toBe("rejected");
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
    ).toBe("succeeded");
    const [first, next] = f.journal.fixtures.creations(f.state.runId);
    expect(next?.generation).toBe(2);
    expect(next?.creationId).not.toBe(first?.creationId);
    expect(next?.marker).not.toBe(first?.marker);
  });
  it("closes an unused dispatch gate on cold reconciliation and rejects a late handshake", async () => {
    const f = fixture();
    f.grant();
    const temporary = new ActionKernel(f.journal);
    temporary.registerExternal("provision_declared_fixture", async ({ authority, record }) => {
      f.journal.fixtures.reserveCreation(authority, record.actionId);
      throw new Error("lost pre-dispatch result");
    });
    const request = f.request(),
      pending = await temporary.execute(request, f.authority);
    if (pending.status === "running") await temporary.operation(pending.operationId);
    const created = f.journal.fixtures.creations(f.state.runId)[0]!;
    f.reopen();
    expect(
      (
        await f.dispatch(
          f.request({ kind: "reconcile_fixture_creation", creationId: created.creationId }),
        )
      ).status,
    ).toBe("succeeded");
    expect((await f.dispatch(request)).status).toBe("failed");
    expect(() =>
      f.journal.fixtures.dispatchCreation(f.authority, created.creationId, backend),
    ).toThrow("one-use");
    expect(f.creator.create).not.toHaveBeenCalled();
    expect(f.creator.observe).not.toHaveBeenCalled();
  });
  it("revocation between handshake and dispatch prevents mutation despite provider readiness", async () => {
    const f = fixture(),
      grant = f.grant();
    let mutations = 0;
    f.creator.create.mockImplementation(async (_def, _record, dispatch) => {
      f.journal.fixtures.revoke(
        f.state.runId,
        f.journal.control(f.state.runId).controlVersion,
        grant.grantId,
      );
      dispatch(backend);
      mutations += 1;
    });
    expect((await f.dispatch()).status).toBe("failed");
    expect(mutations).toBe(0);
    expect(f.journal.fixtures.creations(f.state.runId)[0]).toMatchObject({
      status: "not_created",
      backend: null,
    });
  });
  it("rolls back a failed dispatch audit before allowing mutating SQL", async () => {
    const f = fixture();
    f.grant();
    let mutations = 0;
    f.creator.create.mockImplementation(async (_def, _record, dispatch) => {
      const db = new Database(f.path);
      try {
        db.exec(
          "CREATE TRIGGER fail_fixture_dispatch BEFORE INSERT ON observations WHEN json_extract(NEW.observation_json, '$.kind') = 'fixture.creation_dispatch' BEGIN SELECT RAISE(ABORT, 'audit failed'); END",
        );
        dispatch(backend);
        mutations += 1;
      } finally {
        db.exec("DROP TRIGGER fail_fixture_dispatch");
        db.close();
      }
    });
    expect((await f.dispatch()).status).toBe("failed");
    expect(mutations).toBe(0);
    expect(f.journal.fixtures.creations(f.state.runId)[0]).toMatchObject({
      status: "not_created",
      backend: null,
    });
  });
  it("preserves an already dispatched mutation when authority is revoked before observation", async () => {
    const f = fixture(),
      grant = f.grant();
    f.creator.create.mockImplementation(async (_def, _intent, dispatch) => {
      dispatch(backend);
      f.journal.fixtures.revoke(
        f.state.runId,
        f.journal.control(f.state.runId).controlVersion,
        grant.grantId,
      );
    });
    expect((await f.dispatch()).status).toBe("indeterminate");
    expect(f.journal.fixtures.creations(f.state.runId)[0]).toMatchObject({
      status: "dispatching",
      backend,
      clientStopEvidence: expect.any(String),
    });
    expect(f.creator.observe).not.toHaveBeenCalled();
    f.grant(["inspect"]);
    const creation = f.journal.fixtures.creations(f.state.runId)[0]!;
    expect(
      (
        await f.dispatch(
          f.request({ kind: "reconcile_fixture_creation", creationId: creation.creationId }),
        )
      ).status,
    ).toBe("succeeded");
    expect(f.journal.fixtures.creation(f.state.runId, creation.creationId).status).toBe("owned");
    expect(f.creator.create).toHaveBeenCalledTimes(1);
  });
  it.each(["reset", "cleanup"] as const)(
    "does not expose unimplemented %s mutations",
    async (operation) => {
      const f = fixture();
      f.grant();
      expect(
        await f.dispatch(
          f.request({
            kind: "provision_declared_fixture",
            fixtureId: f.definition.id,
            operation,
            expectedGeneration: 0,
          }),
        ),
      ).toMatchObject({ status: "rejected", code: "fixture_operation_unavailable" });
      expect(f.creator.create).not.toHaveBeenCalled();
      expect(f.journal.fixtures.creations(f.state.runId)).toEqual([]);
    },
  );
  it("refuses to prove old backend stop through a replacement PostgreSQL socket", async () => {
    const f = fixture();
    f.grant();
    await f.dispatch();
    const created = f.journal.fixtures.creations(f.state.runId)[0]!;
    await expect(
      new PostgreSqlFixtureCreator().observe(
        f.definition,
        created,
        { ...binding, socket: { ...binding.socket!, changeTimeNs: "2" } },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("different PostgreSQL socket");
  });
  it("takes a new READ COMMITTED catalog snapshot after its backend-stop query", async () => {
    const f = fixture();
    f.grant();
    await f.dispatch();
    const created = f.journal.fixtures.creations(f.state.runId)[0]!;
    const statements = fixtureCreationObservationSql(f.definition, created)
      .split(";")
      .map((sql) => sql.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
    expect(statements[1]).toContain("pg_stat_activity");
    expect(statements[1]).not.toContain("pg_database");
    expect(statements[2]).toContain("pg_database");
    expect(statements[2]).not.toContain("pg_stat_activity");
    expect(statements[3]).toBe("COMMIT");
  });
  it("rejects reconciliation without inspection authority, preserving an uncertain creation", async () => {
    const f = fixture();
    f.grant(["create"]);
    f.creator.observe.mockRejectedValueOnce(new Error("lost read"));
    const request = f.request();
    expect((await f.dispatch(request)).status).toBe("indeterminate");
    const created = f.journal.fixtures.creations(f.state.runId)[0]!;
    expect(
      await f.dispatch(
        f.request({ kind: "reconcile_fixture_creation", creationId: created.creationId }),
      ),
    ).toMatchObject({ status: "rejected", code: "fixture_grant_required" });
    expect(f.journal.fixtures.creation(f.state.runId, created.creationId)).toEqual(created);
    expect((await f.dispatch(request)).status).toBe("indeterminate");
    expect(f.creator.observe).toHaveBeenCalledTimes(1);
    expect(f.creator.create).toHaveBeenCalledTimes(1);
  });
});
