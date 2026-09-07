import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { bindFixtureExecutable } from "./fixtures.js";
import {
  digestJson,
  ValidationServiceSchema,
  type ValidationService,
} from "../domain/repository-policy.js";
import {
  ValidationEnvironmentSchema,
  ValidationServiceRuntimeSchema,
  type ValidationEnvironment,
  type ValidationServiceRuntime,
} from "../domain/delivery.js";
import type { ConfinedCommand } from "./sandbox.js";

export async function bindValidationService(
  input: ValidationService,
): Promise<ValidationServiceRuntime> {
  const service = ValidationServiceSchema.parse(input);
  if ((await realpath(service.binDirectory)) !== service.binDirectory)
    throw new Error("Validation service executables must use a canonical /usr directory");
  const binaries = await Promise.all(
    ["initdb", "pg_ctl", "postgres", "psql"].map(async (name) => [
      name,
      await bindFixtureExecutable(join(service.binDirectory, name)),
    ]),
  );
  return ValidationServiceRuntimeSchema.parse(Object.fromEntries(binaries));
}

export type BoundValidationService = {
  definition: ValidationService;
  environment: ValidationEnvironment;
};

export async function verifyValidationServices(
  services: readonly BoundValidationService[],
): Promise<void> {
  for (const { definition, environment } of services) {
    if (
      digestJson(definition) !== environment.definitionDigest ||
      !environment.runtime ||
      digestJson(await bindValidationService(definition)) !== digestJson(environment.runtime)
    )
      throw new Error(
        "Validation service runtime changed; the check cannot supply environment evidence",
      );
  }
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';

/** Fixed setup inside the existing outer sandbox, then exec the unchanged check argv.
 * No host service socket, data directory, credential or network namespace is exposed.
 * The outer PID namespace owns server stop on success, failure, timeout and controller death.
 */
export function withValidationServices(
  request: ConfinedCommand,
  services: readonly BoundValidationService[],
): ConfinedCommand {
  if (!services.length) return request;
  if (request.sourceMode !== "read-only")
    throw new Error("Check-scoped services require read-only validation source");
  const lines = [
    "set -eu",
    "umask 077",
    'provider() { /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp/epicd-home LANG=C.UTF-8 "$@"; }',
  ];
  for (const entry of services) {
    const definition = ValidationServiceSchema.parse(entry.definition);
    const environment = ValidationEnvironmentSchema.parse(entry.environment);
    if (
      environment.bindingId !== definition.id ||
      environment.definitionDigest !== digestJson(definition) ||
      !environment.runtime
    )
      throw new Error("Validation service needs its exact recorded definition/runtime binding");
    for (const name of ["initdb", "pg_ctl", "postgres", "psql"] as const)
      if (environment.runtime[name].path !== join(definition.binDirectory, name))
        throw new Error("Validation service runtime path differs from frozen policy");
    const root = `/tmp/epicd-postgresql-${environment.instanceId}`;
    const data = `${root}/data`,
      log = `${root}/server.log`;
    const init = [
      environment.runtime.initdb.path,
      "--pgdata",
      data,
      "--username",
      definition.role,
      "--encoding=UTF8",
      "--locale=C.UTF-8",
      "--auth-local=trust",
      "--auth-host=trust",
      "--no-sync",
    ];
    const start = [
      environment.runtime.pg_ctl.path,
      "--pgdata",
      data,
      "--log",
      log,
      "--wait",
      "--timeout=20",
      "--options",
      `-h 127.0.0.1 -k ${root} -p ${definition.port} -c max_connections=32 -c shared_buffers=16MB -c fsync=off`,
      "start",
    ];
    const create = [
      environment.runtime.psql.path,
      "-X",
      "-w",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      root,
      "--port",
      String(definition.port),
      "--username",
      definition.role,
      "--dbname",
      "postgres",
      "--command",
      `CREATE DATABASE ${identifier(definition.database)} OWNER ${identifier(definition.role)} TEMPLATE template0;`,
    ];
    lines.push(
      `/bin/mkdir -m 700 ${quote(root)}`,
      `if ! provider ${init.map(quote).join(" ")} >${quote(`${root}/init.log`)} 2>&1; then /bin/cat ${quote(`${root}/init.log`)} >&2; exit 125; fi`,
      `if ! provider ${start.map(quote).join(" ")} >${quote(`${root}/start.log`)} 2>&1; then /bin/cat ${quote(`${root}/start.log`)} ${quote(log)} >&2; exit 125; fi`,
      `if ! provider ${create.map(quote).join(" ")}; then exit 125; fi`,
      `export ${definition.connectionVariable}=${quote(`postgresql://${encodeURIComponent(definition.role)}@127.0.0.1:${definition.port}/${encodeURIComponent(definition.database)}?sslmode=disable`)}`,
    );
  }
  lines.push('exec "$@"');
  return {
    ...request,
    syntheticUser: true,
    command: "/bin/sh",
    args: ["-c", lines.join("\n"), "epicd-validation-services", request.command, ...request.args],
  };
}
