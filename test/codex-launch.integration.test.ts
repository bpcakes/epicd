import {
  copyFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Codex } from "@openai/codex-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexLaunchCommand,
  controlCodexLaunch,
  createCodexLauncher,
  CodexLaunchSchema,
  prepareCodexAccessToken,
  readCodexAccessToken,
  readCodexLaunchStop,
  validateCodexArguments,
} from "../src/adapters/codex-launch.js";
import { writeCodexConfinement } from "../src/adapters/codex-confinement.js";
import { runCommand } from "../src/util/command.js";
import { REVIEW_PACKET_PATH, reviewPacketBinding } from "../src/domain/review-packet.js";
import { startNamespaceProcess } from "../src/adapters/pid-namespace.js";
import { CODEX_PERMISSION_PROFILE } from "../src/adapters/codex-confinement.js";

const roots: { path: string; controls: string[] }[] = [];
afterEach(async () => {
  for (const { path: root, controls } of roots.splice(0)) {
    let settled = true;
    for (const control of controls) {
      const started = await readFile(join(root, control, "started.json"), "utf8").catch(
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (started !== null) {
        const launch = CodexLaunchSchema.parse(
          JSON.parse(await readFile(join(root, control, "launch.json"), "utf8")),
        );
        let receipt = await readCodexLaunchStop(launch);
        if (!receipt) {
          await controlCodexLaunch(launch, "interrupt").catch(() => undefined);
          for (let attempt = 0; attempt < 50 && !receipt; attempt += 1) {
            await delay(100);
            receipt = await readCodexLaunchStop(launch);
          }
        }
        if (!receipt) {
          process.stderr.write(`Unsettled Codex fixture retained: ${root}\n`);
          settled = false;
        }
      }
    }
    if (settled) await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp("/var/tmp/epicd-native-launch-");
  roots.push({ path: root, controls: ["control"] });
  const executable = await realpath(
    process.env.EPICD_TEST_CODEX_PATH ??
      join(
        dirname(createRequire(import.meta.url).resolve("@openai/codex-linux-x64/package.json")),
        "vendor/x86_64-unknown-linux-musl/bin/codex",
      ),
  );
  const confinement = {
    executable,
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
  await writeFile(join(confinement.workspace, "source.txt"), "approved source\n");
  await copyFile(process.execPath, join(confinement.workspace, "fixture-node"));
  await writeCodexConfinement(confinement);
  const input = {
    confinement,
    controlDirectory,
    model: "gpt-6-astra",
    reasoningEffort: "high" as const,
    authCachePath: null,
    reviewPacket: null,
  };
  return { root, input };
}

describe.skipIf(process.platform !== "linux")("confined Codex launcher", () => {
  it.runIf(process.env.EPICD_CODEX_CONFINEMENT === "1")(
    "lets real Codex local tools read the packet but not change it or read launch control",
    async () => {
      const { input } = await fixture();
      const text = '{"evidence":"complete retained bytes"}\n';
      await writeFile(join(input.controlDirectory, "review-evidence.json"), text, { mode: 0o400 });
      const { launch } = await createCodexLauncher(
        { ...input, reviewPacket: reviewPacketBinding(text) },
        fileURLToPath(import.meta.url),
      );
      const command = await codexLaunchCommand(launch, ["exec", "--version"]);
      const output = join(input.confinement.artifacts, "packet-probe.json");
      const script = `const fs = require('node:fs');
        const text = fs.readFileSync(${JSON.stringify(REVIEW_PACKET_PATH)}, 'utf8');
        let writable = false, controlReadable = false;
        try { fs.appendFileSync(${JSON.stringify(REVIEW_PACKET_PATH)}, 'changed'); writable = true; } catch {}
        try { fs.readFileSync(${JSON.stringify(join(input.controlDirectory, "launch.json"))}); controlReadable = true; } catch {}
        fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ text, writable, controlReadable }));`;
      // Trusted contract probe replaces only the provider entrypoint with Codex's
      // local sandbox command. No model request or simulated permission decision.
      const args = [
        ...command.args.slice(0, command.args.lastIndexOf("--") + 1),
        input.confinement.executable,
        "sandbox",
        "-P",
        CODEX_PERMISSION_PROFILE,
        "-C",
        input.confinement.workspace,
        "--",
        join(input.confinement.workspace, "fixture-node"),
        "-e",
        script,
      ];
      const namespace = startNamespaceProcess(command.command, args, {
        cwd: command.cwd,
        env: command.env,
        stdio: "pipe",
        extraInput: text,
        timeoutMs: 10000,
      });
      const closed = once(namespace.child, "close");
      namespace.child.stdout?.resume();
      let stderr = "";
      namespace.child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      try {
        await closed;
        expect(namespace.completion(), stderr).toEqual({ code: 0, reason: null });
        expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
          text,
          writable: false,
          controlReadable: false,
        });
      } finally {
        if (namespace.child.exitCode === null && namespace.child.signalCode === null)
          namespace.interrupt();
        await closed;
      }
    },
    15000,
  );

  it("passes only verified packet bytes over private input, never the control path or credentials", async () => {
    const { input } = await fixture();
    const text = '{"evidence":"original retained record"}\n';
    const path = join(input.controlDirectory, "review-evidence.json");
    await writeFile(path, text, { mode: 0o400 });
    const { launch } = await createCodexLauncher(
      { ...input, reviewPacket: reviewPacketBinding(text) },
      fileURLToPath(import.meta.url),
    );
    const command = await codexLaunchCommand(launch, ["exec", "--version"]);
    expect(command.extraInput).toBe(text);
    expect(command.args).toContain("--ro-bind-data");
    expect(command.args).toContain(REVIEW_PACKET_PATH);
    expect(command.args).not.toContain(path);
    expect(JSON.stringify(command.env)).not.toContain(text);
    expect(JSON.stringify(command.args)).not.toContain(text);
    await chmod(path, 0o600);
    await writeFile(path, text.replace("original", "tampered"));
    await chmod(path, 0o400);
    expect(command.extraInput).toBe(text); // Already verified bytes do not follow the host file.
    await expect(codexLaunchCommand(launch, ["exec", "--version"])).rejects.toThrow("differs");
  });

  it.each(["missing", "writable", "symlink", "hardlink"])(
    "refuses a %s review packet before starting Codex",
    async (variant) => {
      const { input, root } = await fixture();
      const text = "packet";
      const path = join(input.controlDirectory, "review-evidence.json");
      const retained = join(root, "retained");
      await writeFile(retained, text, { mode: 0o400 });
      if (variant === "writable") await writeFile(path, text, { mode: 0o600 });
      if (variant === "symlink") await symlink(retained, path);
      if (variant === "hardlink") await link(retained, path);
      const { launch } = await createCodexLauncher(
        { ...input, reviewPacket: reviewPacketBinding(text) },
        fileURLToPath(import.meta.url),
      );
      await expect(codexLaunchCommand(launch, ["exec", "--version"])).rejects.toThrow();
      expect(await readFile(retained, "utf8")).toBe(text);
    },
  );

  it("pins model and effort and rejects sandbox, provider, config, and session drift", async () => {
    const { input } = await fixture();
    const { launch } = await createCodexLauncher(input, fileURLToPath(import.meta.url));
    const args = ["exec", "--experimental-json"];
    validateCodexArguments(launch, args);
    expect(args).toContain("gpt-6-astra");
    expect(args).toContain('model_reasoning_effort="high"');
    for (const args of [
      ["exec", "--sandbox", "danger-full-access"],
      ["exec", "--config", 'default_permissions="other"'],
      ["exec", "--model", "other-model"],
      ["--remote", "ws://127.0.0.1:9999"],
      ["exec", "resume", "--last"],
    ])
      expect(() => validateCodexArguments(launch, args)).toThrow();
  });

  it("rejects mutable or changed launch-owned confinement policy", async () => {
    const { input } = await fixture();
    const { launch } = await createCodexLauncher(input, fileURLToPath(import.meta.url));
    const policy = join(launch.controlDirectory, "config.toml");
    await chmod(policy, 0o600);
    await expect(codexLaunchCommand(launch, ["exec", "--version"])).rejects.toThrow(
      "exact owner read-only",
    );
    await writeFile(policy, 'approval_policy = "on-request"\n');
    await chmod(policy, 0o400);
    await expect(codexLaunchCommand(launch, ["exec", "--version"])).rejects.toThrow(
      "changed before launch",
    );
  });

  it("extracts only an access token without persisting or exposing the refresh bundle", async () => {
    const { root, input } = await fixture();
    const auth = join(root, "auth.json");
    const original = JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: "2026-09-07T00:00:00Z",
      tokens: {
        access_token: "access-test",
        refresh_token: "refresh-test",
        id_token: "identity-test",
        account_id: "account-test",
      },
    });
    await writeFile(auth, original, { mode: 0o600 });
    expect(await readCodexAccessToken(auth)).toBe("access-test");
    expect(await readFile(auth, "utf8")).toBe(original);
    const { launch } = await createCodexLauncher(
      { ...input, authCachePath: auth },
      fileURLToPath(import.meta.url),
    );
    await prepareCodexAccessToken(launch);
    const privateCache = await readFile(join(input.confinement.providerHome, "auth.json"), "utf8");
    expect(privateCache).not.toContain("refresh-test");
    expect(JSON.parse(privateCache)).toMatchObject({
      last_refresh: "2026-09-07T00:00:00Z",
      tokens: { refresh_token: "", access_token: "access-test" },
    });
    expect(await readFile(auth, "utf8")).toBe(original);
    await writeFile(auth, '{"secret":"do-not-print"');
    await expect(readCodexAccessToken(auth)).rejects.toThrow(
      "Unable to load a supported Codex access token",
    );
  });

  it("keeps credentials out of process arguments and excludes control/cache mounts", async () => {
    const { input, root } = await fixture();
    const auth = join(root, "auth.json");
    await writeFile(auth, JSON.stringify({ tokens: { access_token: "private-access-test" } }), {
      mode: 0o600,
    });
    const { launch } = await createCodexLauncher(
      { ...input, authCachePath: auth },
      fileURLToPath(import.meta.url),
    );
    const command = await codexLaunchCommand(launch, ["exec", "--version"]);
    const policy = join(launch.controlDirectory, "config.toml");
    const policyMount = command.args.indexOf(policy);
    expect(command.args.slice(policyMount - 1, policyMount + 2)).toEqual([
      "--ro-bind",
      policy,
      join(input.confinement.providerHome, "config.toml"),
    ]);
    expect(command.env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(JSON.stringify(command.args)).not.toContain("private-access-test");
    expect(command.args).not.toContain(auth);
    expect(command.args).not.toContain(input.controlDirectory);
    await expect(
      codexLaunchCommand({ ...launch, controlDirectory: input.confinement.scratch }, [
        "exec",
        "--version",
      ]),
    ).rejects.toThrow("outside agent storage");
    await expect(
      codexLaunchCommand(
        { ...launch, authCachePath: join(input.confinement.workspace, "auth.json") },
        ["exec", "--version"],
      ),
    ).rejects.toThrow("outside agent storage");
  });

  it("admits only bounded, private, exact-generation stop receipts", async () => {
    const { input, root } = await fixture();
    const { launch } = await createCodexLauncher(input, fileURLToPath(import.meta.url));
    expect(await readCodexLaunchStop(launch)).toBeNull();
    const path = join(input.controlDirectory, "stopped.json");
    const receipt = {
      generation: launch.generation,
      stoppedAt: new Date().toISOString(),
      kind: "stopped",
      code: 0,
      signal: null,
      interrupted: false,
      processTreeStopped: true,
    };
    await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
    expect(await readCodexLaunchStop(launch)).toEqual(receipt);
    await expect(readCodexLaunchStop({ ...launch, generation: randomUUID() })).rejects.toThrow(
      "generation changed",
    );
    await writeFile(path, JSON.stringify({ ...receipt, processTreeStopped: false }));
    await expect(readCodexLaunchStop(launch)).rejects.toThrow();
    await writeFile(path, "x".repeat(2049));
    await expect(readCodexLaunchStop(launch)).rejects.toThrow("bounded");
    await rm(path);
    const untrusted = join(root, "artifacts", "receipt.json");
    await writeFile(untrusted, JSON.stringify(receipt), { mode: 0o600 });
    await symlink(untrusted, path);
    await expect(readCodexLaunchStop(launch)).rejects.toThrow("canonical");
  });

  it.runIf(process.env.EPICD_CODEX_CONFINEMENT === "1")(
    "executes the selected binary and writes a generation-bound stop receipt",
    async () => {
      const { input } = await fixture();
      const { executable, launch } = await createCodexLauncher(
        input,
        join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
      );
      const result = await runCommand(executable, ["exec", "--version"], {
        cwd: input.confinement.workspace,
        timeoutMs: 10_000,
      });
      expect(result.stdout).toMatch(/^codex-cli-exec \d+\.\d+\.\d+\n$/);
      const receipt = JSON.parse(
        await readFile(join(input.controlDirectory, "stopped.json"), "utf8"),
      );
      expect(receipt).toMatchObject({
        generation: launch.generation,
        code: 0,
        interrupted: false,
        processTreeStopped: true,
      });
      await expect(
        runCommand(executable, ["exec", "--version"], {
          cwd: input.confinement.workspace,
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow();
      expect(await readCodexLaunchStop(launch)).toEqual(receipt);
    },
  );

  it.runIf(process.env.EPICD_CODEX_CONFINEMENT === "1")(
    "records a rejected launch as not started without running the model",
    async () => {
      const { input } = await fixture();
      const { launch, executable } = await createCodexLauncher(
        input,
        join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
      );
      await expect(
        runCommand(executable, ["exec", "--sandbox", "danger-full-access"], {
          cwd: input.confinement.workspace,
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow();
      expect(await readCodexLaunchStop(launch)).toMatchObject({
        generation: launch.generation,
        kind: "not_started",
        code: null,
        signal: null,
        processTreeStopped: true,
      });
    },
  );

  it.runIf(process.env.EPICD_CODEX_CONFINEMENT === "1")(
    "reconnects to the exact live launcher and confirms interruption without a model request",
    async () => {
      const { input } = await fixture();
      const { executable, launch } = await createCodexLauncher(
        input,
        join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
      );
      // Keep stdin open so the real Codex exec process waits for input before any model request.
      const child = spawn(executable, ["exec", "--json", "--skip-git-repo-check"], {
        cwd: input.confinement.workspace,
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const closed = once(child, "close");
      let diagnostics = "";
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostics += chunk.toString();
      });
      child.stdout.resume();
      try {
        let running = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            running = (await controlCodexLaunch(launch, "inspect")).state === "running";
          } catch {}
          if (running) break;
          await delay(20);
        }
        expect(running, diagnostics).toBe(true);
        await expect(
          controlCodexLaunch({ ...launch, generation: randomUUID() }, "interrupt"),
        ).rejects.toThrow();
        expect((await controlCodexLaunch(launch, "inspect")).state).toBe("running");
        expect((await controlCodexLaunch(launch, "interrupt")).state).toBe("stopping");
        expect((await closed)[0]).toBe(130);
        expect(
          JSON.parse(await readFile(join(input.controlDirectory, "stopped.json"), "utf8")),
        ).toMatchObject({
          generation: launch.generation,
          kind: "stopped",
          interrupted: true,
          processTreeStopped: true,
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await closed;
      }
    },
    15_000,
  );

  it.runIf(process.env.EPICD_LIVE_ORCHESTRATOR === "1")(
    "runs and resumes authenticated Astra SDK turns through fresh confined launchers",
    async () => {
      const { input, root } = await fixture();
      const authCachePath = await realpath(
        join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
      );
      const { executable, launch } = await createCodexLauncher(
        { ...input, authCachePath },
        join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
      );
      const codex = new Codex({ codexPathOverride: executable, env: { PATH: "/usr/bin:/bin" } });
      const thread = codex.startThread({
        model: "gpt-6-astra",
        modelReasoningEffort: "high",
        workingDirectory: input.confinement.workspace,
        skipGitRepoCheck: true,
        approvalPolicy: "never",
      });
      const remembered = randomUUID();
      const result = await thread.run(
        `Remember this run-local word for a follow-up: ${remembered}. Return JSON with status set to observed. Do not call tools; this is a bounded model availability check.`,
        {
          signal: AbortSignal.timeout(90_000),
          outputSchema: {
            type: "object",
            properties: { status: { type: "string", enum: ["observed"] } },
            required: ["status"],
            additionalProperties: false,
          },
        },
      );
      expect(JSON.parse(result.finalResponse)).toEqual({ status: "observed" });
      expect(thread.id).toBeTruthy();
      expect(result.usage?.output_tokens).toBeGreaterThan(0);
      expect(
        JSON.parse(await readFile(join(input.controlDirectory, "stopped.json"), "utf8")),
      ).toMatchObject({ generation: launch.generation, code: 0, processTreeStopped: true });
      expect(await readFile(join(input.confinement.workspace, "source.txt"), "utf8")).toBe(
        "approved source\n",
      );
      // The prior process is confirmed stopped. A new one resumes only this
      // provider session; the second prompt/schema do not contain its remembered value.
      const controlDirectory = join(root, "control-resume");
      await mkdir(controlDirectory, { mode: 0o700 });
      roots.find((entry) => entry.path === root)!.controls.push("control-resume");
      const resumed = await createCodexLauncher(
        { ...input, authCachePath, controlDirectory },
        join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
      );
      const nextClient = new Codex({
        codexPathOverride: resumed.executable,
        env: { PATH: "/usr/bin:/bin" },
      });
      const nextThread = nextClient.resumeThread(thread.id!, {
        model: "gpt-6-astra",
        modelReasoningEffort: "high",
        workingDirectory: input.confinement.workspace,
        skipGitRepoCheck: true,
        approvalPolicy: "never",
      });
      const next = await nextThread.run(
        "Return the exact run-local word from the preceding turn in JSON under memory. Do not call tools.",
        {
          signal: AbortSignal.timeout(90_000),
          outputSchema: {
            type: "object",
            properties: { memory: { type: "string" } },
            required: ["memory"],
            additionalProperties: false,
          },
        },
      );
      expect(JSON.parse(next.finalResponse)).toEqual({ memory: remembered });
      expect(nextThread.id).toBe(thread.id);
      expect(resumed.launch.generation).not.toBe(launch.generation);
      expect(await readCodexLaunchStop(resumed.launch)).toMatchObject({
        generation: resumed.launch.generation,
        code: 0,
        processTreeStopped: true,
      });
    },
    190_000,
  );
});
