import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareCommandLifetime,
  readCommandStop,
  recoverCommandStop,
  startDurableCommand,
  type CommandLaunch,
} from "../src/adapters/command-lifetime.js";
import { NamespaceStopUnprovenError } from "../src/adapters/pid-namespace.js";
import { startConfinedCommand } from "../src/adapters/sandbox.js";
import { digestJson } from "../src/domain/repository-policy.js";

const roots: string[] = [];
const active = new Set<ReturnType<typeof startDurableCommand>>();
afterEach(async () => {
  for (const handle of active) {
    handle.interrupt();
    await handle.result.catch(() => {});
  }
  active.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(script = "console.log('green')", timeoutMs = 5000) {
  const root = await mkdtemp("/var/tmp/epicd-command-stop-");
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const launch: CommandLaunch = {
    command: process.execPath,
    args: ["-e", script],
    cwd: workspace,
    env: { PATH: "/usr/bin:/bin" },
    extraInput: null,
  };
  const scope = {
    runId: randomUUID(),
    operationId: randomUUID(),
    controllerLeaseId: randomUUID(),
    scopeDigest: digestJson({ fixture: "exact-owned-fixture" }),
    timeoutMs,
  };
  const intent = await prepareCommandLifetime(scope, launch);
  return { root, workspace, launch, scope, intent };
}
function start(f: Awaited<ReturnType<typeof fixture>>) {
  const handle = startDurableCommand(f.intent, f.launch);
  active.add(handle);
  void handle.result.catch(() => {});
  handle.child.stderr!.resume();
  return handle;
}
async function poll<T>(read: () => Promise<T>, okay: (value: T) => boolean): Promise<T> {
  const until = Date.now() + 10000;
  while (true) {
    const value = await read();
    if (okay(value)) return value;
    if (Date.now() >= until) throw new Error("Timed out observing owned test process/receipt");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function descendants(pid: number): Promise<{ pid: number; start: string }[]> {
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim();
  const result: { pid: number; start: string }[] = [];
  for (const child of children ? children.split(/\s+/).map(Number) : []) {
    const stat = await readFile(`/proc/${child}/stat`, "utf8");
    result.push({ pid: child, start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]! });
    result.push(...(await descendants(child)));
  }
  return result;
}
async function stopped(identity: { pid: number; start: string }) {
  try {
    const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[19] !== identity.start;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

describe.skipIf(process.platform !== "linux")("durable command namespace stop", () => {
  it("retains exact normal stop and output without requiring its original controller", async () => {
    const f = await fixture(),
      handle = start(f);
    let output = "";
    handle.child.stdout!.on("data", (chunk) => {
      output += String(chunk);
    });
    const result = await handle.result;
    expect(result).toMatchObject({
      code: 0,
      signal: null,
      receipt: { kind: "stopped", reason: null, error: null },
    });
    expect(output).toBe("green\n");
    expect(await readCommandStop(f.intent)).toEqual(result.receipt);
    expect(await recoverCommandStop(f.intent)).toEqual(result.receipt);
  });
  it("atomically prevents a delayed old launch without running its command", async () => {
    const f = await fixture("require('node:fs').writeFileSync('effect', 'forbidden')");
    const receipt = await recoverCommandStop(f.intent);
    expect(receipt).toMatchObject({ kind: "not_started", code: null });
    const handle = start(f);
    handle.child.stdout!.resume();
    await expect(handle.result).rejects.toThrow();
    await expect(readFile(join(f.workspace, "effect"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await recoverCommandStop(f.intent)).toEqual(receipt);
  });
  it("enforces a deadline independently and records interruption rather than success", async () => {
    const f = await fixture("setInterval(() => {}, 1000)", 200),
      handle = start(f);
    handle.child.stdout!.resume();
    expect(await handle.result).toMatchObject({
      code: 130,
      receipt: { kind: "stopped", reason: "timed_out" },
    });
  });
  it("survives actual controller SIGKILL, reaps resistant descendants and publishes physical stop", async () => {
    const f = await fixture(
      `
      const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], {detached:true,stdio:['ignore','pipe','inherit']});
      child.stdout.once('data',()=>console.log('tree-ready'));
      setInterval(()=>{},1000);
    `,
      20000,
    );
    const module = pathToFileURL(resolve("dist/adapters/command-lifetime.js")).href;
    const parent = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { startDurableCommand } from ${JSON.stringify(module)};
      let data=''; for await (const chunk of process.stdin) data+=chunk;
      const {intent,launch}=JSON.parse(data), handle=startDurableCommand(intent,launch);
      handle.child.stdout.pipe(process.stdout); handle.child.stderr.pipe(process.stderr);
      await handle.result;
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    parent.stderr!.resume();
    parent.stdin!.end(JSON.stringify({ intent: f.intent, launch: f.launch }));
    const closed = once(parent, "close");
    try {
      expect(
        String((await once(parent.stdout!, "data", { signal: AbortSignal.timeout(10000) }))[0]),
      ).toBe("tree-ready\n");
      const owned = await descendants(parent.pid!);
      expect(owned.length).toBeGreaterThanOrEqual(5);
      parent.kill("SIGKILL");
      await closed;
      const receipt = await poll(
        () => readCommandStop(f.intent),
        (value) => value !== null,
      );
      expect(receipt).toMatchObject({ kind: "stopped", reason: "cancelled" });
      await poll(
        () => Promise.all(owned.map(stopped)),
        (value) => value.every(Boolean),
      );
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        parent.kill("SIGKILL");
        await closed;
      }
    }
  });
  it("does not infer stop after the namespace monitor is killed", async () => {
    const f = await fixture("console.log('ready'); setInterval(()=>{},1000)"),
      handle = start(f);
    await once(handle.child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
    const owned = await descendants(handle.child.pid!);
    expect(owned.length).toBeGreaterThanOrEqual(3);
    // Immediate child is this test-owned supervisor's unshare monitor, not a saved production PID.
    process.kill(owned[0]!.pid, "SIGKILL");
    await expect(handle.result).rejects.toBeInstanceOf(NamespaceStopUnprovenError);
    expect(await recoverCommandStop(f.intent)).toBeNull();
    await poll(
      () => Promise.all(owned.map(stopped)),
      (value) => value.every(Boolean),
    );
  });
  it("does not infer stop from supervisor death even after the kernel kills its namespace", async () => {
    const f = await fixture("console.log('ready'); setInterval(()=>{},1000)"),
      handle = start(f);
    await once(handle.child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
    const owned = await descendants(handle.child.pid!);
    handle.child.kill("SIGKILL");
    await expect(handle.result).rejects.toBeInstanceOf(NamespaceStopUnprovenError);
    expect(await recoverCommandStop(f.intent)).toBeNull();
    await poll(
      () => Promise.all(owned.map(stopped)),
      (value) => value.every(Boolean),
    );
  });
  it.each(["run", "lease", "scope", "launch", "directory"])(
    "rejects a receipt with different %s identity",
    async (kind) => {
      const f = await fixture();
      await recoverCommandStop(f.intent);
      const changed = structuredClone(f.intent);
      if (kind === "run") changed.runId = randomUUID();
      if (kind === "lease") changed.controllerLeaseId = randomUUID();
      if (kind === "scope") changed.scopeDigest = "0".repeat(64);
      if (kind === "launch") changed.launchDigest = "0".repeat(64);
      if (kind === "directory")
        changed.directory.inode = String(BigInt(changed.directory.inode) + 1n);
      await expect(recoverCommandStop(changed)).rejects.toThrow();
    },
  );
  it.each(["missing", "malformed", "public", "replaced-directory"])(
    "preserves uncertainty for %s stop evidence",
    async (kind) => {
      const f = await fixture(),
        handle = start(f);
      handle.child.stdout!.resume();
      await handle.result;
      const path = join(f.intent.directory.path, "stopped.json");
      if (kind === "missing") await unlink(path);
      if (kind === "malformed") await writeFile(path, "{}");
      if (kind === "public") await chmod(path, 0o644);
      if (kind === "replaced-directory") {
        await rename(f.intent.directory.path, `${f.intent.directory.path}-retained`);
        await mkdir(f.intent.directory.path, { mode: 0o700 });
      }
      if (kind === "missing") expect(await recoverCommandStop(f.intent)).toBeNull();
      else await expect(recoverCommandStop(f.intent)).rejects.toThrow();
    },
  );
  it("does not mount command control files into the repository sandbox", async () => {
    const f = await fixture();
    let admitted = false;
    const handle = await startConfinedCommand(
      {
        workspace: f.workspace,
        sourceMode: "read-only",
        command: "/bin/sh",
        args: [
          "-c",
          `test ! -e '${f.intent.directory.path}' && test ! -e /workspace/../.command-io && printf green`,
        ],
        timeoutMs: 5000,
      },
      {
        durableStop: {
          ...f.scope,
          admit: () => {
            admitted = true;
          },
        },
      },
    );
    expect(admitted).toBe(true);
    expect(await handle.result).toMatchObject({
      status: "succeeded",
      stdout: "green",
      processTreeStopped: true,
    });
  });
});
