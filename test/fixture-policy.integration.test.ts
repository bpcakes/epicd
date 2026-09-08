import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { registerFixtureCapabilities } from "../src/kernel/fixtures.js";
import {
  FixtureTransportError,
  fixtureInspectionSql,
  type FixtureInspector,
} from "../src/adapters/fixtures.js";
import {
  FixtureDefinitionSchema,
  RepositoryPolicySchema,
} from "../src/domain/repository-policy.js";
import type { FixtureProviderBinding } from "../src/domain/fixtures.js";
import type { KernelAction } from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import { runStatusView } from "../src/status.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});
const definition = FixtureDefinitionSchema.parse({
  id: "browser-db",
  provider: "postgresql",
  socketDirectory: "/fixture-socket",
  port: 5432,
  role: "fixture_role",
  database: "disposable_browser",
  expectedOwner: "fixture_role",
  operations: ["create"],
  environmentBinding: "browser",
  cleanup: "retain",
});
const binding: FixtureProviderBinding = {
  executable: { path: "/usr/bin/psql", device: "1", inode: "2", digest: "a".repeat(64) },
  directory: { path: definition.socketDirectory, device: "1", inode: "3" },
  socket: { path: "/fixture-socket/.s.PGSQL.5432", device: "1", inode: "4", changeTimeNs: "1" },
};
const catalog = {
  serverVersion: "180000",
  role: definition.role,
  maintenanceDatabase: "postgres" as const,
  roleCanCreateDatabase: true,
  roleIsSuperuser: false,
  database: null,
};
function fixture(inspect = vi.fn<FixtureInspector["inspect"]>(async () => catalog)) {
  const root = mkdtempSync("/var/tmp/epicd-fixture-policy-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite3"),
    store = new StateStore(path);
  cleanups.push(() => store.close());
  const state = store.create(
    initialRun(),
    RepositoryPolicySchema.parse({ schemaVersion: 1, fixtures: [definition] }),
  );
  const lease = store.acquireLease(state.runId),
    authority = { runId: state.runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
  const journal = store.orchestration,
    kernel = new ActionKernel(journal);
  registerFixtureCapabilities(kernel, { inspect });
  const request = (
    action: KernelAction = { kind: "inspect_fixture", fixtureId: definition.id },
  ) => {
    const ticket = journal.beginDecision(
      authority,
      journal.latestObservationCursor(state.runId),
      journal.control(state.runId).controlVersion,
    );
    return {
      explanation: "Observe declared fixture without mutating it",
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
  const grant = () =>
    journal.fixtures.grant(state.runId, journal.control(state.runId).controlVersion, {
      fixtureId: definition.id,
      operations: ["inspect"],
      binding,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  return {
    root,
    path,
    store,
    state,
    journal,
    kernel,
    authority,
    inspect,
    request,
    dispatch,
    grant,
  };
}
describe("operator-scoped fixture inspection", () => {
  it("rejects unknown SQL access IDs as invalid requests without querying a provider", async () => {
    const f = fixture();
    for (const kind of ["inspect_fixture_access", "reconcile_fixture_access"] as const)
      expect(
        await f.dispatch(f.request({ kind, accessId: "11111111-1111-4111-8111-111111111111" })),
      ).toMatchObject({ status: "rejected", code: "unknown_fixture_access" });
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.journal.fixtures.validation.uses(f.state.runId)).toEqual([]);
  });
  it("does not convert repository declarations or conversational approval into a grant", async () => {
    const f = fixture();
    expect(await f.dispatch()).toMatchObject({
      status: "rejected",
      code: "fixture_grant_required",
    });
    expect(f.inspect).not.toHaveBeenCalled();
    await f.dispatch(
      f.request({
        kind: "escalate",
        question: "May I inspect the declared database?",
        reason: "authority",
        evidenceIds: [],
      }),
    );
    const pending = f.journal.pendingEscalation(f.state.runId)!;
    f.journal.operatorControl(f.state.runId, f.journal.control(f.state.runId).controlVersion, {
      kind: "respond",
      escalationId: pending.escalationId,
      message: "Yes, you have full permission",
    });
    expect(await f.dispatch()).toMatchObject({
      status: "rejected",
      code: "fixture_grant_required",
    });
    expect(f.journal.fixtures.grants(f.state.runId)).toEqual([]);
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it("records/replays the exact authorized observation without inferring ownership or validation access", async () => {
    const f = fixture(),
      grant = f.grant(),
      request = f.request();
    const result = await f.dispatch(request);
    expect(runStatusView(f.store, f.state.runId).fixtures.declarations).toEqual([definition]);
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded" || result.result.kind !== "inspection")
      throw new Error("Missing observation");
    expect(JSON.parse(result.result.text)).toMatchObject({
      grantId: grant.grantId,
      status: "database_absent",
      ownership: "not_established",
      environmentBindingAvailable: false,
      catalog,
    });
    expect(await f.dispatch(request)).toEqual(result);
    expect(f.inspect).toHaveBeenCalledTimes(1);
    expect(f.inspect).toHaveBeenCalledWith(
      definition,
      binding,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    const reopened = new StateStore(f.path);
    try {
      expect(reopened.orchestration.fixtures.grants(f.state.runId)).toEqual([grant]);
      expect(reopened.orchestration.action(f.state.runId, result.actionId)?.result).toEqual(result);
    } finally {
      reopened.close();
    }
  });
  it.each(["expired", "revoked", "paused", "wrong_operation", "undeclared"] as const)(
    "rejects %s authority before provider I/O",
    async (reason) => {
      const f = fixture();
      const grant = f.grant();
      if (reason === "expired")
        vi.spyOn(Date, "now").mockReturnValue(Date.parse(grant.expiresAt) + 1);
      if (reason === "revoked")
        f.journal.fixtures.revoke(
          f.state.runId,
          f.journal.control(f.state.runId).controlVersion,
          grant.grantId,
        );
      if (reason === "wrong_operation")
        f.journal.fixtures.grant(f.state.runId, f.journal.control(f.state.runId).controlVersion, {
          fixtureId: definition.id,
          operations: ["create"],
          binding,
          expiresAt: grant.expiresAt,
        });
      const request = f.request(
        reason === "undeclared"
          ? { kind: "inspect_fixture", fixtureId: "another-database" }
          : undefined,
      );
      if (reason === "paused")
        f.journal.operatorControl(f.state.runId, f.journal.control(f.state.runId).controlVersion, {
          kind: "pause",
        });
      expect((await f.dispatch(request)).status).toBe("rejected");
      expect(f.inspect).not.toHaveBeenCalled();
    },
  );
  it("rejects stale grants, wrong endpoints, excessive operations and expiry; failed grants do not change control", () => {
    const f = fixture(),
      version = f.journal.control(f.state.runId).controlVersion;
    const input = {
      fixtureId: definition.id,
      operations: ["inspect" as const],
      binding,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    for (const [observed, proposed] of [
      [version + 1, input],
      [
        version,
        {
          ...input,
          binding: { ...binding, directory: { ...binding.directory, path: "/wrong-socket" } },
        },
      ],
      [version, { ...input, operations: ["reset" as const] }],
      [version, { ...input, expiresAt: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString() }],
      [version, { ...input, expiresAt: new Date(Date.now() - 1).toISOString() }],
    ] as const)
      expect(() => f.journal.fixtures.grant(f.state.runId, observed, proposed)).toThrow();
    expect(f.journal.fixtures.grants(f.state.runId)).toEqual([]);
    expect(f.journal.control(f.state.runId).controlVersion).toBe(version);
  });
  it("rolls back replacement, control and observation if grant audit persistence fails", () => {
    const f = fixture(),
      previous = f.grant(),
      version = f.journal.control(f.state.runId).controlVersion;
    const db = new Database(f.path);
    try {
      db.exec(
        "CREATE TRIGGER fail_fixture_observation BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT, 'audit failed'); END",
      );
      expect(() => f.grant()).toThrow("audit failed");
      expect(f.journal.fixtures.grants(f.state.runId)).toEqual([previous]);
      expect(f.journal.control(f.state.runId).controlVersion).toBe(version);
    } finally {
      db.close();
    }
  });
  it("replacing a grant revokes the old identity, retains history and does not dismiss an escalation", async () => {
    const f = fixture(),
      old = f.grant();
    await f.dispatch(
      f.request({
        kind: "escalate",
        question: "Need authority",
        reason: "authority",
        evidenceIds: [],
      }),
    );
    const pending = f.journal.pendingEscalation(f.state.runId),
      replacement = f.grant();
    expect(f.journal.fixtures.grants(f.state.runId)).toMatchObject([
      { grantId: old.grantId, revokedAt: expect.any(String) },
      replacement,
    ]);
    expect(f.journal.pendingEscalation(f.state.runId)).toEqual(pending);
    expect(f.journal.control(f.state.runId).status).toBe("awaiting_user");
  });
  it("does not publish a late read after revocation or reuse a replacement grant for that read", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspect = vi.fn<FixtureInspector["inspect"]>(async () => {
      await pending;
      return catalog;
    });
    const f = fixture(inspect),
      grant = f.grant();
    const result = f.dispatch();
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    f.journal.fixtures.revoke(
      f.state.runId,
      f.journal.control(f.state.runId).controlVersion,
      grant.grantId,
    );
    f.grant();
    release();
    expect(await result).toMatchObject({ status: "rejected", code: "fixture_grant_required" });
  });
  it.each(["failure", "socket_missing", "present"] as const)(
    "keeps %s distinct from an absent database and does not adopt existing resources",
    async (status) => {
      const f = fixture(
        vi.fn<FixtureInspector["inspect"]>(async () => {
          if (status === "failure") throw new FixtureTransportError("Authentication failed");
          return status === "socket_missing"
            ? null
            : {
                ...catalog,
                database: {
                  oid: "1234",
                  name: definition.database,
                  owner: definition.expectedOwner,
                  canConnect: true,
                },
              };
        }),
      );
      f.grant();
      const result = await f.dispatch();
      if (status === "failure") expect(result.status).toBe("failed");
      else {
        if (result.status !== "succeeded" || result.result.kind !== "inspection")
          throw new Error("Missing result");
        expect(JSON.parse(result.result.text)).toMatchObject({
          status,
          ownership: "not_established",
          environmentBindingAvailable: false,
        });
      }
    },
  );
  it("encodes unusual PostgreSQL names as data rather than SQL and rejects byte-truncated names", () => {
    const name = "x'; DROP DATABASE postgres; --";
    const sql = fixtureInspectionSql(name);
    expect(sql).not.toContain(name);
    expect(sql).toContain(Buffer.from(name).toString("hex"));
    expect(sql).toContain("BEGIN READ ONLY;");
    expect(
      FixtureDefinitionSchema.safeParse({ ...definition, database: "é".repeat(32) }).success,
    ).toBe(false);
    expect(
      FixtureDefinitionSchema.safeParse({ ...definition, database: "bad\0name" }).success,
    ).toBe(false);
  });
  it.each(["grantId", "fixtureId", "runId"] as const)(
    "refuses corrupted indexed %s without granting provider access",
    async (field) => {
      const f = fixture(),
        grant = f.grant();
      const db = new Database(f.path);
      try {
        const record = {
          ...grant,
          [field]: field === "grantId" ? "00000000-0000-4000-8000-000000000000" : "another-owner",
        };
        db.prepare("UPDATE fixture_grants SET record_json = ? WHERE grant_id = ?").run(
          JSON.stringify(record),
          grant.grantId,
        );
        expect(() => f.journal.fixtures.authorize(f.state.runId, definition.id, "inspect")).toThrow(
          "indexed ownership",
        );
        expect(f.inspect).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    },
  );
  it("keeps grants run-scoped and preserves their raw authority history during quarantine", () => {
    const f = fixture(),
      grant = f.grant();
    const other = f.store.create(
      initialRun("other-fixture-run"),
      RepositoryPolicySchema.parse({ schemaVersion: 1, fixtures: [definition] }),
    );
    expect(() =>
      f.journal.fixtures.authorize(other.runId, definition.id, "inspect", grant.grantId),
    ).toThrow("operator grant");
    expect(() =>
      f.journal.fixtures.revoke(
        other.runId,
        f.journal.control(other.runId).controlVersion,
        grant.grantId,
      ),
    ).toThrow("belongs to the run");
    f.store.releaseLease(f.state.runId, f.authority.ownerToken);
    const db = new Database(f.path);
    try {
      db.prepare("UPDATE runs SET state_json = ? WHERE run_id = ?").run(
        "{invalid json",
        f.state.runId,
      );
      f.store.quarantineInvalidRun(f.state.runId);
      const rows = db
        .prepare(
          "SELECT row_json FROM quarantined_orchestration WHERE run_id = ? AND source_table = 'fixture_grants'",
        )
        .all(f.state.runId) as { row_json: string }[];
      expect(rows).toHaveLength(1);
      expect(JSON.parse(JSON.parse(rows[0]!.row_json).record_json)).toEqual(grant);
    } finally {
      db.close();
    }
  });
});
