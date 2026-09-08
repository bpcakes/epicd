import { z } from "zod";
import { join } from "node:path";
import { FixtureExecutableSchema, FixtureProviderBindingSchema } from "../domain/fixtures.js";
import { digestJson, FixtureDefinitionSchema } from "../domain/repository-policy.js";
import { bindFixtureExecutable, bindFixtureProvider, FixtureTransportError } from "./fixtures.js";

// Deliberately narrower than PostgreSQL identifiers. These names enter PgBouncer's
// two distinct configuration grammars; do not treat them as libpq connection strings.
const BridgeName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
const FixtureBridgeTransportSchema = z.strictObject({
  definition: FixtureDefinitionSchema,
  binding: FixtureProviderBindingSchema,
  validationRole: BridgeName.refine((name) => name !== "pgbouncer"),
  listenPort: z.number().int().min(1024).max(65535),
  connectionVariable: z.string().regex(/^(?:[A-Z][A-Z0-9_]*_)?DATABASE_URL$/),
  pgbouncer: FixtureExecutableSchema,
});

/** Transport only, NOT an authorization grant or proof of safe SQL privileges.
 * A controller caller must separately authorize the exact resource generation and
 * restricted role, and establish remote backend stop before releasing that resource.
 * No public capability currently admits this transport to validation evidence.
 */
export type FixtureBridgeTransport = z.infer<typeof FixtureBridgeTransportSchema>;

export function fixtureBridgeTransport(input: FixtureBridgeTransport): FixtureBridgeTransport {
  const bridge = FixtureBridgeTransportSchema.parse(input);
  const { definition, binding } = bridge;
  BridgeName.parse(definition.database);
  if (
    ["postgres", "template0", "template1", "pgbouncer"].includes(definition.database) ||
    binding.directory.path !== definition.socketDirectory ||
    binding.socket?.path !== join(definition.socketDirectory, `.s.PGSQL.${definition.port}`)
  )
    throw new FixtureTransportError("Bridge requires one exact non-system fixture socket/database");
  return bridge;
}

export async function verifyFixtureBridgeTransport(input: FixtureBridgeTransport): Promise<void> {
  const bridge = fixtureBridgeTransport(input);
  const [provider, pgbouncer] = await Promise.all([
    bindFixtureProvider(bridge.definition, bridge.binding.executable.path),
    bindFixtureExecutable(bridge.pgbouncer.path),
  ]);
  if (
    digestJson(provider) !== digestJson(bridge.binding) ||
    digestJson(pgbouncer) !== digestJson(bridge.pgbouncer)
  )
    throw new FixtureTransportError(
      "Fixture bridge executable or upstream socket identity changed",
    );
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const ROOT = "/tmp/epicd-fixture-bridge";

export function fixtureBridgeEnvironment(input: FixtureBridgeTransport): Record<string, string> {
  const bridge = fixtureBridgeTransport(input);
  return {
    [bridge.connectionVariable]: `postgresql://${bridge.validationRole}@127.0.0.1:${bridge.listenPort}/${bridge.definition.database}?sslmode=disable`,
  };
}

/** Trusted outer namespace runs the broker; the command gets a new mount/PID
 * namespace sharing ONLY the private network. In particular it cannot see the
 * upstream socket, broker config or Unix admin socket, even through /proc.
 * PgBouncer's same-UID Unix admin bypass makes a directly exposed socket unsafe.
 */
export function fixtureBridgeArguments(
  input: FixtureBridgeTransport,
  systemArgs: readonly string[],
  outerWorkspaceArgs: readonly string[],
  innerArgs: readonly string[],
): string[] {
  const bridge = fixtureBridgeTransport(input);
  const { definition, binding } = bridge;
  const config = [
    "[databases]",
    `${definition.database} = host=/epicd-upstream port=${definition.port} dbname=${definition.database} user=${bridge.validationRole}`,
    "[pgbouncer]",
    "listen_addr = 127.0.0.1",
    `listen_port = ${bridge.listenPort}`,
    `unix_socket_dir = ${ROOT}`,
    "unix_socket_mode = 0700",
    "auth_type = trust",
    `auth_file = ${ROOT}/users.txt`,
    // libevent/c-ares initialize a resolver even for our fixed Unix upstream.
    // Supply private inert configuration, never the host's resolver or network.
    `resolv_conf = ${ROOT}/resolv.conf`,
    "admin_users =",
    "stats_users =",
    "pool_mode = session",
    "max_client_conn = 32",
    "default_pool_size = 16",
    "reserve_pool_size = 0",
    "server_connect_timeout = 5",
    "server_login_retry = 1",
    "client_login_timeout = 5",
    "server_reset_query = DISCARD ALL",
    "server_tls_sslmode = disable",
    "client_tls_sslmode = disable",
    "log_connections = 0",
    "log_disconnections = 0",
    "log_stats = 0",
    "",
  ].join("\n");
  const probe = [
    "/epicd-bridge-psql",
    "-X",
    "-w",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
    "--host",
    "127.0.0.1",
    "--port",
    String(bridge.listenPort),
    "--username",
    bridge.validationRole,
    "--dbname",
    definition.database,
    "--command",
    "SELECT 1",
  ]
    .map(quote)
    .join(" ");
  // Everything here is kernel-supplied argv/data. Repository commands execute
  // only after the inner bwrap has removed all broker mounts and process visibility.
  const script = [
    "set -eu",
    "umask 077",
    "ulimit -c 0",
    `/bin/mkdir -m 700 ${ROOT}`,
    `/usr/bin/printf 'nameserver 127.0.0.1\\n' >${ROOT}/resolv.conf`,
    `/usr/bin/printf '%s' ${quote(config)} >${ROOT}/pgbouncer.ini`,
    `/usr/bin/printf '%s\\n' ${quote(`"${bridge.validationRole}" ""`)} >${ROOT}/users.txt`,
    `/epicd-pgbouncer ${ROOT}/pgbouncer.ini >&2 &`,
    "bridge_pid=$!",
    "bridge_ready=0",
    "for ((bridge_attempt=0; bridge_attempt<50; bridge_attempt++)); do",
    `  if ${probe} >${ROOT}/probe.out 2>${ROOT}/probe.err; then bridge_ready=1; break; fi`,
    '  if ! kill -0 "$bridge_pid" 2>/dev/null; then break; fi',
    "  /bin/sleep 0.1",
    "done",
    `if [[ "$bridge_ready" != 1 ]]; then /bin/cat ${ROOT}/probe.err >&2; exit 125; fi`,
    // ro-bind-data uses an anonymous backing file, which cannot be re-bind-mounted
    // by nested bwrap. Supply its contents on a fresh, consumed setup descriptor.
    '"$@" 3</etc/passwd &',
    "bridge_command_pid=$!",
    "bridge_status=0",
    'wait -n -p bridge_finished_pid "$bridge_pid" "$bridge_command_pid" || bridge_status=$?',
    // Early broker death must never be reported as successful command completion.
    'if [[ "$bridge_finished_pid" != "$bridge_command_pid" ]]; then exit 125; fi',
    'exit "$bridge_status"',
  ].join("\n");
  return [
    ...systemArgs,
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/tmp/epicd-home",
    ...outerWorkspaceArgs,
    "--ro-bind-data",
    "3",
    "/etc/passwd",
    "--ro-bind",
    binding.socket!.path,
    `/epicd-upstream/.s.PGSQL.${definition.port}`,
    "--ro-bind",
    binding.executable.path,
    "/epicd-bridge-psql",
    "--ro-bind",
    bridge.pgbouncer.path,
    "/epicd-pgbouncer",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/tmp/epicd-home",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "PGCONNECT_TIMEOUT",
    "1",
    "--chdir",
    "/tmp",
    "--",
    "/bin/bash",
    "-c",
    script,
    "epicd-fixture-bridge",
    "/usr/bin/bwrap",
    ...innerArgs,
  ];
}
