import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexModel, verifyCodexExecutable } from "../src/adapters/codex-settings.js";
import { startCodexProcess } from "../src/adapters/codex-process.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // An orphan can remain a zombie until the host's init reaps it; it is no longer running.
    if (process.platform === "linux") {
      return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} did not exit`);
}

describe("Codex app-server process cleanup", () => {
  it.each(["stdout", "stderr"] as const)(
    "preserves a finite version command's %s",
    async (stream) => {
      await expect(
        verifyCodexExecutable(process.cwd(), {
          executablePath: process.execPath,
          args: ["-e", `process.${stream}.write("codex finite fixture\\n")`, "--"],
        }),
      ).resolves.toContain("codex finite fixture");
    },
  );

  it.runIf(process.platform !== "win32").each(["success", "timeout"] as const)(
    "cleans up version-probe descendants on %s",
    async (outcome) => {
      const directory = mkdtempSync(join(tmpdir(), "epicd-codex-version-"));
      tempDirs.push(directory);
      const fixturePath = join(directory, "version.cjs");
      const readyPath = join(directory, "ready.json");
      writeFileSync(
        fixturePath,
        `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", \`
          process.on("SIGTERM", () => {});
          console.log("ready");
          setInterval(() => {}, 1000);
        \`], { stdio: ["ignore", "pipe", "ignore"] });
        child.stdout.once("data", () => {
          require("node:fs").writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));
          if (process.argv[3] === "success") { console.log("codex fixture"); process.exit(0); }
        });
        process.on("SIGTERM", () => {});
      `,
      );
      try {
        const result = verifyCodexExecutable(directory, {
          executablePath: process.execPath,
          args: [fixturePath, readyPath, outcome],
        });
        if (outcome === "success") await expect(result).resolves.toContain("codex fixture");
        else await expect(result).rejects.toThrow("Timed out after 10000ms");
        const pids = JSON.parse(readFileSync(readyPath, "utf8")) as {
          parent: number;
          child: number;
        };
        await waitForProcessExit(pids.parent);
        await waitForProcessExit(pids.child);
      } finally {
        let pids: { parent: number; child: number } | undefined;
        try {
          pids = JSON.parse(readFileSync(readyPath, "utf8"));
        } catch {
          /* Startup failed. */
        }
        for (const pid of pids ? [pids.parent, pids.child] : []) {
          if (processExists(pid)) process.kill(pid, "SIGKILL");
        }
      }
    },
    20_000,
  );

  it.runIf(process.platform !== "win32").each(["before request", "during grace"] as const)(
    "retains cleanup ownership when the supervisor is suspended %s",
    async (timing) => {
      const server = startCodexProcess(
        process.execPath,
        [
          "-e",
          `
        process.stdout.on("error", () => {});
        process.on("SIGTERM", () => console.log("stopping"));
        console.log(JSON.stringify({ target: process.pid, supervisor: process.ppid }));
        setInterval(() => {}, 1000);
      `,
        ],
        process.cwd(),
        process.env,
      );
      server.stderr.resume();
      const [data] = await once(server.stdout, "data");
      const pids = JSON.parse(String(data)) as { target: number; supervisor: number };
      try {
        if (timing === "before request") process.kill(pids.supervisor, "SIGSTOP");
        const terminating = timing === "during grace" ? once(server.stdout, "data") : null;
        const stopped = new Promise<void>((resolve) => server.stop(resolve));
        if (timing === "during grace") {
          await terminating;
          process.kill(pids.supervisor, "SIGSTOP");
        }
        await stopped;
        // A suspended supervisor must survive the caller's bounded wait and resume cleanup.
        await waitForProcessExit(pids.target);
        await waitForProcessExit(pids.supervisor);
      } finally {
        for (const pid of [pids.target, pids.supervisor]) {
          if (processExists(pid)) process.kill(pid, "SIGKILL");
        }
      }
    },
  );

  it("retries a failed executable spawn and reports the attempt count", async () => {
    const directory = mkdtempSync(join(tmpdir(), "epicd-codex-missing-"));
    tempDirs.push(directory);
    await expect(
      resolveCodexModel(directory, {
        executable: { executablePath: join(directory, "missing-executable"), args: [] },
        attempts: 2,
      }),
    ).rejects.toThrow("after 2 attempts:");
  });

  it.runIf(process.platform !== "win32")(
    "cleans up its group when the caller exits unexpectedly",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "epicd-codex-parent-exit-"));
      tempDirs.push(directory);
      const readyPath = join(directory, "ready.json");
      const targetPath = join(directory, "target.cjs");
      writeFileSync(
        targetPath,
        `
      process.on("SIGTERM", () => {});
      require("node:fs").writeFileSync(process.argv[2], JSON.stringify({ target: process.pid, supervisor: process.ppid }));
      setInterval(() => {}, 1000);
    `,
      );
      const moduleUrl = new URL("../src/adapters/codex-settings.ts", import.meta.url).href;
      const caller = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
      import { resolveCodexModel } from ${JSON.stringify(moduleUrl)};
      await resolveCodexModel(process.cwd(), {
        executable: { executablePath: process.execPath, args: process.argv.slice(1) },
        attempts: 1, timeoutMs: 10000,
      });
    `,
          targetPath,
          readyPath,
        ],
        { stdio: "ignore" },
      );
      const callerClosed = once(caller, "close");
      let pids: { target: number; supervisor: number } | undefined;
      try {
        await expect
          .poll(
            () => {
              try {
                return JSON.parse(readFileSync(readyPath, "utf8"));
              } catch {
                return null;
              }
            },
            { timeout: 3_000 },
          )
          .not.toBeNull();
        pids = JSON.parse(readFileSync(readyPath, "utf8"));
        caller.kill("SIGKILL");
        await callerClosed;
        await waitForProcessExit(pids!.target);
        await waitForProcessExit(pids!.supervisor);
      } finally {
        caller.kill("SIGKILL");
        await callerClosed;
        if (!pids) {
          try {
            pids = JSON.parse(readFileSync(readyPath, "utf8"));
          } catch {
            /* No target started. */
          }
        }
        for (const pid of pids ? [pids.target, pids.supervisor] : []) {
          if (!processExists(pid)) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already stopped. */
          }
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not signal a remembered process-group ID after an empty app-server exits",
    async () => {
      const kill = vi.spyOn(process, "kill");
      try {
        await expect(
          resolveCodexModel(process.cwd(), {
            executable: { executablePath: process.execPath, args: ["-e", "process.exit(7)", "--"] },
            attempts: 1,
          }),
        ).rejects.toThrow("app-server exited with code 7");
        // Group signals must originate inside the owned group. A parent-side negative PID
        // would revive the race even if our test machine never happens to recycle that PID.
        expect(kill.mock.calls.filter(([pid]) => pid < 0)).toEqual([]);
      } finally {
        kill.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32").each(["success", "timeout", "abort", "exit"] as const)(
    "stops a detached-stdio descendant after its wrapper closes on %s",
    async (outcome) => {
      const directory = mkdtempSync(join(tmpdir(), "epicd-codex-orphan-"));
      tempDirs.push(directory);
      const fixturePath = join(directory, "app-server.cjs");
      const readyPath = join(directory, "ready.json");
      writeFileSync(
        fixturePath,
        `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const [readyPath, outcome] = process.argv.slice(2);
const child = spawn(process.execPath, ["-e", \`
  process.on("SIGTERM", () => {});
  console.log("ready");
  setInterval(() => {}, 1000);
\`], { stdio: ["ignore", "pipe", "ignore"] });
// This pipe belongs to the wrapper, not to epicd: closing the wrapper closes epicd's transport.
child.stdout.once("data", () => {
  writeFileSync(readyPath, JSON.stringify({ parent: process.pid, child: child.pid }));
  if (outcome === "exit") process.exit(7);
  createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      console.log(JSON.stringify({ id: request.id, result: {} }));
    } else if (request.method === "config/read" && outcome === "success") {
      console.log(JSON.stringify({ id: request.id, result: { config: { model: "fixture-model" } } }));
    }
  });
});
process.on("SIGTERM", () => process.exit(0));
`,
      );
      const controller = new AbortController();
      const result = resolveCodexModel(directory, {
        executable: { executablePath: process.execPath, args: [fixturePath, readyPath, outcome] },
        attempts: 1,
        timeoutMs: 2_000,
        signal: controller.signal,
      });
      // Attach the rejection handler before waiting for the fixture handshake.
      const settled = result.then(
        (model) => ({ model, error: null }),
        (error: unknown) => ({ model: null, error }),
      );
      let pids: { parent: number; child: number } | undefined;
      try {
        await expect
          .poll(
            () => {
              try {
                return JSON.parse(readFileSync(readyPath, "utf8"));
              } catch {
                return null;
              }
            },
            { timeout: 1_500 },
          )
          .not.toBeNull();
        const readyPids = JSON.parse(readFileSync(readyPath, "utf8")) as {
          parent: number;
          child: number;
        };
        pids = readyPids;
        if (outcome === "abort") controller.abort(new Error("fixture cancellation"));
        const response = await settled;
        if (outcome === "success")
          expect(response).toEqual({ model: "fixture-model", error: null });
        else
          expect(response.error).toMatchObject({
            message: expect.stringContaining(
              {
                timeout: "Timed out while resolving",
                abort: "fixture cancellation",
                exit: "app-server exited with code 7",
              }[outcome],
            ),
          });
        await waitForProcessExit(readyPids.parent);
        await waitForProcessExit(readyPids.child);
      } finally {
        controller.abort();
        await settled;
        if (!pids) {
          try {
            pids = JSON.parse(readFileSync(readyPath, "utf8"));
          } catch {
            /* Startup failed. */
          }
        }
        for (const pid of pids ? [pids.parent, pids.child] : []) {
          if (!processExists(pid)) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already terminated. */
          }
        }
      }
    },
  );

  it("terminates a signal-resistant process tree", async () => {
    const directory = mkdtempSync(join(tmpdir(), "epicd-codex-process-"));
    tempDirs.push(directory);
    const fixturePath = join(directory, "app-server.cjs");
    const parentPidPath = join(directory, "parent.pid");
    const childPidPath = join(directory, "child.pid");
    writeFileSync(
      fixturePath,
      `const { spawn } = require("node:child_process");
const fs = require("node:fs");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", () => {
  fs.writeFileSync(process.env.EPICD_TEST_PARENT_PID, String(process.pid));
  fs.writeFileSync(process.env.EPICD_TEST_CHILD_PID, String(child.pid));
  console.log("ready");
});
process.stdin.resume();
`,
    );
    const previousParentPidPath = process.env.EPICD_TEST_PARENT_PID;
    const previousChildPidPath = process.env.EPICD_TEST_CHILD_PID;
    process.env.EPICD_TEST_PARENT_PID = parentPidPath;
    process.env.EPICD_TEST_CHILD_PID = childPidPath;
    let parentPid: number | undefined;
    let childPid: number | undefined;
    const server = startCodexProcess(process.execPath, [fixturePath], process.cwd(), process.env);

    try {
      const [ready] = await once(server.stdout, "data", { signal: AbortSignal.timeout(5000) });
      expect(String(ready)).toBe("ready\n");
      parentPid = Number(readFileSync(parentPidPath, "utf8"));
      childPid = Number(readFileSync(childPidPath, "utf8"));
      expect(processExists(parentPid)).toBe(true);
      expect(processExists(childPid)).toBe(true);
      await new Promise<void>((resolve) => server.stop(resolve));
      await waitForProcessExit(parentPid);
      await waitForProcessExit(childPid);
      expect(processExists(parentPid)).toBe(false);
      expect(processExists(childPid)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.stop(resolve));
      if (previousParentPidPath === undefined) delete process.env.EPICD_TEST_PARENT_PID;
      else process.env.EPICD_TEST_PARENT_PID = previousParentPidPath;
      if (previousChildPidPath === undefined) delete process.env.EPICD_TEST_CHILD_PID;
      else process.env.EPICD_TEST_CHILD_PID = previousChildPidPath;
      for (const pid of [parentPid, childPid]) {
        if (!pid || !processExists(pid)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The implementation may have stopped it between the check and signal.
        }
      }
    }
  });

  it.runIf(process.platform === "win32")(
    "falls back to direct termination when taskkill exits unsuccessfully",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "epicd-codex-taskkill-"));
      tempDirs.push(directory);
      const fixturePath = join(directory, "app-server.cjs");
      const pidPath = join(directory, "app-server.pid");
      const fakeTaskkill = join(directory, "taskkill.exe");
      const commandInterpreter = process.env.ComSpec;
      if (!commandInterpreter) throw new Error("Windows did not provide ComSpec");
      // cmd.exe rejects taskkill's argument shape and exits nonzero, giving this test a real
      // executable failure without replacing production process-spawn behavior.
      copyFileSync(commandInterpreter, fakeTaskkill);
      writeFileSync(
        fixturePath,
        `const fs = require("node:fs");
fs.writeFileSync(process.env.EPICD_TEST_APP_SERVER_PID, String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      const previousPath = process.env.PATH;
      const previousPidPath = process.env.EPICD_TEST_APP_SERVER_PID;
      process.env.PATH = `${directory};${previousPath ?? ""}`;
      process.env.EPICD_TEST_APP_SERVER_PID = pidPath;
      let pid: number | undefined;

      try {
        await expect(
          resolveCodexModel(process.cwd(), {
            executable: { executablePath: process.execPath, args: [fixturePath] },
            attempts: 1,
            timeoutMs: 100,
          }),
        ).rejects.toThrow("Timed out while resolving");
        pid = Number(readFileSync(pidPath, "utf8"));
        await waitForProcessExit(pid);
        expect(processExists(pid)).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousPidPath === undefined) delete process.env.EPICD_TEST_APP_SERVER_PID;
        else process.env.EPICD_TEST_APP_SERVER_PID = previousPidPath;
        if (pid && processExists(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The fallback may have stopped it between the check and signal.
          }
        }
      }
    },
  );
});
