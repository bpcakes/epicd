import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  NamespaceStopUnprovenError,
  startNamespaceProcess,
} from "../src/adapters/pid-namespace.js";

type Namespace = ReturnType<typeof startNamespaceProcess>;
const active = new Set<Namespace>();
afterEach(async () => {
  for (const namespace of active) {
    namespace.interrupt();
    if (namespace.child.exitCode === null && namespace.child.signalCode === null)
      await once(namespace.child, "close");
  }
  active.clear();
});

function start(script: string) {
  const namespace = startNamespaceProcess(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env: { PATH: "/usr/bin:/bin" },
    stdio: "pipe",
  });
  active.add(namespace);
  return namespace;
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

async function stopped(identity: { pid: number; start: string }): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[19] !== identity.start;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

describe.skipIf(process.platform !== "linux")("sandbox namespace lifetime", () => {
  it("preserves separate arguments above Linux's single-argument size limit", async () => {
    const payload = [
      "--flag",
      "quote'\" and space",
      ...Array.from({ length: 40 }, (_, i) => String(i).padEnd(4096, "x")),
    ];
    const namespace = startNamespaceProcess(
      process.execPath,
      [
        "-e",
        "console.log(JSON.stringify(process.argv.slice(1).map(x => [x.length, x.slice(0, 20)])))",
        "--",
        ...payload,
      ],
      { cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" }, stdio: "pipe" },
    );
    active.add(namespace);
    const closed = once(namespace.child, "close");
    let stdout = "";
    namespace.child.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    expect((await closed)[0]).toBe(0);
    expect(namespace.failure()).toBeUndefined();
    expect(JSON.parse(stdout)).toEqual(payload.map((x) => [x.length, x.slice(0, 20)]));
  });
  it("stops during Bubblewrap setup before its inner parent-death handler can be armed", async () => {
    const namespace = start(`
      const { spawn } = require("node:child_process");
      const bwrap = spawn("/usr/bin/bwrap", [
        "--unshare-all", "--die-with-parent", "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
        "--proc", "/proc", "--block-fd", "3", "--json-status-fd", "4", "--", "/bin/true"
      ], { stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"] });
      // Keep fd 3 open: the sandbox cannot reach do_init()/PDEATHSIG.
      bwrap.stdio[4].once("data", () => console.log("setup-held"));
      setInterval(() => {}, 1000);
    `);
    const closed = once(namespace.child, "close");
    const [data] = await once(namespace.child.stdout!, "data", {
      signal: AbortSignal.timeout(5000),
    });
    expect(String(data)).toBe("setup-held\n");
    const owned = await descendants(namespace.child.pid!);
    expect(owned.length).toBeGreaterThanOrEqual(4);
    expect(await Promise.all(owned.map(stopped))).not.toContain(true);
    namespace.interrupt();
    expect((await closed)[0]).toBe(130);
    expect(namespace.failure()).toBeUndefined();
    expect(await Promise.all(owned.map(stopped))).not.toContain(false);
  });

  it("retains a cancellation delivered before guardian startup", async () => {
    const namespace = start("setInterval(() => {}, 1000)");
    const closed = once(namespace.child, "close");
    namespace.interrupt();
    expect((await closed)[0]).toBe(130);
    expect(namespace.failure()).toBeUndefined();
  });

  it("reaps signal-resistant detached descendants before normal closure, including held output", async () => {
    const namespace = start(`
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
      child.stdout.once("data", () => console.log("tree-ready"));
      process.on("SIGUSR1", () => process.exit(0));
      setInterval(() => {}, 1000);
    `);
    const closed = once(namespace.child, "close");
    const [data] = await once(namespace.child.stdout!, "data", {
      signal: AbortSignal.timeout(5000),
    });
    expect(String(data)).toBe("tree-ready\n");
    const owned = await descendants(namespace.child.pid!);
    expect(owned.length).toBe(3);
    // Request the direct target's normal exit through its ready-installed handler.
    process.kill(owned[1]!.pid, "SIGUSR1");
    expect((await closed)[0]).toBe(0);
    expect(namespace.failure()).toBeUndefined();
    expect(await Promise.all(owned.map(stopped))).not.toContain(false);
  });

  it("does not claim reap proof if the independent monitor is killed", async () => {
    const namespace = start("console.log('ready'); setInterval(() => {}, 1000)");
    const closed = once(namespace.child, "close");
    await once(namespace.child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
    const owned = await descendants(namespace.child.pid!);
    namespace.child.kill("SIGKILL");
    await closed;
    expect(namespace.failure()).toBeInstanceOf(NamespaceStopUnprovenError);
    // util-linux's parent-death guard still stops this exact test-owned namespace.
    await expect
      .poll(async () => (await Promise.all(owned.map(stopped))).every(Boolean))
      .toBe(true);
  });
});
