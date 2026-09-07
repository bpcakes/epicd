import { startNamespaceProcess } from "./pid-namespace.js";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { digestJson, type FixtureDefinition } from "../domain/repository-policy.js";
import {
  FixtureBackendSchema,
  FixtureCreationObservationSchema,
  type FixtureBackend,
  type FixtureCreation,
  type FixtureCreationObservation,
  type FixtureProviderBinding,
} from "../domain/fixtures.js";
import { bindFixtureProvider, FixtureTransportError } from "./fixtures.js";
import { redactSensitiveText } from "../util/redact.js";

export interface FixtureCreationProvider {
  create(
    definition: FixtureDefinition,
    intent: FixtureCreation,
    dispatch: (backend: FixtureBackend) => void,
    guard: () => void,
    signal: AbortSignal,
  ): Promise<void>;
  observe(
    definition: FixtureDefinition,
    intent: FixtureCreation,
    binding: FixtureProviderBinding,
    guard: () => void,
    signal: AbortSignal,
  ): Promise<FixtureCreationObservation>;
}
const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const value = (text: string) =>
  `pg_catalog.convert_from(pg_catalog.decode('${Buffer.from(text).toString("hex")}', 'hex'), 'UTF8')`;
const ReadySchema = z.strictObject({
  kind: z.literal("fixture_ready"),
  creationId: z.uuid(),
  backend: FixtureBackendSchema,
  role: z.string(),
  locked: z.boolean(),
  absent: z.boolean(),
  oidUnused: z.boolean(),
  ownerAuthorized: z.boolean(),
  canCreate: z.boolean(),
});

export function fixtureCreationHandshake(
  definition: FixtureDefinition,
  intent: FixtureCreation,
): string {
  // PostgreSQL advisory locks are server-local. Derive the key from the exact DB name,
  // not a state-file/run/socket spelling, so independent controllers serialize too.
  const hash = createHash("sha256").update(`epicd-fixture:${definition.database}`).digest();
  return `SELECT pg_catalog.json_build_object(
    'kind', 'fixture_ready', 'creationId', ${literal(intent.creationId)}, 'role', current_user,
    'backend', pg_catalog.json_build_object('pid', pg_catalog.pg_backend_pid(), 'startedAt', (SELECT EXTRACT(EPOCH FROM backend_start)::text FROM pg_catalog.pg_stat_activity WHERE pid = pg_catalog.pg_backend_pid())),
    'locked', pg_catalog.pg_try_advisory_lock(${hash.readInt32BE(0)}, ${hash.readInt32BE(4)}),
    'absent', NOT EXISTS(SELECT FROM pg_catalog.pg_database WHERE datname = ${value(definition.database)}),
    'oidUnused', NOT EXISTS(SELECT FROM pg_catalog.pg_database WHERE oid = ${intent.plannedOid}),
    'ownerAuthorized', EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname = ${value(definition.expectedOwner)} AND pg_catalog.pg_has_role(current_user, oid, 'USAGE') AND pg_catalog.pg_has_role(current_user, oid, 'SET')),
    'canCreate', (SELECT rolcreatedb OR rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user));\n`;
}

export function fixtureCreationScript(
  definition: FixtureDefinition,
  intent: FixtureCreation,
): string {
  const database = ident(definition.database),
    alias = ident(intent.alias);
  // CREATE cannot be in a transaction. The planned OID belongs to the durable
  // intent before dispatch. A transaction-only rename acquires the database's
  // AccessExclusiveLock before checking OID/owner/comment; mismatches roll back
  // the rename without overwriting a concurrent user's metadata.
  return `CREATE DATABASE ${database} OWNER ${ident(definition.expectedOwner)} TEMPLATE template0 OID ${intent.plannedOid} ALLOW_CONNECTIONS false;
BEGIN;
ALTER DATABASE ${database} RENAME TO ${alias};
DO $epicd$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid = d.datdba
    WHERE d.datname = ${value(intent.alias)} AND d.oid = ${intent.plannedOid} AND r.rolname = ${value(definition.expectedOwner)}
      AND NOT d.datallowconn AND pg_catalog.shobj_description(d.oid, 'pg_database') IS NULL)
  THEN RAISE EXCEPTION 'Fixture creation identity or metadata changed; preserve the database'; END IF;
END $epicd$;
COMMENT ON DATABASE ${alias} IS ${literal(intent.marker)};
ALTER DATABASE ${alias} ALLOW_CONNECTIONS true;
ALTER DATABASE ${alias} RENAME TO ${database};
COMMIT;
`;
}

export function fixtureCreationObservationSql(
  definition: FixtureDefinition,
  intent: FixtureCreation,
): string {
  if (!intent.backend) throw new FixtureTransportError("No recorded creation backend to reconcile");
  // These MUST be separate READ COMMITTED statements. A single statement can
  // acquire its catalog snapshot before CREATE commits, then observe the backend
  // disappear, incorrectly pairing "stopped" with stale "absent" evidence.
  return `BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY;
SELECT pg_catalog.json_build_object(
  'backendStopped', NOT EXISTS(SELECT FROM pg_catalog.pg_stat_activity WHERE pid = ${intent.backend.pid}
    AND (backend_start IS NULL OR EXTRACT(EPOCH FROM backend_start)::text = ${literal(intent.backend.startedAt)})));
SELECT pg_catalog.json_build_object(
  'database', (SELECT pg_catalog.json_build_object('oid', d.oid::text, 'name', d.datname, 'owner', r.rolname,
    'markerMatches', pg_catalog.shobj_description(d.oid, 'pg_database') IS NOT DISTINCT FROM ${literal(intent.marker)},
    'allowConnections', d.datallowconn)
    FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid = d.datdba
    WHERE d.oid = ${intent.plannedOid} OR d.datname = ${value(definition.database)}
    ORDER BY (d.oid = ${intent.plannedOid}) DESC LIMIT 1));
COMMIT;\n`;
}

/** One non-reconnecting psql session; the kernel authorizes mutation only after its backend is bound. */
export class PostgreSqlFixtureCreator implements FixtureCreationProvider {
  constructor(private readonly bwrapPath = "/usr/bin/bwrap") {}
  async create(
    definition: FixtureDefinition,
    intent: FixtureCreation,
    dispatch: (backend: FixtureBackend) => void,
    guard: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    let received = false;
    await this.session(
      definition,
      intent.binding,
      false,
      fixtureCreationHandshake(definition, intent),
      (line) => {
        if (received) throw new FixtureTransportError("Unexpected additional creation handshake");
        const ready = ReadySchema.parse(JSON.parse(line));
        if (ready.creationId !== intent.creationId || ready.role !== definition.role)
          throw new FixtureTransportError(
            "Creation handshake has another role or operation identity",
          );
        received = true;
        if (
          !ready.locked ||
          !ready.absent ||
          !ready.oidUnused ||
          !ready.ownerAuthorized ||
          !ready.canCreate
        )
          throw new FixtureTransportError(
            "Fixture creation preflight denied: target/identifier exists, ownership privilege is missing, or another session owns the fixture lock; nothing was created",
          );
        guard();
        dispatch(ready.backend); // Durable one-use gate, before any mutating SQL enters stdin.
        guard();
        return fixtureCreationScript(definition, intent);
      },
      guard,
      signal,
    );
    if (!received) throw new FixtureTransportError("Provider closed before a creation handshake");
  }
  async observe(
    definition: FixtureDefinition,
    intent: FixtureCreation,
    binding: FixtureProviderBinding,
    guard: () => void,
    signal: AbortSignal,
  ): Promise<FixtureCreationObservation> {
    if (
      digestJson({ directory: binding.directory, socket: binding.socket }) !==
      digestJson({ directory: intent.binding.directory, socket: intent.binding.socket })
    )
      throw new FixtureTransportError(
        "A different PostgreSQL socket cannot prove the original backend stopped; preserve the creation",
      );
    const output = await this.session(
      definition,
      binding,
      true,
      fixtureCreationObservationSql(definition, intent),
      null,
      guard,
      signal,
    );
    try {
      const [stop, resource] = z
        .tuple([
          z.strictObject({ backendStopped: z.boolean() }),
          z.strictObject({ database: FixtureCreationObservationSchema.shape.database }),
        ])
        .parse(
          output
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        );
      return FixtureCreationObservationSchema.parse({ ...stop, ...resource });
    } catch {
      throw new FixtureTransportError(
        "Invalid creation observation; ownership and backend stop remain unproven",
      );
    }
  }
  private async session(
    definition: FixtureDefinition,
    binding: FixtureProviderBinding,
    readOnly: boolean,
    initial: string,
    onHandshake: ((line: string) => string) | null,
    guard: () => void,
    signal: AbortSignal,
  ): Promise<string> {
    const assertBinding = async () => {
      if (
        digestJson(await bindFixtureProvider(definition, binding.executable.path)) !==
        digestJson(binding)
      )
        throw new FixtureTransportError(
          "Fixture provider/socket changed; request a new explicit grant",
        );
      if (!binding.socket)
        throw new FixtureTransportError("The granted PostgreSQL socket is absent");
      guard();
      signal.throwIfAborted();
    };
    await assertBinding();
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--ro-bind",
      "/usr",
      "/usr",
    ];
    for (const path of ["/bin", "/sbin", "/lib", "/lib64", "/etc/ld.so.cache"]) {
      try {
        await lstat(path);
        args.push("--ro-bind", path, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    args.push(
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/tmp/epicd-home",
      "--dir",
      "/epicd-pg",
      "--ro-bind",
      binding.socket!.path,
      `/epicd-pg/.s.PGSQL.${definition.port}`,
      "--ro-bind",
      binding.executable.path,
      "/epicd-psql",
      "--clearenv",
      "--setenv",
      "HOME",
      "/tmp/epicd-home",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--setenv",
      "PGCONNECT_TIMEOUT",
      "5",
      "--setenv",
      "PGOPTIONS",
      `-c default_transaction_read_only=${readOnly ? "on" : "off"} -c statement_timeout=30000 -c lock_timeout=1000 -c search_path=pg_catalog -c timezone=UTC -c standard_conforming_strings=on`,
      "--chdir",
      "/tmp",
      "--",
      "/epicd-psql",
      "-X",
      "-w",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      "/epicd-pg",
      "--port",
      String(definition.port),
      "--username",
      definition.role,
      "--dbname",
      "postgres",
      "--file",
      "-",
    );
    await assertBinding();
    const output = await new Promise<string>((resolve, reject) => {
      const namespace = startNamespaceProcess(this.bwrapPath, args, {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        stdio: "pipe",
        stdin: "pipe",
      });
      const { child } = namespace;
      let failure: Error | null = null,
        bytes = 0,
        errorBytes = 0,
        pending = "",
        answered = false;
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      const decoder = new StringDecoder("utf8");
      const stop = (error: Error) => {
        failure ??= error;
        namespace.interrupt();
      };
      const abort = () =>
        stop(
          new FixtureTransportError(
            "Fixture session interrupted; server-side reconciliation is required after dispatch",
          ),
        );
      signal.addEventListener("abort", abort, { once: true });
      const health = setInterval(() => {
        try {
          guard();
        } catch (error) {
          stop(error instanceof Error ? error : new Error("Fixture authority changed"));
        }
      }, 100);
      const timeout = setTimeout(
        () => stop(new FixtureTransportError("Fixture session exceeded 60 seconds")),
        60_000,
      );
      child.on("error", (error) => {
        failure = error;
      });
      child.stdin!.on("error", (error) => stop(error));
      child.stderr!.on("data", (chunk: Buffer) => {
        errorBytes += chunk.length;
        if (errorBytes <= 65536) stderr.push(chunk);
        else stop(new FixtureTransportError("Fixture error output exceeded its bound"));
      });
      child.stdout!.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65536) {
          stop(new FixtureTransportError("Fixture output exceeded its bound"));
          return;
        }
        stdout.push(chunk);
        if (!onHandshake) return;
        pending += decoder.write(chunk);
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          try {
            if (answered || failure)
              throw new FixtureTransportError("Duplicate or late PostgreSQL handshake");
            const script = onHandshake(line);
            answered = true;
            child.stdin!.end(script);
          } catch (error) {
            stop(error instanceof Error ? error : new Error("Invalid fixture handshake"));
          }
        }
      });
      child.once("close", (code) => {
        clearInterval(health);
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        const namespaceError = namespace.failure();
        if (namespaceError) reject(namespaceError);
        else if (failure) reject(failure);
        else if (code !== 0)
          reject(
            new FixtureTransportError(
              `Fixture session failed: ${redactSensitiveText(Buffer.concat(stderr).toString("utf8"), 3000)}`,
            ),
          );
        else resolve(Buffer.concat(stdout).toString("utf8"));
      });
      if (signal.aborted) abort();
      else if (onHandshake) child.stdin!.write(initial);
      else child.stdin!.end(initial);
    });
    // Client close alone cannot certify CREATE stop; observe() checks the exact backend.
    await assertBinding();
    return output;
  }
}
