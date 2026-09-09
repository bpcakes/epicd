import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { RunOperator } from "../src/operator-controls.js";
import * as bindings from "../src/adapters/fixtures.js";
import { operatorFixture } from "./fixtures/operator.js";

afterEach(() => vi.restoreAllMocks());
describe.runIf(process.platform === "linux")("shared operator control boundary", () => {
  it("routes compiled grant and revoke commands through the same exact-resource boundary", async () => {
    const f = await operatorFixture();
    const cli = (...args: string[]) => {
      const result = spawnSync(
        process.execPath,
        ["dist/cli.js", ...args, "--state", f.path, "--control-version", String(f.version())],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status, result.stderr).toBe(0);
    };
    cli(
      "grant-fixture",
      f.state.runId,
      "browser-db",
      "--operations",
      "inspect,create",
      "--expires-at",
      f.expiry(),
      "--psql-path",
      f.executable,
    );
    const management = f.store.orchestration.fixtures.grants(f.state.runId)[0]!;
    expect(management.operations).toEqual(["inspect", "create"]);
    expect(f.store.orchestration.fixtures.validation.grants(f.state.runId)).toEqual([]);
    cli(
      "grant-fixture-validation",
      f.state.runId,
      "browser-db",
      "--expires-at",
      f.expiry(),
      "--psql-path",
      f.executable,
    );
    const sql = f.store.orchestration.fixtures.validation.grants(f.state.runId)[0]!;
    expect(sql.fixtureId).toBe("browser-db");
    cli("revoke-fixture-grant", f.state.runId, management.grantId);
    expect(f.store.orchestration.fixtures.grants(f.state.runId)[0]!.revokedAt).not.toBeNull();
    expect(
      f.store.orchestration.fixtures.validation.grants(f.state.runId)[0]!.revokedAt,
    ).toBeNull();
    cli("revoke-fixture-validation", f.state.runId, sql.grantId);
    expect(
      f.store.orchestration.fixtures.validation.grants(f.state.runId)[0]!.revokedAt,
    ).not.toBeNull();
    expect(f.store.orchestration.fixtures.creations(f.state.runId)).toEqual([]);
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
    expect(f.connections).toBe(0);
  });

  it("reads without a lease and answers only the observed question without granting authority", async () => {
    const f = await operatorFixture(),
      before = f.operator.status();
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
    expect(f.operator.status()).toEqual(before);
    const escalationId = f.question(),
      controlVersion = f.version();
    await expect(
      f.operator.submit({ kind: "respond", controlVersion, escalationId: "wrong", message: "yes" }),
    ).rejects.toThrow("Escalation changed");
    expect(f.operator.status().escalation?.escalationId).toBe(escalationId);
    await expect(
      f.operator.submit({
        kind: "respond",
        controlVersion,
        escalationId,
        message: "Yes, inspect the declared fixture",
      }),
    ).resolves.toContain("not an environment grant");
    expect(f.operator.status().escalation).toBeNull();
    expect(f.store.orchestration.fixtures.grants(f.state.runId)).toEqual([]);
    expect(f.store.orchestration.fixtures.validation.grants(f.state.runId)).toEqual([]);
    expect(f.store.orchestration.agents.instances(f.state.runId)).toEqual([]);
    expect(f.connections).toBe(0);
  });

  it("grants and revokes management and SQL authority separately without querying or adopting a resource", async () => {
    const f = await operatorFixture(),
      escalationId = f.question();
    await f.operator.submit({
      kind: "grant_fixture",
      fixtureId: "browser-db",
      operations: ["inspect", "create"],
      controlVersion: f.version(),
      expiresAt: f.expiry(),
      psqlPath: f.executable,
    });
    const management = f.store.orchestration.fixtures.grants(f.state.runId)[0]!;
    expect(management.operations).toEqual(["inspect", "create"]);
    expect(f.operator.status().escalation?.escalationId).toBe(escalationId);
    expect(f.store.orchestration.fixtures.validation.grants(f.state.runId)).toEqual([]);
    await f.operator.submit({
      kind: "grant_sql",
      fixtureId: "browser-db",
      controlVersion: f.version(),
      expiresAt: f.expiry(),
      psqlPath: f.executable,
    });
    const sql = f.store.orchestration.fixtures.validation.grants(f.state.runId)[0]!;
    expect(sql.binding.socket?.path).toBe(`${f.root}/.s.PGSQL.5432`);
    expect(f.store.orchestration.fixtures.creations(f.state.runId)).toEqual([]);
    expect(f.operator.status().fixtures.authority[0]!.environmentBindingAvailable).toBe(false);
    await f.operator.submit({
      kind: "revoke_fixture",
      controlVersion: f.version(),
      grantId: management.grantId,
    });
    expect(f.store.orchestration.fixtures.grants(f.state.runId)[0]!.revokedAt).not.toBeNull();
    expect(
      f.store.orchestration.fixtures.validation.grants(f.state.runId)[0]!.revokedAt,
    ).toBeNull();
    await f.operator.submit({
      kind: "revoke_sql",
      controlVersion: f.version(),
      grantId: sql.grantId,
    });
    expect(
      f.store.orchestration.fixtures.validation.grants(f.state.runId)[0]!.revokedAt,
    ).not.toBeNull();
    expect(f.operator.status().escalation?.escalationId).toBe(escalationId);
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
    expect(f.connections).toBe(0);
  });

  it("refuses stale authority before preflight and does not steal a live controller lease to pause", async () => {
    const f = await operatorFixture(),
      lease = f.store.acquireLease(f.state.runId);
    const bind = vi.spyOn(bindings, "bindFixtureProvider");
    await f.operator.submit({ kind: "pause", controlVersion: f.version() });
    await expect(
      f.operator.submit({
        kind: "grant_fixture",
        fixtureId: "browser-db",
        operations: ["inspect"],
        controlVersion: 0,
        expiresAt: f.expiry(),
        psqlPath: f.executable,
      }),
    ).rejects.toThrow("Control changed");
    expect(bind).not.toHaveBeenCalled();
    expect(f.store.controllerLease(f.state.runId)?.leaseId).toBe(lease.leaseId);
    expect(f.operator.status().control.status).toBe("paused");
    f.store.releaseLease(f.state.runId, lease.ownerToken);
  });

  it.each(["version", "cancel"] as const)(
    "rechecks %s after asynchronous binding without recording a grant",
    async (fault) => {
      const f = await operatorFixture(),
        signal = new AbortController(),
        original = bindings.bindFixtureProvider;
      vi.spyOn(bindings, "bindFixtureProvider").mockImplementation(async (...args) => {
        const bound = await original(...args);
        if (fault === "cancel") signal.abort(new Error("Console closed during binding"));
        else f.store.orchestration.operatorControl(f.state.runId, f.version(), { kind: "pause" });
        return bound;
      });
      await expect(
        f.operator.submit(
          {
            kind: "grant_fixture",
            fixtureId: "browser-db",
            operations: ["inspect"],
            controlVersion: f.version(),
            expiresAt: f.expiry(),
            psqlPath: f.executable,
          },
          signal.signal,
        ),
      ).rejects.toThrow(fault === "cancel" ? "Console closed" : "Control changed");
      expect(f.store.orchestration.fixtures.grants(f.state.runId)).toEqual([]);
      expect(f.connections).toBe(0);
    },
  );

  it("drains an admitted request on close and rejects a second request while binding is pending", async () => {
    const f = await operatorFixture(),
      original = bindings.bindFixtureProvider;
    let release!: () => void, announce!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    vi.spyOn(bindings, "bindFixtureProvider").mockImplementation(async (...args) => {
      announce();
      await gate;
      return original(...args);
    });
    const signal = new AbortController();
    const work = f.operator.submit(
      {
        kind: "grant_fixture",
        fixtureId: "browser-db",
        operations: ["inspect"],
        controlVersion: f.version(),
        expiresAt: f.expiry(),
        psqlPath: f.executable,
      },
      signal.signal,
    );
    const rejected = expect(work).rejects.toThrow("closed");
    let drained = false;
    try {
      await started;
      await expect(
        f.operator.submit({ kind: "pause", controlVersion: f.version() }),
      ).rejects.toThrow("still settling");
      const draining = f.operator.settle().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      signal.abort(new Error("closed"));
      release();
      await rejected;
      await draining;
      expect(drained).toBe(true);
      expect(f.operator.status().control.status).toBe("active");
      expect(f.store.orchestration.fixtures.grants(f.state.runId)).toEqual([]);
    } finally {
      release();
      await work.catch(() => {});
    }
  });

  it("refuses expired, undeclared and excessive grants through the shared kernel", async () => {
    const f = await operatorFixture();
    for (const override of [
      { expiresAt: "2000-01-01T00:00:00.000Z" },
      { fixtureId: "not-declared" },
      { operations: ["cleanup"] as const },
    ]) {
      await expect(
        f.operator.submit({
          kind: "grant_fixture",
          fixtureId: "browser-db",
          controlVersion: f.version(),
          expiresAt: f.expiry(),
          psqlPath: f.executable,
          ...override,
          operations: override.operations ? [...override.operations] : ["inspect"],
        }),
      ).rejects.toThrow();
      expect(f.store.orchestration.fixtures.grants(f.state.runId)).toEqual([]);
    }
    expect(f.connections).toBe(0);
  });

  it("refuses runtime handoff owned by a live controller without changing settings or authority", async () => {
    const f = await operatorFixture(),
      lease = f.store.acquireLease(f.state.runId),
      before = f.store.get(f.state.runId);
    await expect(
      new RunOperator(f.store, f.state.runId).submit({
        kind: "handoff",
        runtime: "herdr",
        controlVersion: f.version(),
      }),
    ).rejects.toThrow();
    expect(f.store.get(f.state.runId)).toEqual(before);
    expect(f.store.controllerLease(f.state.runId)?.leaseId).toBe(lease.leaseId);
    f.store.releaseLease(f.state.runId, lease.ownerToken);
  });
});
