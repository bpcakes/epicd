import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  controlCodexLaunch,
  createCodexLauncher,
  readCodexLaunchStop,
} from "../src/adapters/codex-launch.js";
import { writeCodexConfinement } from "../src/adapters/codex-confinement.js";
import { CommandError, runCommand } from "../src/util/command.js";
import {
  nativeCodexAcceptedPrompt,
  readNativeCodexSession,
} from "../src/adapters/codex-native-state.js";

describe("native confined Herdr launch", () => {
  it.runIf(process.platform === "linux" && process.env.EPICD_LIVE_HERDR === "1")(
    "uses a real native Astra agent in an owned session and confirms supervisor stop",
    async () => {
      expect(process.env.HERDR_ENV).toBe("1");
      if (!process.env.EPICD_TEST_CODEX_PATH)
        throw new Error("Select the native Codex executable explicitly");
      const root = await mkdtemp("/var/tmp/epicd-herdr-launch-");
      const confinement = {
        executable: await realpath(process.env.EPICD_TEST_CODEX_PATH),
        workspace: join(root, "workspace"),
        providerHome: join(root, "provider"),
        scratch: join(root, "scratch"),
        artifacts: join(root, "artifacts"),
        sourceMode: "read-only" as const,
      };
      const controlDirectory = join(root, "control");
      for (const path of [
        confinement.workspace,
        confinement.providerHome,
        confinement.scratch,
        confinement.artifacts,
        controlDirectory,
      ])
        await mkdir(path, { mode: 0o700 });
      await copyFile(process.execPath, join(confinement.workspace, "fixture-node"));
      await writeFile(join(confinement.workspace, "source.txt"), "approved source\n");
      await writeCodexConfinement(confinement);
      const { executable, launch } = await createCodexLauncher(
        {
          confinement,
          controlDirectory,
          model: "gpt-6-astra",
          reasoningEffort: "high",
          authCachePath: await realpath(
            join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
          ),
        },
        join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
      );
      const session = `epicd-probe-${randomUUID().slice(0, 8)}`;
      const herdrConfig = join(root, "herdr.toml");
      await writeFile(
        herdrConfig,
        [
          "onboarding = false",
          "[terminal]",
          'default_shell = "/bin/sh"',
          'shell_mode = "non_login"',
          "[session]",
          "resume_agents_on_restore = false",
          "[update]",
          "version_check = false",
          "manifest_check = false",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const env: NodeJS.ProcessEnv = { ...process.env, HERDR_CONFIG_PATH: herdrConfig };
      for (const name of [
        "HERDR_PANE_ID",
        "HERDR_TAB_ID",
        "HERDR_WORKSPACE_ID",
        "HERDR_SOCKET",
        "HERDR_SOCKET_PATH",
        "ENV",
        "BASH_ENV",
      ])
        delete env[name];
      const cli = async (...args: string[]) => {
        const result = await runCommand("herdr", ["--session", session, ...args], {
          cwd: root,
          env,
          timeoutMs: 35_000,
        }).catch((error: unknown) => {
          if (error instanceof CommandError) throw new Error(error.result.stderr || error.message);
          throw error;
        });
        if (args[1] === "read") return result.stdout;
        return result.stdout.trim() ? (JSON.parse(result.stdout) as unknown) : null;
      };
      let created = false;
      let terminal = false;
      const server = spawn("herdr", ["--session", session, "server"], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const serverClosed = once(server, "close");
      let serverOutput = "";
      server.stdout.on("data", (chunk: Buffer) => {
        serverOutput = (serverOutput + chunk.toString()).slice(-8000);
      });
      server.stderr.on("data", (chunk: Buffer) => {
        serverOutput = (serverOutput + chunk.toString()).slice(-8000);
      });
      try {
        await once(server, "spawn");
        created = true;
        let ready = false;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            await cli("workspace", "list");
            ready = true;
            break;
          } catch {}
          if (server.exitCode !== null || server.signalCode !== null) break;
          await delay(100);
        }
        expect(ready, serverOutput).toBe(true);
        const creation = await cli(
          "workspace",
          "create",
          "--cwd",
          confinement.workspace,
          "--no-focus",
        );
        const workspace = z
          .object({ result: z.object({ workspace: z.object({ workspace_id: z.string() }) }) })
          .parse(creation).result.workspace.workspace_id;
        const tab = z
          .object({ result: z.object({ root_pane: z.object({ pane_id: z.string() }) }) })
          .parse(
            await cli(
              "tab",
              "create",
              "--workspace",
              workspace,
              "--cwd",
              confinement.workspace,
              "--env",
              `PATH=${controlDirectory}:/usr/bin:/bin`,
              "--no-focus",
            ),
          );
        const pane = tab.result.root_pane.pane_id;
        // Login-shell startup can overwrite tab-provided PATH. Set it in the owned
        // shell, then verify resolution before starting any agent or sending a task.
        await cli(
          "pane",
          "run",
          pane,
          `export PATH='${controlDirectory}':"$PATH"; command -v codex`,
        );
        const resolved = await cli(
          "pane",
          "wait-output",
          pane,
          "--source",
          "recent-unwrapped",
          "--regex",
          `(?m)^${executable}\\r?$`,
          "--timeout",
          "5000",
        ).catch(async (error: unknown) => {
          const output = await cli(
            "pane",
            "read",
            pane,
            "--source",
            "recent-unwrapped",
            "--lines",
            "30",
          );
          throw new Error(`${String(error)}\nOwned pane startup: ${JSON.stringify(output)}`);
        });
        expect(JSON.stringify(resolved)).toContain(executable);
        // A printed prompt can precede completion of shell post-command hooks.
        // Start once only after Herdr sees just the owned shell in the foreground.
        let shellAvailable = false;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const info = z
            .object({
              result: z.object({
                process_info: z.object({
                  shell_pid: z.number(),
                  foreground_processes: z.array(z.object({ pid: z.number() })),
                }),
              }),
            })
            .parse(await cli("pane", "process-info", "--pane", pane)).result.process_info;
          shellAvailable =
            info.foreground_processes.length === 1 &&
            info.foreground_processes[0]!.pid === info.shell_pid;
          if (shellAvailable) break;
          await delay(100);
        }
        expect(shellAvailable).toBe(true);
        await cli(
          "agent",
          "start",
          "epicd-probe",
          "--kind",
          "codex",
          "--pane",
          pane,
          "--timeout",
          "20000",
          "--",
          "--no-alt-screen",
        ).catch(async (error: unknown) => {
          const state = await cli("agent", "get", "epicd-probe").catch(() => null);
          const processInfo = await cli("pane", "process-info", "--pane", pane).catch(() => null);
          const output = await cli(
            "agent",
            "read",
            "epicd-probe",
            "--source",
            "recent-unwrapped",
            "--lines",
            "40",
          ).catch(() => cli("pane", "read", pane, "--source", "recent-unwrapped", "--lines", "40"));
          throw new Error(
            `${String(error)}\nOwned agent: ${JSON.stringify(state)}\nProcess detection: ${JSON.stringify(processInfo)}\nStartup output: ${JSON.stringify(output)}`,
          );
        });
        expect((await controlCodexLaunch(launch, "inspect")).state).toBe("running");
        const resultPath = join(confinement.artifacts, "result.json");
        const prompt = `This is a bounded runtime integration test. Read source.txt without modifying it, then write {"status":"observed"} to ${JSON.stringify(resultPath)} using your shell tool. Do not perform other work. Report completion.`;
        await cli("agent", "prompt", "epicd-probe", prompt);
        for (let attempt = 0; attempt < 90; attempt += 1) {
          try {
            if (JSON.parse(await readFile(resultPath, "utf8")).status === "observed") break;
          } catch {}
          await delay(1000);
        }
        const result = await readFile(resultPath, "utf8").catch(async (error: unknown) => {
          const state = await cli("agent", "get", "epicd-probe");
          const output = await cli(
            "agent",
            "read",
            "epicd-probe",
            "--source",
            "recent-unwrapped",
            "--lines",
            "60",
          );
          throw new Error(
            `${String(error)}\nOwned agent: ${JSON.stringify(state)}\nResult output: ${JSON.stringify(output)}`,
          );
        });
        expect(JSON.parse(result)).toEqual({ status: "observed" });
        expect(await readFile(join(confinement.workspace, "source.txt"), "utf8")).toBe(
          "approved source\n",
        );
        const nativeSession = await readNativeCodexSession(launch, null);
        expect(nativeSession).not.toBeNull();
        expect(await nativeCodexAcceptedPrompt(launch, nativeSession!.id, prompt)).toBe(true);
        await cli("agent", "wait", "epicd-probe", "--timeout", "10000");
        await cli("agent", "send-keys", "epicd-probe", "ctrl+d");
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            terminal = (await readCodexLaunchStop(launch)) !== null;
            if (terminal) break;
          } catch {}
          await delay(100);
        }
        expect(terminal).toBe(true);
        expect(await readCodexLaunchStop(launch)).toMatchObject({
          generation: launch.generation,
          kind: "stopped",
          interrupted: false,
          code: 0,
          processTreeStopped: true,
        });
      } finally {
        if (created) {
          try {
            await controlCodexLaunch(launch, "interrupt");
          } catch {}
          const stopped = await runCommand("herdr", ["session", "stop", session, "--json"], {
            cwd: root,
            env,
            timeoutMs: 10_000,
          });
          expect(JSON.parse(stopped.stdout)).toBeTruthy();
          await runCommand("herdr", ["session", "delete", session, "--json"], {
            cwd: root,
            env,
            timeoutMs: 10_000,
          });
          await serverClosed;
          try {
            terminal = (await readCodexLaunchStop(launch)) !== null;
            if (!terminal)
              terminal = await readFile(join(controlDirectory, "started.json"), "utf8").then(
                () => false,
                (error: unknown) =>
                  error instanceof Error && "code" in error && error.code === "ENOENT",
              );
          } catch {
            terminal = false;
          }
        }
        // If creation/stop is uncertain, retain the fixture for inspection instead of deleting under a live process.
        if (terminal) await rm(root, { recursive: true, force: true });
        else process.stderr.write(`Unsettled Herdr fixture retained: ${root}\n`);
      }
    },
    150_000,
  );
});
