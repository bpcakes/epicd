import { describe, expect, it } from "vitest";
import {
  RepositoryPolicySchema,
  RequiredCheckSchema,
  ValidationServiceSchema,
  digestJson,
} from "../src/domain/repository-policy.js";
import { withValidationServices } from "../src/adapters/validation-services.js";

const service = {
  id: "browser",
  provider: "postgresql" as const,
  lifetime: "check" as const,
  binDirectory: "/usr/lib/postgresql/18/bin",
  database: "browser_test",
  role: "fixture_owner",
  port: 55432,
  connectionVariable: "DATABASE_URL",
};
describe("check-scoped service policy", () => {
  it.each([
    { lifetime: "run" },
    { binDirectory: "/home/user/pg" },
    { binDirectory: "/usr/lib/../pg" },
    { connectionVariable: "HOME" },
    { connectionVariable: "NODE_OPTIONS" },
    { database: "postgres" },
    { port: 80 },
  ])("rejects an unsupported or wider service declaration %j", (change) => {
    expect(ValidationServiceSchema.safeParse({ ...service, ...change }).success).toBe(false);
  });
  it("rejects ambiguous IDs, ports, variables and duplicate check bindings", () => {
    const policy = { schemaVersion: 1, validationServices: [service] };
    expect(RepositoryPolicySchema.parse(policy).validationServices).toEqual([service]);
    for (const second of [
      { ...service },
      { ...service, id: "other", connectionVariable: "TEST_DATABASE_URL" },
      { ...service, id: "other", port: 55433 },
    ])
      expect(
        RepositoryPolicySchema.safeParse({ ...policy, validationServices: [service, second] })
          .success,
      ).toBe(false);
    expect(
      RepositoryPolicySchema.safeParse({
        ...policy,
        fixtures: [
          {
            id: "host",
            provider: "postgresql",
            socketDirectory: "/var/run/postgresql",
            port: 5432,
            role: "host",
            database: "host_test",
            expectedOwner: "host",
            operations: ["create"],
            environmentBinding: service.id,
            cleanup: "retain",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      RequiredCheckSchema.safeParse({
        id: "test",
        command: "test",
        args: [],
        environmentBindings: [service.id, service.id],
      }).success,
    ).toBe(false);
  });
  it("does not wrap a command before its exact runtime is bound or substitute a different executable path", () => {
    const definition = ValidationServiceSchema.parse(service);
    const environment = {
      bindingId: service.id,
      instanceId: "11111111-1111-4111-8111-111111111111",
      generation: 1 as const,
      definitionDigest: digestJson(definition),
      runtime: null,
    };
    const request = {
      workspace: "/private/workspace",
      sourceMode: "read-only" as const,
      command: "/bin/true",
      args: [],
      timeoutMs: 1000,
    };
    expect(() => withValidationServices(request, [{ definition, environment }])).toThrow(
      "runtime binding",
    );
    const binary = { path: "/usr/bin/false", device: "1", inode: "1", digest: "a".repeat(64) };
    expect(() =>
      withValidationServices(request, [
        {
          definition,
          environment: {
            ...environment,
            runtime: { initdb: binary, pg_ctl: binary, postgres: binary, psql: binary },
          },
        },
      ]),
    ).toThrow("runtime path differs");
  });
});
