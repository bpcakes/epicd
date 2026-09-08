import { describe, expect, it } from "vitest";
import {
  fixtureBridgeArguments,
  fixtureBridgeEnvironment,
  fixtureBridgeTransport,
  type FixtureBridgeTransport,
} from "../src/adapters/fixture-bridge.js";

function transport(): FixtureBridgeTransport {
  const executable = { path: "/usr/bin/psql", device: "1", inode: "2", digest: "a".repeat(64) };
  return {
    definition: {
      id: "browser",
      provider: "postgresql",
      socketDirectory: "/run/fixture",
      port: 5432,
      role: "manager",
      database: "browser_test",
      expectedOwner: "fixture_role",
      operations: ["create"],
      environmentBinding: "browser",
      cleanup: "retain",
    },
    binding: {
      executable,
      directory: { path: "/run/fixture", device: "1", inode: "3" },
      socket: { path: "/run/fixture/.s.PGSQL.5432", device: "1", inode: "4", changeTimeNs: "5" },
    },
    validationRole: "fixture_role",
    listenPort: 55433,
    connectionVariable: "DATABASE_URL",
    pgbouncer: { ...executable, path: "/usr/sbin/pgbouncer", inode: "6" },
  };
}

describe("fixed fixture bridge transport contract", () => {
  it("uses a single explicit database/role and never enables wildcard or console authentication", () => {
    const bridge = transport();
    const args = fixtureBridgeArguments(
      bridge,
      ["--unshare-all"],
      [],
      ["--share-net", "--", "test"],
    );
    const script = args[args.indexOf("-c") + 1]!;
    expect(script).toContain(
      "browser_test = host=/epicd-upstream port=5432 dbname=browser_test user=fixture_role",
    );
    expect(script).toContain("auth_type = trust");
    expect(script).not.toContain("auth_type = any");
    expect(script).not.toContain("* =");
    expect(script).not.toContain("user=manager");
    expect(script).toContain("admin_users =\n");
    expect(script).toContain("stats_users =\n");
    expect(fixtureBridgeEnvironment(bridge)).toEqual({
      DATABASE_URL: "postgresql://fixture_role@127.0.0.1:55433/browser_test?sslmode=disable",
    });
  });

  it.each([
    "*",
    "pgbouncer",
    "postgres",
    "template0",
    "template1",
    "a\n[pgbouncer]",
    "a host=elsewhere",
    "a'",
    'a"',
    "a\\b",
  ])("rejects unsupported or reserved database %j before config interpolation", (database) => {
    const bridge = transport();
    bridge.definition.database = database;
    expect(() => fixtureBridgeTransport(bridge)).toThrow();
  });
  it.each([
    "pgbouncer",
    "role password=secret",
    'role" "secret',
    "role\nadmin_users=role",
    "role'",
  ])("rejects unsupported role %j", (role) => {
    expect(() => fixtureBridgeTransport({ ...transport(), validationRole: role })).toThrow();
  });
  it("rejects missing or redirected upstream sockets and reserved environment variables", () => {
    const bridge = transport();
    expect(() =>
      fixtureBridgeTransport({ ...bridge, binding: { ...bridge.binding, socket: null } }),
    ).toThrow();
    bridge.binding.socket!.path = "/run/another/.s.PGSQL.5432";
    expect(() => fixtureBridgeTransport(bridge)).toThrow();
    expect(() =>
      fixtureBridgeTransport({ ...transport(), connectionVariable: "LD_PRELOAD" }),
    ).toThrow();
  });
  it("owns a copy of admitted configuration", () => {
    const bridge = transport();
    const admitted = fixtureBridgeTransport(bridge);
    bridge.definition.database = "postgres";
    bridge.binding.socket!.path = "/run/elsewhere";
    expect(admitted.definition.database).toBe("browser_test");
    expect(admitted.binding.socket!.path).toBe("/run/fixture/.s.PGSQL.5432");
  });
});
