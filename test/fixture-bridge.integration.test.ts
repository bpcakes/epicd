import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { bindFixtureExecutable, bindFixtureProvider } from "../src/adapters/fixtures.js";
import { type FixtureBridgeTransport } from "../src/adapters/fixture-bridge.js";
import { startConfinedCommand, type ConfinedCommand } from "../src/adapters/sandbox.js";
import { FixtureDefinitionSchema } from "../src/domain/repository-policy.js";

const bin = process.env.EPICD_TEST_PG_BINDIR;
const pgbouncer = process.env.EPICD_TEST_PGBOUNCER;
async function fixture() {
  const root = await mkdtemp("/var/tmp/epicd-fixture-bridge-");
  const data = join(root, "cluster"),
    sockets = join(root, "sockets"),
    workspace = join(root, "workspace");
  const role = userInfo().username;
  const admin = "epicd_bridge_bootstrap";
  const run = (name: string, args: string[]) =>
    execFileSync(join(bin!, name), args, {
      encoding: "utf8",
      timeout: 15_000,
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
  const cleanup = async () => {
    if (started) {
      try {
        run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
      } catch (cause) {
        throw new Error(`Preserved uncertain test-owned PostgreSQL service at ${root}`, { cause });
      }
    }
    await rm(root, { recursive: true, force: true });
  };
  try {
    await mkdir(sockets);
    await mkdir(workspace);
    await mkdir(join(workspace, "scratch"));
    await mkdir(join(workspace, ".git"));
    await copyFile(process.execPath, join(workspace, "fixture-node"));
    await writeFile(join(workspace, "source.txt"), "original");
    await writeFile(join(workspace, ".git/config"), "protected");
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
    // Only this freshly initialized, owned cluster is configured. The production
    // host's roles, HBA, database contents and service configuration are untouched.
    await writeFile(join(data, "pg_hba.conf"), `local all ${admin} trust\nlocal all all peer\n`);
    started = true;
    run("pg_ctl", [
      "-D",
      data,
      "-l",
      join(root, "server.log"),
      "-w",
      "start",
      "-o",
      `-k ${sockets} -p 55432 -c listen_addresses='' -c fsync=off`,
    ]);
    sql(
      `CREATE ROLE "${role.replaceAll('"', '""')}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    sql(`CREATE DATABASE browser_fixture OWNER "${role.replaceAll('"', '""')}" TEMPLATE template0`);
    const definition = FixtureDefinitionSchema.parse({
      id: "browser",
      provider: "postgresql",
      socketDirectory: sockets,
      port: 55432,
      role: admin,
      database: "browser_fixture",
      expectedOwner: role,
      operations: ["create"],
      environmentBinding: "browser",
      cleanup: "retain",
    });
    const bridge: FixtureBridgeTransport = {
      definition,
      binding: await bindFixtureProvider(definition, join(bin!, "psql")),
      validationRole: role,
      listenPort: 55433,
      connectionVariable: "DATABASE_URL",
      pgbouncer: await bindFixtureExecutable(pgbouncer!),
    };
    const request: ConfinedCommand = {
      workspace,
      sourceMode: "read-only",
      writablePaths: ["scratch"],
      immutablePaths: ["fixture-node", "source.txt", ".git/config"],
      command: "/workspace/fixture-node",
      args: [],
      timeoutMs: 15_000,
    };
    return { root, workspace, bridge, request, sql, role, admin, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

describe.runIf(process.platform === "linux" && Boolean(bin) && Boolean(pgbouncer))(
  "real host-fixture bridge transport (not validation authorization)",
  () => {
    it("executes real SQL against the existing fixture, preserving data across bridge lifetimes", async () => {
      const f = await fixture();
      try {
        for (const query of [
          "CREATE TABLE proof(value integer); INSERT INTO proof VALUES (42); SELECT value FROM proof;",
          "SELECT value FROM proof;",
        ]) {
          const handle = await startConfinedCommand(
            {
              ...f.request,
              command: join(bin!, "psql"),
              args: [
                "-X",
                "-w",
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-h",
                "127.0.0.1",
                "-p",
                "55433",
                "-U",
                f.role,
                "-d",
                "browser_fixture",
                "-c",
                query,
              ],
            },
            { fixtureBridge: f.bridge },
          );
          const result = await handle.result;
          expect(result.status, result.stderr).toBe("succeeded");
          expect(result.stdout).toBe("42\n");
          expect(result.processTreeStopped).toBe(true);
          expect(f.sql("SELECT value FROM proof", "browser_fixture")).toBe("42");
        }
      } finally {
        await f.cleanup();
      }
    });

    it("denies alternate databases/roles, console access, upstream sockets, broker /proc, source writes and host TCP", async () => {
      const f = await fixture();
      let connections = 0;
      const server = createServer((socket) => {
        connections++;
        socket.end("host-secret");
      });
      // A different loopback address prevents an ephemeral host port coinciding
      // with the private broker's port from producing a false escape failure.
      server.listen(0, "127.0.0.2");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing owned listener");
      try {
        const program = `const assert=require('node:assert/strict'), fs=require('node:fs'), net=require('node:net');
          const {execFileSync}=require('node:child_process');
          const base=['-X','-w','-qAt','-v','ON_ERROR_STOP=1'];
          const sql=(query, db='browser_fixture', role=${JSON.stringify(f.role)}, options=[])=>execFileSync(${JSON.stringify(join(bin!, "psql"))},[...base,'-h','127.0.0.1','-p','55433','-U',role,'-d',db,...options,'-c',query], {encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']});
          assert.equal(sql('SELECT current_user').trim(),${JSON.stringify(f.role)});
          for(const db of ['postgres','template1','another_fixture','pgbouncer']) assert.throws(()=>sql('SELECT 1',db));
          for(const role of [${JSON.stringify(f.admin)},'pgbouncer','unknown']) assert.throws(()=>sql('SELECT 1','browser_fixture',role));
          assert.throws(()=>sql('SHOW DATABASES','pgbouncer',${JSON.stringify(f.role)}));
          for(const query of ['SET ROLE ${f.admin}', 'CREATE DATABASE escaped', "COPY (SELECT 'bad') TO PROGRAM 'touch /tmp/escaped'"]) assert.throws(()=>sql(query));
          for(const p of ['/epicd-upstream','/epicd-pgbouncer','/tmp/epicd-fixture-bridge',${JSON.stringify(f.root)},'/var/run/postgresql']) assert.equal(fs.existsSync(p),false,p);
          for(const pid of fs.readdirSync('/proc').filter(x=>/^[0-9]+$/.test(x))) {
            const cmd=fs.readFileSync('/proc/'+pid+'/comm','utf8').trim();
            assert.notEqual(cmd,'pgbouncer');
            assert.equal(fs.existsSync('/proc/'+pid+'/root/epicd-upstream'),false);
          }
          for(const p of ['/workspace/source.txt','/workspace/.git/config']) assert.throws(()=>fs.writeFileSync(p,'changed'));
          fs.writeFileSync('/workspace/scratch/allowed','scratch');
          assert.equal(new URL(process.env.DATABASE_URL).port,'55433');
          const c=net.connect(${address.port},'127.0.0.2'); c.on('connect',()=>process.exit(90)); c.on('error',()=>console.log('isolated'));`;
        const handle = await startConfinedCommand(
          { ...f.request, args: ["-e", program] },
          { fixtureBridge: f.bridge },
        );
        const result = await handle.result;
        expect(result.status, result.stderr).toBe("succeeded");
        expect(result.stdout).toBe("isolated\n");
        expect(connections).toBe(0);
        expect(await readFile(join(f.workspace, "source.txt"), "utf8")).toBe("original");
        expect(await readFile(join(f.workspace, ".git/config"), "utf8")).toBe("protected");
        expect(await readFile(join(f.workspace, "scratch/allowed"), "utf8")).toBe("scratch");
        expect(f.sql("SELECT count(*) FROM pg_database WHERE datname='escaped'")).toBe("0");
      } finally {
        server.close();
        await once(server, "close");
        await f.cleanup();
      }
    });

    it.each(["success", "cancel", "timeout", "controller_death"] as const)(
      "stops detached repository descendants after %s without claiming remote database stop",
      async (mode) => {
        const f = await fixture();
        try {
          const heartbeat = join(f.workspace, "scratch/heartbeat");
          const daemon =
            "setInterval(()=>require('node:fs').appendFileSync('/workspace/scratch/heartbeat','x'),20)";
          const program = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(daemon)}],{detached:true,stdio:'ignore'}).unref();
            setInterval(()=>{ if(require('node:fs').existsSync('/workspace/scratch/finish'))process.exit(0); },20)`;
          const request = {
            ...f.request,
            args: ["-e", program],
            timeoutMs: mode === "timeout" ? 3500 : 15_000,
          };
          const waitStarted = () =>
            expect
              .poll(async () => (await readFile(heartbeat, "utf8")).length, { timeout: 6000 })
              .toBeGreaterThan(0);
          if (mode === "controller_death") {
            const controller = spawn(
              process.execPath,
              [
                "--import",
                "tsx",
                "test/fixtures/orchestration/fixture-bridge-crash.ts",
                JSON.stringify({ request, bridge: f.bridge }),
              ],
              { stdio: ["ignore", "ignore", "pipe"] },
            );
            const closed = once(controller, "close");
            try {
              await waitStarted();
            } finally {
              if (controller.exitCode === null && controller.signalCode === null)
                controller.kill("SIGKILL");
              await closed;
            }
            await delay(150);
          } else {
            const handle = await startConfinedCommand(request, { fixtureBridge: f.bridge });
            try {
              await waitStarted();
              if (mode === "success")
                await writeFile(join(f.workspace, "scratch/finish"), "finish");
              if (mode === "cancel") handle.interrupt();
              const result = await handle.result;
              expect(result.status, result.stderr).toBe(
                mode === "success" ? "succeeded" : mode === "cancel" ? "cancelled" : "timed_out",
              );
              expect(result.processTreeStopped).toBe(true);
              expect(result).not.toHaveProperty("backendStopped");
            } finally {
              handle.interrupt();
              await handle.result;
            }
          }
          const stopped = await readFile(heartbeat, "utf8");
          await delay(200);
          expect(await readFile(heartbeat, "utf8")).toBe(stopped);
          // Separate read-only catalog observation, not inferred from local process stop.
          await expect
            .poll(
              () => f.sql("SELECT count(*) FROM pg_stat_activity WHERE datname='browser_fixture'"),
              { timeout: 5000 },
            )
            .toBe("0");
        } finally {
          await f.cleanup();
        }
      },
      25_000,
    );

    it("rejects an altered executable binding and a writable command before launch", async () => {
      const f = await fixture();
      try {
        const changed = {
          ...f.bridge,
          pgbouncer: { ...f.bridge.pgbouncer, digest: "0".repeat(64) },
        };
        await expect(startConfinedCommand(f.request, { fixtureBridge: changed })).rejects.toThrow(
          "identity changed",
        );
        await expect(
          startConfinedCommand(
            { ...f.request, sourceMode: "workspace-write" },
            { fixtureBridge: f.bridge },
          ),
        ).rejects.toThrow("read-only");
        await expect(
          startConfinedCommand(
            { ...f.request, env: { DATABASE_URL: "override" } },
            { fixtureBridge: f.bridge },
          ),
        ).rejects.toThrow("collides");
      } finally {
        await f.cleanup();
      }
    });

    it("never runs repository commands after broker startup failure and preserves command failure", async () => {
      const f = await fixture();
      try {
        const program =
          "require('node:fs').writeFileSync('/workspace/scratch/started','started'); process.exit(17)";
        const request = { ...f.request, args: ["-e", program] };
        const unavailable = {
          ...f.bridge,
          pgbouncer: await bindFixtureExecutable("/usr/bin/true"),
        };
        const failedStartup = await startConfinedCommand(request, { fixtureBridge: unavailable });
        expect(await failedStartup.result).toMatchObject({
          status: "failed",
          exitCode: 125,
          processTreeStopped: true,
        });
        await expect(readFile(join(f.workspace, "scratch/started"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        const commandFailure = await startConfinedCommand(request, { fixtureBridge: f.bridge });
        expect(await commandFailure.result).toMatchObject({
          status: "failed",
          exitCode: 17,
          processTreeStopped: true,
        });
        expect(await readFile(join(f.workspace, "scratch/started"), "utf8")).toBe("started");
      } finally {
        await f.cleanup();
      }
    });

    it("does not mistake a stopped client/proxy for a stopped remote PostgreSQL query", async () => {
      const f = await fixture();
      try {
        const handle = await startConfinedCommand(
          {
            ...f.request,
            command: join(bin!, "psql"),
            args: [
              "-X",
              "-w",
              "-qAt",
              "-h",
              "127.0.0.1",
              "-p",
              "55433",
              "-U",
              f.role,
              "-d",
              "browser_fixture",
              "-c",
              "SELECT pg_sleep(30)",
            ],
          },
          { fixtureBridge: f.bridge },
        );
        try {
          const active = () =>
            f.sql(
              "SELECT pid::text || ':' || extract(epoch from backend_start)::text FROM pg_stat_activity WHERE datname='browser_fixture' AND state='active' AND query='SELECT pg_sleep(30)'",
            );
          await expect.poll(active, { timeout: 5000 }).not.toBe("");
          const [pid, startedAt] = active().split(":");
          expect(pid).toMatch(/^\d+$/);
          expect(startedAt).toMatch(/^\d+\.\d+$/);
          handle.interrupt();
          const result = await handle.result;
          expect(result.status, result.stderr).toBe("cancelled");
          expect(result.processTreeStopped).toBe(true);
          // The host backend is outside our PID namespace and can still execute
          // after its client vanishes. Its exact identity must remain excluded by
          // the future fixture journal, not be released from local stop evidence.
          expect(active()).toBe(`${pid}:${startedAt}`);
          expect(
            f.sql(
              `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid=${pid} AND extract(epoch from backend_start)=${startedAt}`,
            ),
          ).toBe("t");
          await expect.poll(active, { timeout: 5000 }).toBe("");
        } finally {
          handle.interrupt();
          await handle.result;
        }
      } finally {
        await f.cleanup();
      }
    });
  },
);
