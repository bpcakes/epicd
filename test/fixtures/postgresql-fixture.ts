import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";

const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';

/** Owns a fresh Unix-only cluster. Never opens or configures an existing host service. */
export function startFixturePostgreSql(bin: string) {
  const root = mkdtempSync("/var/tmp/epicd-owned-postgresql-"),
    data = join(root, "cluster"),
    sockets = join(root, "sockets");
  mkdirSync(sockets);
  const manager = userInfo().username,
    role = "epicd_fixture_role",
    admin = "epicd_fixture_bootstrap";
  const run = (name: string, args: string[]) =>
    execFileSync(join(bin, name), args, {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const sql = (query: string, database = "postgres") =>
    run("psql", [
      "-X",
      "-w",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      sockets,
      "-p",
      "55432",
      "-U",
      admin,
      "-d",
      database,
      "-c",
      query,
    ]);
  let started = false;
  const cleanup = (retain = false) => {
    if (started) {
      try {
        run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
        started = false;
      } catch (cause) {
        throw new Error(`Preserved uncertain owned PostgreSQL fixture at ${root}`, { cause });
      }
    }
    if (!retain) rmSync(root, { recursive: true, force: true });
  };
  try {
    run("initdb", [
      "-D",
      data,
      "--auth-local=peer",
      "--auth-host=reject",
      "--no-sync",
      "--locale=C.UTF-8",
      "-U",
      admin,
    ]);
    writeFileSync(
      join(data, "pg_hba.conf"),
      `local all ${admin} trust\nlocal all all peer map=epicd_fixture_test\n`,
    );
    writeFileSync(
      join(data, "pg_ident.conf"),
      `epicd_fixture_test ${quote(manager)} ${quote(manager)}\nepicd_fixture_test ${quote(manager)} ${role}\n`,
    );
    started = true;
    run("pg_ctl", [
      "-D",
      data,
      "-l",
      join(root, "postgres.log"),
      "-w",
      "start",
      "-o",
      `-k ${sockets} -p 55432 -c listen_addresses='' -c fsync=off`,
    ]);
    sql(
      `CREATE ROLE ${quote(manager)} LOGIN NOSUPERUSER CREATEDB; CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT ${role} TO ${quote(manager)}`,
    );
    return { root, data, sockets, manager, role, admin, sql, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
