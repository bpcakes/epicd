import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { startConfinedCommand, type ConfinedCommand } from "../src/adapters/sandbox.js";
import {
  bindValidationService,
  verifyValidationServices,
  withValidationServices,
  type BoundValidationService,
} from "../src/adapters/validation-services.js";
import { digestJson, ValidationServiceSchema } from "../src/domain/repository-policy.js";

const bin = process.env.EPICD_TEST_PG_BINDIR;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp("/var/tmp/epicd-validation-service-");
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await mkdir(join(workspace, "scratch"));
  await copyFile(process.execPath, join(workspace, "fixture-node"));
  const definition = ValidationServiceSchema.parse({
    id: "browser",
    provider: "postgresql",
    lifetime: "check",
    binDirectory: bin,
    database: "browser_test",
    role: "fixture_owner",
    port: 55432,
    connectionVariable: "DATABASE_URL",
  });
  const service: BoundValidationService = {
    definition,
    environment: {
      bindingId: definition.id,
      instanceId: randomUUID(),
      generation: 1,
      definitionDigest: digestJson(definition),
      runtime: await bindValidationService(definition),
    },
  };
  const request: ConfinedCommand = {
    workspace,
    sourceMode: "read-only",
    writablePaths: ["scratch"],
    immutablePaths: ["fixture-node"],
    command: "/bin/sh",
    args: [],
    timeoutMs: 15_000,
  };
  return { root, workspace, service, request };
}
describe.runIf(process.platform === "linux" && Boolean(bin))(
  "real check-scoped PostgreSQL confinement",
  () => {
    it("runs actual SQL over the private loopback connection and starts fresh on another invocation", async () => {
      const f = await fixture();
      const sql =
        "CREATE TABLE proof(value integer); INSERT INTO proof VALUES (42); SELECT value FROM proof;";
      const request = {
        ...f.request,
        args: ["-c", `exec ${bin}/psql -X -w -qAt -v ON_ERROR_STOP=1 "$DATABASE_URL" -c '${sql}'`],
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const service = {
          ...f.service,
          environment: { ...f.service.environment, instanceId: randomUUID() },
        };
        const handle = await startConfinedCommand(withValidationServices(request, [service]));
        const result = await handle.result;
        expect(result.status, result.stderr).toBe("succeeded");
        expect(result.stdout).toBe("42\n");
        expect(result.processTreeStopped).toBe(true);
        await verifyValidationServices([service]);
      }
    }, 40_000);
    it("cannot reach a host socket or host TCP listener, or write source, even through database superuser SQL", async () => {
      const f = await fixture();
      let connections = 0;
      const server = createServer((socket) => {
        connections++;
        socket.end("host-secret");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing owned test listener");
      try {
        const program = `const {execFileSync}=require('node:child_process'); const fs=require('node:fs'); const net=require('node:net');
        const sql=(query)=>execFileSync(${JSON.stringify(join(bin!, "psql"))}, ['-X','-w','-qAt','-v','ON_ERROR_STOP=1',process.env.DATABASE_URL,'-c',query], {encoding:'utf8'});
        if(sql('SELECT current_database()').trim()!=='browser_test') process.exit(1);
        sql("COPY (SELECT 'inside') TO '/workspace/scratch/sql-write'");
        try { sql("COPY (SELECT 'changed') TO '/workspace/fixture-node'"); process.exit(2); } catch {}
        try { sql("COPY (SELECT 'changed') TO ${JSON.stringify(f.root + "/escaped").replaceAll('"', "'")}"); process.exit(3); } catch {}
        if(fs.existsSync('/var/run/postgresql/.s.PGSQL.5432')) process.exit(4);
        if(fs.readFileSync('/etc/passwd','utf8').split('\\n').filter(Boolean).length!==1) process.exit(5);
        const client=net.connect(${address.port},'127.0.0.1'); client.on('connect',()=>process.exit(6)); client.on('error',()=>console.log('isolated'));`;
        const handle = await startConfinedCommand(
          withValidationServices(
            { ...f.request, command: "/workspace/fixture-node", args: ["-e", program] },
            [f.service],
          ),
        );
        const result = await handle.result;
        expect(result.status, result.stderr).toBe("succeeded");
        expect(result.stdout).toBe("isolated\n");
        expect(connections).toBe(0);
        expect(await readFile(join(f.workspace, "scratch/sql-write"), "utf8")).toBe("inside\n");
        await expect(readFile(join(f.root, "escaped"))).rejects.toThrow();
      } finally {
        server.close();
        await once(server, "close");
      }
    });
    it.each(["success", "cancel", "timeout", "controller_death"] as const)(
      "stops PostgreSQL-created detached descendants after %s",
      async (mode) => {
        const f = await fixture();
        const daemon =
          "const fs=require('node:fs'); setInterval(()=>fs.appendFileSync('/workspace/scratch/heartbeat','x'),20)";
        const launcher = `process.stdin.resume(); process.stdin.on('end',()=>require('node:child_process').spawn('/workspace/fixture-node',['-e',${JSON.stringify(daemon)}],{detached:true,stdio:'ignore'}).unref())`;
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
        const program = `/workspace/fixture-node -e ${quote(launcher)}`;
        const sql = "COPY (SELECT 'start') TO PROGRAM '" + program.replaceAll("'", "''") + "';";
        const command = `require('node:child_process').execFileSync(${JSON.stringify(join(bin!, "psql"))},['-X','-w','-qAt','-v','ON_ERROR_STOP=1',process.env.DATABASE_URL,'-c',${JSON.stringify(sql)}]);
        const fs=require('node:fs'); setInterval(()=>{ if(fs.existsSync('/workspace/scratch/finish'))process.exit(0); },20);`;
        const request = {
          ...f.request,
          command: "/workspace/fixture-node",
          args: ["-e", command],
          timeoutMs: mode === "timeout" ? 4000 : 15_000,
        };
        const heartbeat = join(f.workspace, "scratch/heartbeat");
        const waitStarted = () =>
          expect
            .poll(async () => (await readFile(heartbeat, "utf8")).length, { timeout: 5000 })
            .toBeGreaterThan(0);
        if (mode === "controller_death") {
          const controller = spawn(
            process.execPath,
            [
              "--import",
              "tsx",
              "test/fixtures/orchestration/validation-service-crash.ts",
              JSON.stringify({ request, services: [f.service] }),
            ],
            { stdio: ["ignore", "ignore", "pipe"] },
          );
          const closed = once(controller, "close");
          try {
            await waitStarted();
            controller.kill("SIGKILL");
            await closed;
            await delay(150);
          } finally {
            if (controller.exitCode === null && controller.signalCode === null)
              controller.kill("SIGKILL");
            await closed;
          }
        } else {
          const handle = await startConfinedCommand(withValidationServices(request, [f.service]));
          try {
            await waitStarted();
            if (mode === "success") await writeFile(join(f.workspace, "scratch/finish"), "finish");
            if (mode === "cancel") handle.interrupt();
            const result = await handle.result;
            expect(result.status, result.stderr).toBe(
              mode === "success" ? "succeeded" : mode === "cancel" ? "cancelled" : "timed_out",
            );
            expect(result.processTreeStopped).toBe(true);
          } finally {
            handle.interrupt();
            await handle.result;
          }
        }
        const stopped = await readFile(heartbeat, "utf8");
        await delay(200);
        expect(await readFile(heartbeat, "utf8")).toBe(stopped);
      },
      25_000,
    );
  },
);
