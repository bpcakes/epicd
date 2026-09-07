import { copyFile, link, mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startConfinedCommand, type ConfinedCommand } from "../src/adapters/sandbox.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "epicd-isolation-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  // Use this checkout's Node runtime even when installed under an intentionally hidden home.
  await copyFile(process.execPath, join(workspace, "fixture-node"));
  for (const dir of [".git", ".beads", ".epicd", "scratch"]) await mkdir(join(workspace, dir));
  for (const path of ["source.js", ".git/config", ".beads/issues.jsonl", ".epicd/policy.json"]) {
    await writeFile(join(workspace, path), "original");
  }
  const request: ConfinedCommand = {
    workspace,
    sourceMode: "read-only",
    writablePaths: ["scratch"],
    immutablePaths: [
      "fixture-node",
      "source.js",
      ".git/config",
      ".beads/issues.jsonl",
      ".epicd/policy.json",
    ],
    command: "/workspace/fixture-node",
    args: [],
    timeoutMs: 5000,
  };
  return { root, workspace, request };
}

// This is a real platform gate: missing/disabled bwrap fails on Linux, never passes as a mock.
// Other platforms are not currently admitted by the implementation.
describe.skipIf(process.platform !== "linux")("outer workspace confinement", () => {
  it("denies transient source edits, metadata writes, external paths, and symlink escapes", async () => {
    const { root, workspace, request } = await fixture();
    const outside = join(root, "operator.txt");
    await writeFile(outside, "user-owned");
    await symlink(outside, join(workspace, "escape"));
    const targets = [
      "source.js",
      ".git/config",
      ".beads/issues.jsonl",
      ".epicd/policy.json",
      "escape",
      outside,
    ];
    const handle = await startConfinedCommand({
      ...request,
      args: [
        "-e",
        `
      const fs = require("node:fs");
      const results = ${JSON.stringify(targets)}.map(path => {
        try { fs.writeFileSync(path, "contaminated"); return {path, denied:false}; }
        catch { return {path, denied:true}; }
      });
      fs.writeFileSync("scratch/build.txt", "allowed");
      console.log(JSON.stringify(results));
    `,
      ],
    });
    const result = await handle.result;
    expect(result.status, result.stderr).toBe("succeeded");
    expect(JSON.parse(result.stdout)).toEqual(targets.map((path) => ({ path, denied: true })));
    expect(await readFile(join(workspace, "source.js"), "utf8")).toBe("original");
    expect(await readFile(outside, "utf8")).toBe("user-owned");
    expect(await readFile(join(workspace, "scratch/build.txt"), "utf8")).toBe("allowed");
  });

  it("permits implementation writes but protects Git, Beads, and frozen policy", async () => {
    const { workspace, request } = await fixture();
    const handle = await startConfinedCommand({
      ...request,
      sourceMode: "workspace-write",
      args: [
        "-e",
        `
      const fs = require("node:fs");
      fs.writeFileSync("source.js", "implemented");
      for (const path of [".git/config", ".beads/issues.jsonl", ".epicd/policy.json"]) {
        try { fs.writeFileSync(path, "bad"); process.exit(9); } catch {}
      }
    `,
      ],
    });
    const result = await handle.result;
    expect(result.status, result.stderr).toBe("succeeded");
    expect(await readFile(join(workspace, "source.js"), "utf8")).toBe("implemented");
    expect(await readFile(join(workspace, ".git/config"), "utf8")).toBe("original");
  });

  it("does not expose host environment or processes", async () => {
    vi.stubEnv("EPICD_SANDBOX_TEST_SECRET", "host-secret");
    const { request } = await fixture();
    const handle = await startConfinedCommand({
      ...request,
      args: [
        "-e",
        `
      const fs = require("node:fs");
      console.log(JSON.stringify({ home: process.env.HOME, secret: process.env.EPICD_SANDBOX_TEST_SECRET ?? null,
        pids: fs.readdirSync("/proc").filter(x => /^[0-9]+$/.test(x)).length }));
    `,
      ],
    });
    const result = await handle.result;
    expect(result.status, result.stderr).toBe("succeeded");
    const output = JSON.parse(result.stdout);
    expect(output.home).toBe("/tmp/epicd-home");
    expect(output.secret).toBeNull();
    expect(output.pids).toBeLessThan(8);
  });

  it("kills a detached descendant before acknowledging interruption", async () => {
    const { workspace, request } = await fixture();
    const childScript = `const fs = require('node:fs'); setInterval(() => fs.appendFileSync('scratch/ticks', 'x'), 10);`;
    const handle = await startConfinedCommand({
      ...request,
      args: [
        "-e",
        `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { detached: true, stdio: "ignore" }).unref();
      setInterval(() => {}, 1000);
    `,
      ],
    });
    const ticks = join(workspace, "scratch/ticks");
    await expect
      .poll(async () => (await readFile(ticks, "utf8")).length, { timeout: 3000 })
      .toBeGreaterThan(0);
    handle.interrupt();
    const result = await handle.result;
    expect(result.status).toBe("cancelled");
    expect(result.processTreeStopped).toBe(true);
    const stopped = await readFile(ticks, "utf8");
    await delay(100);
    expect(await readFile(ticks, "utf8")).toBe(stopped);
  });

  it("kills background descendants on normal command exit too", async () => {
    const { workspace, request } = await fixture();
    const childScript = `const fs = require('node:fs'); setInterval(() => fs.appendFileSync('scratch/ticks', 'x'), 10);`;
    const handle = await startConfinedCommand({
      ...request,
      args: [
        "-e",
        `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { detached: true, stdio: "ignore" }).unref();
      setTimeout(() => {}, 200);
    `,
      ],
    });
    const result = await handle.result;
    expect(result.status, result.stderr).toBe("succeeded");
    const ticks = join(workspace, "scratch/ticks");
    const stopped = await readFile(ticks, "utf8");
    expect(stopped.length).toBeGreaterThan(0);
    await delay(100);
    expect(await readFile(ticks, "utf8")).toBe(stopped);
  });

  it("kills detached sandbox descendants when their controller dies", async () => {
    const { workspace } = await fixture();
    const controller = spawn(
      process.execPath,
      ["--import", "tsx", "test/fixtures/orchestration/controller-crash.ts", workspace],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const closed = once(controller, "close");
    const ticks = join(workspace, "scratch/ticks");
    try {
      await expect
        .poll(async () => (await readFile(ticks, "utf8")).length, { timeout: 4000 })
        .toBeGreaterThan(0);
      controller.kill("SIGKILL");
      await closed;
      await delay(100);
      const stopped = await readFile(ticks, "utf8");
      await delay(100);
      expect(await readFile(ticks, "utf8")).toBe(stopped);
    } finally {
      if (controller.exitCode === null && controller.signalCode === null)
        controller.kill("SIGKILL");
      await closed;
    }
  });

  it("cannot connect to an undeclared host service", async () => {
    const { root, request } = await fixture();
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.end("host-secret");
    });
    const socketPath = join(root, "host-service.sock");
    server.listen(socketPath);
    await once(server, "listening");
    try {
      const handle = await startConfinedCommand({
        ...request,
        args: [
          "-e",
          `
        const net = require("node:net");
        const socket = net.connect(${JSON.stringify(socketPath)});
        socket.on("connect", () => { console.log("escaped"); socket.destroy(); });
        socket.on("error", () => console.log("denied"));
      `,
        ],
      });
      const result = await handle.result;
      expect(result.status, result.stderr).toBe("succeeded");
      expect(result.stdout).toBe("denied\n");
      expect(connections).toBe(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("times out a running command without reporting a pass", async () => {
    const { request } = await fixture();
    const handle = await startConfinedCommand({
      ...request,
      timeoutMs: 600,
      args: ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
    });
    expect(await handle.result).toMatchObject({
      status: "timed_out",
      stdout: "ready\n",
      processTreeStopped: true,
    });
  });

  it("bounds and redacts command output", async () => {
    const { request } = await fixture();
    const handle = await startConfinedCommand({
      ...request,
      args: ["-e", `console.log("token=secret-value\\n" + "x".repeat(200000) + "\\nlast-line");`],
    });
    const result = await handle.result;
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout).not.toContain("secret-value");
    expect(result.stdout).toContain("last-line");
    expect(result.stdout.length).toBeLessThan(66_000);
  });

  it("rejects symlink scratch mounts and metadata scratch before launch", async () => {
    const { root, workspace, request } = await fixture();
    await symlink(root, join(workspace, "scratch-link"));
    await expect(
      startConfinedCommand({ ...request, writablePaths: ["scratch-link"] }),
    ).rejects.toThrow("canonical");
    await expect(startConfinedCommand({ ...request, writablePaths: [".git"] })).rejects.toThrow(
      "protected",
    );
    await expect(startConfinedCommand({ ...request, cwd: "../" })).rejects.toThrow("relative");
  });

  it("rejects writable source aliases and scratch that contains candidate files", async () => {
    const { workspace, request } = await fixture();
    await expect(
      startConfinedCommand({ ...request, immutablePaths: ["scratch/source.js"] }),
    ).rejects.toThrow("candidate source");
    await link(join(workspace, "source.js"), join(workspace, "scratch/alias.js"));
    await expect(startConfinedCommand(request)).rejects.toThrow("hard-linked");
  });

  it("does not fall back to host execution if the sandbox executable is missing", async () => {
    const { request } = await fixture();
    const handle = await startConfinedCommand(request, { bwrapPath: "/nonexistent/epicd-bwrap" });
    await expect(handle.result).rejects.toThrow("could not start");
  });
});
