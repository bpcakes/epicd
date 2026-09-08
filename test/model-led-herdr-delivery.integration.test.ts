import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runCommand, runJson } from "../src/util/command.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
describe.runIf(process.platform === "linux" && process.env.EPICD_LIVE_HERDR_DELIVERY === "1")(
  "native model-led epic delivery",
  () => {
    it(
      "delivers through real native Herdr agents from an owned caller pane",
      async () => {
        expect(process.env.HERDR_ENV).toBe("1");
        const root = await mkdtemp("/var/tmp/epicd-native-delivery-");
        // Retain the logs, child report and native run even when this assertion fails.
        process.stderr.write(`Native delivery harness: ${root}\n`);
        const config = join(root, "herdr.toml");
        await writeFile(
          config,
          'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[session]\nresume_agents_on_restore = false\n[update]\nversion_check = false\nmanifest_check = false\n',
          { mode: 0o600 },
        );
        const env = { ...process.env };
        for (const key of Object.keys(env))
          if (key.startsWith("HERDR_") || ["ENV", "BASH_ENV"].includes(key)) delete env[key];
        env.HERDR_CONFIG_PATH = config;
        // Isolate the session registry as well as its config; never resolve or
        // stop a same-named server in the operator's registry.
        env.XDG_CONFIG_HOME = join(root, "xdg");
        const sessionName = `epicd-delivery-${randomUUID().slice(0, 8)}`;
        process.stderr.write(`Owned native session: ${sessionName}\n`);
        const server = spawn("herdr", ["--session", sessionName, "server"], {
          cwd: root,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        server.stdout.resume();
        let diagnostics = "";
        server.stderr.on("data", (chunk: Buffer) => {
          diagnostics = (diagnostics + chunk.toString()).slice(-4000);
        });
        let serverClosed = false,
          runnerFinished = false,
          runnerStarted = false;
        const closed = once(server, "close").then(
          () => {
            serverClosed = true;
          },
          () => {
            serverClosed = true;
          },
        );
        const cli = (args: string[]) =>
          runCommand("herdr", ["--session", sessionName, ...args], {
            cwd: root,
            env,
            timeoutMs: 10_000,
          });
        try {
          await once(server, "spawn");
          let ready = false;
          for (let attempt = 0; attempt < 50; attempt++) {
            try {
              await cli(["workspace", "list"]);
              ready = true;
              break;
            } catch {
              if (serverClosed) break;
              await delay(100);
            }
          }
          expect(ready, diagnostics).toBe(true);
          const created = await runJson(
            "herdr",
            ["--session", sessionName, "workspace", "create", "--cwd", process.cwd(), "--no-focus"],
            { cwd: root, env, timeoutMs: 10_000 },
            z.object({
              result: z.object({
                workspace: z.object({ workspace_id: z.string() }),
                root_pane: z.object({ pane_id: z.string() }),
              }),
            }),
          );
          const command = [
            process.execPath,
            join(process.cwd(), "test/fixtures/herdr-delivery-runner.mjs"),
            process.cwd(),
            root,
            sessionName,
            created.result.workspace.workspace_id,
          ]
            .map(quote)
            .join(" ");
          // Launch an ordinary test runner, not an agent, in the explicitly returned pane.
          runnerStarted = true;
          await cli(["pane", "run", created.result.root_pane.pane_id, command]);
          const deadline = Date.now() + 42 * 60_000;
          let nextProgress = Date.now(),
            lastProgress = "";
          while (Date.now() < deadline) {
            if (serverClosed) throw new Error(`Owned Herdr server exited: ${diagnostics}`);
            const exit = await readFile(join(root, "exit.json"), "utf8").catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
              },
            );
            if (exit !== null) {
              runnerFinished = true;
              expect(JSON.parse(exit), `Inspect ${join(root, "delivery.log")}`).toMatchObject({
                code: 0,
                signal: null,
              });
              const report = JSON.parse(await readFile(join(root, "delivery.json"), "utf8"));
              expect(report).toMatchObject({
                success: true,
                numPassedTests: 1,
                numFailedTests: 0,
                numPendingTests: 0,
              });
              return;
            }
            if (Date.now() >= nextProgress) {
              const log = await readFile(join(root, "delivery.log"), "utf8").catch(() => "");
              const progress = log
                .split("\n")
                .filter((line) => /Live delivery (artifacts:|run:)|Live delivery:/.test(line))
                .slice(-1)[0];
              if (progress && progress !== lastProgress) {
                process.stderr.write(`${progress}\n`);
                lastProgress = progress;
              }
              nextProgress = Date.now() + 30_000;
            }
            await delay(1000);
          }
          throw new Error(
            `Native runner did not exit; preserve ${sessionName} and inspect ${root}`,
          );
        } finally {
          if (!runnerStarted || runnerFinished) {
            await runCommand("herdr", ["session", "stop", sessionName, "--json"], {
              cwd: root,
              env,
              timeoutMs: 10_000,
            });
            for (let attempt = 0; attempt < 100 && !serverClosed; attempt++) await delay(50);
            expect(serverClosed, "Owned test server stop remains unknown").toBe(true);
            await closed;
          } else {
            process.stderr.write(
              `Unfinished owned test session retained: ${sessionName}; ${root}\n`,
            );
            server.unref();
            server.stdout.destroy();
            server.stderr.destroy();
          }
        }
      },
      44 * 60_000,
    );
  },
);
