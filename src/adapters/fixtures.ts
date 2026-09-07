import { NamespaceStopUnprovenError, startNamespaceProcess } from "./pid-namespace.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  digestJson,
  FixtureDefinitionSchema,
  type FixtureDefinition,
} from "../domain/repository-policy.js";
import {
  FixtureCatalogSchema,
  FixtureProviderBindingSchema,
  type FixtureCatalog,
  type FixtureProviderBinding,
} from "../domain/fixtures.js";
import { redactSensitiveText } from "../util/redact.js";

export class FixtureTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureTransportError";
  }
}
export type FixtureInspector = {
  inspect(
    definition: FixtureDefinition,
    binding: FixtureProviderBinding,
    guard: () => void,
    signal: AbortSignal,
  ): Promise<FixtureCatalog | null>;
};

async function node(path: string, kind: "directory" | "socket") {
  if (!isAbsolute(path) || path.includes("\0") || (await realpath(path)) !== path)
    throw new FixtureTransportError(
      "Fixture path must be absolute and canonical, without symlink aliases",
    );
  const stat = await lstat(path, { bigint: true });
  if (!(kind === "directory" ? stat.isDirectory() : stat.isSocket()))
    throw new FixtureTransportError(`Expected fixture ${kind}`);
  return {
    path,
    device: String(stat.dev),
    inode: String(stat.ino),
    ...(kind === "socket" ? { changeTimeNs: String(stat.ctimeNs) } : {}),
  };
}

/** Operator-only preparation: file inspection, never a server query or resource mutation. */
export async function bindFixtureProvider(
  definitionInput: FixtureDefinition,
  executable: string,
): Promise<FixtureProviderBinding> {
  const definition = FixtureDefinitionSchema.parse(definitionInput);
  const directory = await node(definition.socketDirectory, "directory");
  const binary = await bindFixtureExecutable(executable);
  let socket = null;
  try {
    socket = await node(join(directory.path, `.s.PGSQL.${definition.port}`), "socket");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return FixtureProviderBindingSchema.parse({ executable: binary, directory, socket });
}

/** Pins a native provider executable without executing it or opening any service. */
export async function bindFixtureExecutable(executable: string) {
  if (!isAbsolute(executable) || (await realpath(executable)) !== executable)
    throw new FixtureTransportError(
      "Select the canonical native executable, not a wrapper or symlink",
    );
  // A replacement FIFO must be rejected by fstat, not block open waiting for a writer.
  const file = await open(
    executable,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let binary;
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.size > 64n * 1024n * 1024n || (stat.mode & 0o111n) === 0n)
      throw new FixtureTransportError("Expected a bounded native fixture executable");
    const bytes = await file.readFile();
    if (!bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])))
      throw new FixtureTransportError(
        "Fixture provider requires a native ELF binary; shell wrappers are not allowed",
      );
    const after = await file.stat({ bigint: true });
    if (
      stat.size !== after.size ||
      stat.mtimeNs !== after.mtimeNs ||
      stat.ctimeNs !== after.ctimeNs
    )
      throw new FixtureTransportError("Provider executable changed while it was inspected");
    binary = {
      path: executable,
      device: String(stat.dev),
      inode: String(stat.ino),
      digest: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await file.close();
  }
  return binary;
}

/** No identifiers or SQL expressions come from the model. Names are hex-encoded data literals. */
export function fixtureInspectionSql(database: string): string {
  const name = Buffer.from(database, "utf8").toString("hex");
  return `BEGIN READ ONLY;
SELECT pg_catalog.json_build_object(
 'serverVersion', pg_catalog.current_setting('server_version_num'),
 'role', current_user,
 'maintenanceDatabase', pg_catalog.current_database(),
 'roleCanCreateDatabase', r.rolcreatedb,
 'roleIsSuperuser', r.rolsuper,
 'database', (SELECT pg_catalog.json_build_object('oid', d.oid::text, 'name', d.datname, 'owner', o.rolname,
   'canConnect', pg_catalog.has_database_privilege(current_user, d.oid, 'CONNECT'))
   FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles o ON o.oid = d.datdba
   WHERE d.datname = pg_catalog.convert_from(pg_catalog.decode('${name}', 'hex'), 'UTF8')))
FROM pg_catalog.pg_roles r WHERE r.rolname = current_user;
COMMIT;`;
}

/** Fixed read-only catalog query in its own PID/network namespace. Never exposes this socket to agents/tests. */
export class PostgreSqlFixtureInspector implements FixtureInspector {
  constructor(private readonly bwrapPath = "/usr/bin/bwrap") {}
  async inspect(
    definitionInput: FixtureDefinition,
    bindingInput: FixtureProviderBinding,
    guard: () => void,
    signal: AbortSignal,
  ): Promise<FixtureCatalog | null> {
    const definition = FixtureDefinitionSchema.parse(definitionInput);
    const binding = FixtureProviderBindingSchema.parse(bindingInput);
    const assertBinding = async () => {
      if (
        digestJson(await bindFixtureProvider(definition, binding.executable.path)) !==
        digestJson(binding)
      )
        throw new FixtureTransportError(
          "Provider/socket identity changed; a new explicit operator grant is required",
        );
      signal.throwIfAborted();
      guard();
    };
    await assertBinding();
    if (!binding.socket) return null;
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
      binding.socket.path,
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
      "-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c search_path=pg_catalog",
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
      "--command",
      fixtureInspectionSql(definition.database),
    );
    await assertBinding();
    const output = await new Promise<string>((resolve, reject) => {
      const namespace = startNamespaceProcess(this.bwrapPath, args, {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        stdio: "pipe",
      });
      const { child } = namespace;
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let outBytes = 0,
        errBytes = 0;
      let failure: Error | null = null;
      const stop = (error: Error) => {
        failure ??= error;
        namespace.interrupt();
      };
      const abort = () => stop(new FixtureTransportError("Fixture inspection interrupted"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timeout = setTimeout(
        () => stop(new FixtureTransportError("Fixture inspection exceeded 10 seconds")),
        10_000,
      );
      const health = setInterval(() => {
        try {
          guard();
        } catch {
          stop(new FixtureTransportError("Fixture authority changed during inspection"));
        }
      }, 100);
      child.stdout!.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes <= 65536) stdout.push(chunk);
        else stop(new FixtureTransportError("Fixture output exceeded its bound"));
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        errBytes += chunk.length;
        if (errBytes <= 65536) stderr.push(chunk);
        else stop(new FixtureTransportError("Fixture error output exceeded its bound"));
      });
      // Resolve/reject only after close, never merely after requesting interruption.
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code) => {
        clearInterval(health);
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        const namespaceError = namespace.failure();
        failure ??= namespaceError ?? null;
        if (namespaceError instanceof NamespaceStopUnprovenError) reject(namespaceError);
        else if (failure) reject(new FixtureTransportError(failure.message));
        else if (code !== 0)
          reject(
            new FixtureTransportError(
              `Fixture catalog query failed: ${redactSensitiveText(Buffer.concat(stderr).toString("utf8"), 2000)}`,
            ),
          );
        else resolve(Buffer.concat(stdout).toString("utf8"));
      });
    });
    guard();
    signal.throwIfAborted();
    let observed: FixtureCatalog;
    try {
      observed = FixtureCatalogSchema.parse(JSON.parse(output));
    } catch {
      throw new FixtureTransportError(
        "Fixture provider did not return the bounded catalog contract",
      );
    }
    if (
      observed.role !== definition.role ||
      (observed.database && observed.database.name !== definition.database)
    )
      throw new FixtureTransportError("Fixture provider returned a different role or database");
    await assertBinding();
    return observed;
  }
}
