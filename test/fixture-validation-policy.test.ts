import { describe, expect, it } from "vitest";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";

const fixture = {
  id: "host-db",
  provider: "postgresql",
  socketDirectory: "/run/postgresql",
  port: 5432,
  role: "fixture_manager",
  database: "browser_fixture",
  expectedOwner: "browser_role",
  operations: ["create"],
  environmentBinding: "browser",
  cleanup: "retain",
};
const access = {
  fixtureId: fixture.id,
  validationRole: fixture.expectedOwner,
  listenPort: 55432,
  connectionVariable: "DATABASE_URL",
  pgbouncerExecutable: "/usr/bin/pgbouncer",
};
const policy = { schemaVersion: 1, fixtures: [fixture], fixtureValidation: [access] };

describe("explicit fixture SQL policy", () => {
  it("keeps declaration separate from management authority and has no implicit SQL access", () => {
    expect(RepositoryPolicySchema.parse(policy).fixtureValidation).toEqual([access]);
    expect(
      RepositoryPolicySchema.parse({ schemaVersion: 1, fixtures: [fixture] }).fixtureValidation,
    ).toEqual([]);
  });
  it.each([
    { fixtureId: "absent" },
    { validationRole: "other_owner" },
    { validationRole: "pgbouncer" },
    { validationRole: "role;injection" },
    { listenPort: 80 },
    { connectionVariable: "PGOPTIONS" },
    { connectionVariable: "HOME" },
    { pgbouncerExecutable: "relative/pgbouncer" },
    { pgbouncerExecutable: "/usr/bin/pgbouncer\0" },
  ])("rejects mismatched or unbounded access declaration %j", (delta) => {
    expect(
      RepositoryPolicySchema.safeParse({ ...policy, fixtureValidation: [{ ...access, ...delta }] })
        .success,
    ).toBe(false);
  });
  it.each([
    "postgres",
    "template0",
    "template1",
    "pgbouncer",
    "database with spaces",
    "dbname;injection",
  ])("rejects an unsupported bridge database %s", (database) => {
    expect(
      RepositoryPolicySchema.safeParse({ ...policy, fixtures: [{ ...fixture, database }] }).success,
    ).toBe(false);
  });
  it("rejects repeated access declarations and ambiguous private service endpoints", () => {
    expect(
      RepositoryPolicySchema.safeParse({ ...policy, fixtureValidation: [access, access] }).success,
    ).toBe(false);
    const service = {
      id: "scratch",
      provider: "postgresql",
      lifetime: "check",
      binDirectory: "/usr/lib/postgresql/18/bin",
      database: "scratch_fixture",
      role: "scratch_role",
      port: 55433,
      connectionVariable: "SCRATCH_DATABASE_URL",
    };
    expect(
      RepositoryPolicySchema.safeParse({ ...policy, validationServices: [service] }).success,
    ).toBe(true);
    for (const delta of [
      { port: access.listenPort },
      { connectionVariable: access.connectionVariable },
    ])
      expect(
        RepositoryPolicySchema.safeParse({
          ...policy,
          validationServices: [{ ...service, ...delta }],
        }).success,
      ).toBe(false);
  });
});
