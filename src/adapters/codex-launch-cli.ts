import { spawn } from "node:child_process";
import { open, readFile, writeFile, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import {
  CodexLaunchSchema,
  codexLaunchCommand,
  prepareCodexAccessToken,
  writeCodexLaunchStop,
} from "./codex-launch.js";
import { redactSensitiveText } from "../util/redact.js";

/** Trusted launcher, outside the agent's mounts. No model output is a stop receipt. */
async function main() {
  const manifest = process.argv[2];
  if (!manifest) throw new Error("Missing Codex launch manifest");
  const launch = CodexLaunchSchema.parse(JSON.parse(await readFile(manifest, "utf8")));
  // Claim outside try: a duplicate launcher must not write this owner's terminal record.
  await writeFile(
    join(launch.controlDirectory, "started.json"),
    JSON.stringify({
      generation: launch.generation,
      startedAt: new Date().toISOString(),
    }),
    { flag: "wx", mode: 0o600 },
  );
  const abort = new AbortController();
  let state: "preparing" | "running" | "stopping" = "preparing";
  const stop = () => {
    state = "stopping";
    abort.abort(new Error("Codex launch interrupted"));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const server = createServer((socket) => {
    let input = "";
    socket.setTimeout(2000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      if (input.length > 1024) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      try {
        const request = z
          .strictObject({
            generation: z.literal(launch.generation),
            operation: z.enum(["inspect", "interrupt"]),
          })
          .parse(JSON.parse(input));
        if (request.operation === "interrupt") stop();
        socket.end(JSON.stringify({ generation: launch.generation, state }));
      } catch {
        socket.destroy();
      }
    });
  });
  let launched = false;
  let terminalAttempted = false;
  let controlDirectory: FileHandle | null = null;
  try {
    controlDirectory = await open(
      launch.controlDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const controlSocketPath = `/proc/self/fd/${controlDirectory.fd}/control.sock`;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(controlSocketPath, resolve);
    });
    const command = await codexLaunchCommand(launch, process.argv.slice(3));
    abort.signal.throwIfAborted();
    await prepareCodexAccessToken(launch, abort.signal);
    abort.signal.throwIfAborted();
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: "inherit",
    });
    let exited = false;
    let force: NodeJS.Timeout | undefined;
    const stopChild = () => {
      if (exited) return;
      child.kill("SIGTERM");
      force = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 500);
    };
    abort.signal.addEventListener("abort", stopChild, { once: true });
    if (abort.signal.aborted) stopChild();
    let error: Error | undefined;
    child.once("spawn", () => {
      launched = true;
      if (!abort.signal.aborted) state = "running";
    });
    child.once("error", (failure) => {
      error = failure;
    });
    child.once("exit", () => {
      exited = true;
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
    );
    if (force) clearTimeout(force);
    abort.signal.removeEventListener("abort", stopChild);
    if (error) throw error;
    await terminal({ kind: "stopped", ...result, interrupted: abort.signal.aborted });
    process.exitCode = abort.signal.aborted ? 130 : (result.code ?? 1);
  } catch (error) {
    // A failed terminal-file sync is uncertainty, not permission to replace an
    // already-written receipt with a second, different outcome.
    if (!terminalAttempted)
      await terminal({
        kind: launched ? "stopped" : "not_started",
        code: null,
        signal: null,
        interrupted: abort.signal.aborted,
      });
    throw error;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await controlDirectory?.close();
  }

  async function terminal(outcome: {
    kind: "stopped" | "not_started";
    code: number | null;
    signal: NodeJS.Signals | null;
    interrupted: boolean;
  }) {
    terminalAttempted = true;
    await writeCodexLaunchStop(launch, outcome);
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    `${redactSensitiveText(error instanceof Error ? error.message : "Codex launch failed")}\n`,
  );
  process.exitCode = 1;
});
