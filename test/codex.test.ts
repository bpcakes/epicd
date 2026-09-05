import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRuntime } from "../src/adapters/codex.js";
import type { OpenedAgentSession } from "../src/adapters/runtime.js";
import {
  codexProcessEnvironment,
  resolveCodexModel,
  resolveCodexExecutable,
  resolveSdkCodexExecutable,
  verifyCodexExecutable,
} from "../src/adapters/codex-settings.js";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.EPICD_CODEX_ARGUMENT_LOG;
  delete process.env.EPICD_CODEX_DEFAULT_MODEL;
  delete process.env.EPICD_CODEX_EXIT_BEFORE_MODEL;
  delete process.env.EPICD_CODEX_MODEL_CHILD_PID_FILE;
  delete process.env.EPICD_CODEX_GRANDCHILD_PID_FILE;
  delete process.env.EPICD_CODEX_IGNORE_SIGTERM;
  delete process.env.EPICD_CODEX_PID_FILE;
  delete process.env.EPICD_CODEX_FAIL_STARTUP;
  delete process.env.EPICD_CODEX_FAIL_STARTUP_ONCE;
  delete process.env.EPICD_CODEX_FAIL_VERSION;
  delete process.env.EPICD_CODEX_HANG;
  delete process.env.EPICD_CODEX_MALFORMED;
  delete process.env.EPICD_CODEX_APP_SERVER_COUNT;
  delete process.env.EPICD_CODEX_MODEL_PAGES;
  delete process.env.EPICD_CODEX_ENDLESS_CURSOR;
  delete process.env.EPICD_CODEX_REPEATED_CURSOR;
  delete process.env.EPICD_CODEX_SERVER_REQUEST;
  delete process.env.EPICD_CODEX_RPC_ERROR;
  delete process.env.EPICD_CODEX_RPC_ERROR_DETAIL;
  delete process.env.EPICD_CODEX_EMPTY_MODELS;
  delete process.env.EPICD_CODEX_DYNAMIC_ENV;
  delete process.env.EPICD_CODEX_ENV_LOG;
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeCodex(): { executable: string; argumentLog: string } {
  const directory = mkdtempSync(join(tmpdir(), "epicd-codex-test-"));
  tempDirs.push(directory);
  const executable = join(directory, "codex-fake");
  const argumentLog = join(directory, "arguments.json");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "app-server") {
  let grandchild;
  if (process.env.EPICD_CODEX_GRANDCHILD_PID_FILE) {
    const { spawn } = require("node:child_process");
    grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(process.env.EPICD_CODEX_GRANDCHILD_PID_FILE, String(grandchild.pid));
  }
  let appServerCount = 0;
  if (process.env.EPICD_CODEX_APP_SERVER_COUNT) {
    let count = 0;
    try { count = Number(fs.readFileSync(process.env.EPICD_CODEX_APP_SERVER_COUNT, "utf8")); } catch {}
    appServerCount = count + 1;
    fs.writeFileSync(process.env.EPICD_CODEX_APP_SERVER_COUNT, String(appServerCount));
  }
  if (process.env.EPICD_CODEX_PID_FILE) fs.writeFileSync(process.env.EPICD_CODEX_PID_FILE, String(process.pid));
  process.on("SIGTERM", () => {
    if (grandchild) grandchild.kill("SIGTERM");
    if (process.env.EPICD_CODEX_IGNORE_SIGTERM !== "1") process.exit(0);
  });
  if (process.env.EPICD_CODEX_FAIL_STARTUP === "1") {
    console.error("invalid Codex configuration");
    process.exit(7);
  }
  if (process.env.EPICD_CODEX_FAIL_STARTUP_ONCE === "1" && appServerCount === 1) {
    process.exit(7);
  }
  const lines = require("node:readline").createInterface({ input: process.stdin });
  lines.on("line", line => {
    if (process.env.EPICD_CODEX_HANG === "1") return;
    const message = JSON.parse(line);
    if ("jsonrpc" in message) {
      console.error("app-server wire messages must omit the jsonrpc header");
      process.exit(9);
    }
    if (message.method === "initialize") {
      if (process.env.EPICD_CODEX_MALFORMED === "1") { console.log("{"); return; }
      console.log(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.method === "config/read") {
      if (process.env.EPICD_CODEX_EXIT_BEFORE_MODEL === "1") {
        const { spawn } = require("node:child_process");
        const response = JSON.stringify({ id: message.id, result: { config: { model: "gpt-default" } } });
        const modelChild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => console.log(process.env.RESPONSE), 50); setInterval(() => {}, 1000)"], {
          stdio: ["ignore", "inherit", "inherit"],
          env: { ...process.env, RESPONSE: response },
        });
        fs.writeFileSync(process.env.EPICD_CODEX_MODEL_CHILD_PID_FILE, String(modelChild.pid));
        modelChild.unref();
        process.exit(0);
      }
      if (process.env.EPICD_CODEX_SERVER_REQUEST === "1") {
        console.log(JSON.stringify({ id: message.id, method: "item/tool/requestUserInput", params: {} }));
      }
      console.log(JSON.stringify({
        id: message.id,
        result: { config: { model: process.env.EPICD_CODEX_DEFAULT_MODEL === "__none__" ? null : process.env.EPICD_CODEX_DEFAULT_MODEL || "gpt-default" } }
      }));
    } else if (message.method === "model/list") {
      if (process.env.EPICD_CODEX_RPC_ERROR === "1") {
        console.log(JSON.stringify({ id: message.id, error: { message: process.env.EPICD_CODEX_RPC_ERROR_DETAIL || "private diagnostic" } }));
        return;
      }
      if (process.env.EPICD_CODEX_EMPTY_MODELS === "1") {
        console.log(JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } }));
        return;
      }
      if (process.env.EPICD_CODEX_REPEATED_CURSOR === "1") {
        console.log(JSON.stringify({ id: message.id, result: { data: [], nextCursor: "same-page" } }));
        return;
      }
      if (process.env.EPICD_CODEX_ENDLESS_CURSOR === "1") {
        console.log(JSON.stringify({ id: message.id, result: { data: [], nextCursor: "page-" + message.id } }));
        return;
      }
      if (process.env.EPICD_CODEX_MODEL_PAGES === "1" && !message.params.cursor) {
        console.log(JSON.stringify({ id: message.id, result: { data: [], nextCursor: "page-2" } }));
        return;
      }
      console.log(JSON.stringify({
        id: message.id,
        result: { data: [{ model: "gpt-advertised", isDefault: true }], nextCursor: null }
      }));
    }
  });
} else {
  if (args[0] === "--version") {
    if (process.env.EPICD_CODEX_FAIL_VERSION === "1") {
      console.error("Missing optional dependency @openai/codex-test-platform");
      process.exit(1);
    }
    console.log("codex-cli 0.151.0-test");
    process.exit(0);
  }
  fs.writeFileSync(process.env.EPICD_CODEX_ARGUMENT_LOG, JSON.stringify(args));
  if (process.env.EPICD_CODEX_ENV_LOG) fs.writeFileSync(process.env.EPICD_CODEX_ENV_LOG, process.env.EPICD_CODEX_DYNAMIC_ENV || "");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thr-test" }));
  console.log(JSON.stringify({
    type: "item.completed",
    item: { id: "item-1", type: "agent_message", text: "done" }
  }));
}
`,
  );
  chmodSync(executable, 0o755);
  return { executable, argumentLog };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").match(/^\d+ \(.*\) ([A-Z])/)?.[1];
    return state !== "Z";
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} did not exit`);
}

describe("CodexRuntime sessions", () => {
  it("normalizes a path-like executable override before using another repository cwd", async () => {
    const setup = fakeCodex();
    const repoPath = mkdtempSync(join(tmpdir(), "epicd-codex-repo-"));
    tempDirs.push(repoPath);
    const configuredPath = relative(process.cwd(), setup.executable);

    expect(resolveCodexExecutable(configuredPath).executablePath).toBe(resolve(setup.executable));
    await expect(resolveCodexModel(repoPath, { codexPath: configuredPath })).resolves.toBe(
      "gpt-default",
    );
  });

  it("rejects a session opened by another runtime", async () => {
    const setup = fakeCodex();
    const runtime = new CodexRuntime({
      repoPath: process.cwd(),
      codexPath: setup.executable,
      accessMode: "sandboxed",
    });
    const foreignSession = { runtime: "herdr" } as OpenedAgentSession;

    // @ts-expect-error Exercise the runtime guard for untyped callers too.
    await expect(runtime.run(foreignSession, "Review")).rejects.toThrow(
      "Codex runtime received a non-SDK session",
    );
  });

  it("locates the SDK-bundled Codex executable", () => {
    const executable = resolveSdkCodexExecutable();
    expect(executable.executablePath).toBe(process.execPath);
    expect(executable.args).toHaveLength(1);
    expect(existsSync(executable.args[0] ?? "")).toBe(true);
    expect(
      execFileSync(executable.executablePath, [...executable.args, "--version"], {
        encoding: "utf8",
      }),
    ).toContain("codex-cli");
  });

  it("checks model discovery against the bundled app-server protocol schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "epicd-codex-schema-"));
    tempDirs.push(directory);
    const executable = resolveSdkCodexExecutable();
    execFileSync(
      executable.executablePath,
      [...executable.args, "app-server", "generate-json-schema", "--out", directory],
      { timeout: 10_000 },
    );

    const requests = readFileSync(join(directory, "ClientRequest.json"), "utf8");
    const notifications = readFileSync(join(directory, "ClientNotification.json"), "utf8");
    const protocol = JSON.parse(
      readFileSync(join(directory, "codex_app_server_protocol.v2.schemas.json"), "utf8"),
    ) as {
      definitions: Record<
        string,
        {
          properties?: Record<string, { $ref?: string; type?: unknown; items?: { $ref?: string } }>;
          required?: string[];
        }
      >;
    };
    expect(requests).toContain('"initialize"');
    expect(requests).toContain('"config/read"');
    expect(requests).toContain('"model/list"');
    expect(notifications).toContain('"initialized"');
    expect(protocol.definitions.ConfigReadResponse?.properties?.config?.$ref).toBe(
      "#/definitions/Config",
    );
    expect(protocol.definitions.Config?.properties?.model?.type).toEqual(["string", "null"]);
    expect(protocol.definitions.ModelListResponse?.properties?.data?.items?.$ref).toBe(
      "#/definitions/Model",
    );
    expect(protocol.definitions.ModelListResponse?.required).toContain("data");
    expect(protocol.definitions.Model?.required).toEqual(
      expect.arrayContaining(["model", "isDefault"]),
    );
    expect(protocol.definitions.ModelListResponse?.properties?.nextCursor?.type).toEqual([
      "string",
      "null",
    ]);
  });

  it("defers executable resolution until a thread is opened", async () => {
    const missing = join(tmpdir(), "definitely-missing-epicd-codex");
    const runtime = new CodexRuntime({
      repoPath: process.cwd(),
      codexPath: missing,
      accessMode: "sandboxed",
    });

    await expect(runtime.release("thr-old")).resolves.toBeUndefined();
    await expect(runtime.releaseAll()).resolves.toBeUndefined();
    await expect(
      runtime.open("review", {
        kind: "new",
        settings: { model: "gpt-test", reasoningEffort: "xhigh" },
      }),
    ).rejects.toThrow("Configured Codex executable does not exist");
  });

  it("preserves bare-command executable overrides for PATH resolution", () => {
    expect(resolveCodexExecutable("codex")).toEqual({
      executablePath: "codex",
      args: [],
    });
  });

  it("verifies a selected Codex command by executing its version entry point", async () => {
    const setup = fakeCodex();
    const executable = resolveCodexExecutable(setup.executable);

    await expect(verifyCodexExecutable(process.cwd(), executable)).resolves.toContain(
      `${setup.executable} — codex-cli 0.151.0-test`,
    );
  });

  it("rejects a missing bare-command executable during verification", async () => {
    const executable = resolveCodexExecutable("definitely-missing-epicd-codex-command");

    await expect(verifyCodexExecutable(process.cwd(), executable)).rejects.toThrow("ENOENT");
  });

  it("surfaces a pinned shim's missing optional platform package during verification", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_FAIL_VERSION = "1";

    await expect(
      verifyCodexExecutable(process.cwd(), resolveCodexExecutable(setup.executable)),
    ).rejects.toThrow("Missing optional dependency @openai/codex-test-platform");
  });

  it("copies defined process variables without inventing executable search paths", () => {
    expect(codexProcessEnvironment({ PATH: "/usr/bin", EMPTY: "", OMITTED: undefined })).toEqual({
      PATH: "/usr/bin",
      EMPTY: "",
    });
  });

  it.each([0, -1, 1.5])("rejects invalid model-resolution attempt count %s", async (attempts) => {
    const setup = fakeCodex();
    await expect(
      resolveCodexModel(process.cwd(), { codexPath: setup.executable, attempts }),
    ).rejects.toThrow("positive integer");
  });

  it("uses Codex's advertised default when configuration does not select a model", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_DEFAULT_MODEL = "__none__";

    await expect(resolveCodexModel(process.cwd(), { codexPath: setup.executable })).resolves.toBe(
      "gpt-advertised",
    );
  });

  it("follows model-list pagination to find the advertised default", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_DEFAULT_MODEL = "__none__";
    process.env.EPICD_CODEX_MODEL_PAGES = "1";

    await expect(resolveCodexModel(process.cwd(), { codexPath: setup.executable })).resolves.toBe(
      "gpt-advertised",
    );
  });

  it("ignores server requests that reuse a client request id", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_SERVER_REQUEST = "1";

    await expect(resolveCodexModel(process.cwd(), { codexPath: setup.executable })).resolves.toBe(
      "gpt-default",
    );
  });

  it("rejects a non-advancing model-list cursor", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_DEFAULT_MODEL = "__none__";
    process.env.EPICD_CODEX_REPEATED_CURSOR = "1";

    await expect(resolveCodexModel(process.cwd(), { codexPath: setup.executable })).rejects.toThrow(
      "repeated pagination cursor",
    );
  });

  it("caps an advancing model-list cursor sequence", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_DEFAULT_MODEL = "__none__";
    process.env.EPICD_CODEX_ENDLESS_CURSOR = "1";

    await expect(resolveCodexModel(process.cwd(), { codexPath: setup.executable })).rejects.toThrow(
      "model list exceeded 20 pages",
    );
  });

  it("surfaces redacted model-list RPC diagnostics", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_DEFAULT_MODEL = "__none__";
    process.env.EPICD_CODEX_RPC_ERROR = "1";
    process.env.EPICD_CODEX_RPC_ERROR_DETAIL = "authentication failed token=secret-value";

    const failure = resolveCodexModel(process.cwd(), { codexPath: setup.executable });
    await expect(failure).rejects.toThrow("model/list failed");
    await expect(failure).rejects.toThrow("authentication failed token=[REDACTED]");
    await expect(failure).rejects.not.toThrow("secret-value");
  });

  it("rejects a model list without an effective default", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_DEFAULT_MODEL = "__none__";
    process.env.EPICD_CODEX_EMPTY_MODELS = "1";

    await expect(resolveCodexModel(process.cwd(), { codexPath: setup.executable })).rejects.toThrow(
      "did not report an effective default model",
    );
  });

  it("waits for app-server shutdown before returning the resolved model", async () => {
    const setup = fakeCodex();
    const pidFile = join(dirname(setup.executable), "app-server.pid");
    process.env.EPICD_CODEX_PID_FILE = pidFile;

    await expect(resolveCodexModel(process.cwd(), { codexPath: setup.executable })).resolves.toBe(
      "gpt-default",
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("kills an app-server that ignores graceful shutdown", async () => {
    const setup = fakeCodex();
    const pidFile = join(dirname(setup.executable), "app-server.pid");
    process.env.EPICD_CODEX_IGNORE_SIGTERM = "1";
    process.env.EPICD_CODEX_PID_FILE = pidFile;

    await expect(resolveCodexModel(process.cwd(), { codexPath: setup.executable })).resolves.toBe(
      "gpt-default",
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("kills a signal-resistant app-server process tree", async () => {
    const setup = fakeCodex();
    const pidFile = join(dirname(setup.executable), "app-server.pid");
    const grandchildPidFile = join(dirname(setup.executable), "app-server-grandchild.pid");
    process.env.EPICD_CODEX_IGNORE_SIGTERM = "1";
    process.env.EPICD_CODEX_PID_FILE = pidFile;
    process.env.EPICD_CODEX_GRANDCHILD_PID_FILE = grandchildPidFile;
    process.env.EPICD_CODEX_HANG = "1";
    let parentPid: number | undefined;
    let grandchildPid: number | undefined;

    try {
      await expect(
        resolveCodexModel(process.cwd(), {
          codexPath: setup.executable,
          attempts: 1,
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow("Timed out while resolving");
      parentPid = Number(readFileSync(pidFile, "utf8"));
      grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
      await waitForProcessExit(parentPid);
      await waitForProcessExit(grandchildPid);
      expect(isProcessRunning(parentPid)).toBe(false);
      expect(isProcessRunning(grandchildPid)).toBe(false);
    } finally {
      for (const pid of [parentPid, grandchildPid]) {
        if (!pid) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already stopped by the implementation under test.
        }
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "kills app-server descendants after the process-group leader exits",
    async () => {
      const setup = fakeCodex();
      const modelChildPidFile = join(dirname(setup.executable), "app-server-model-child.pid");
      process.env.EPICD_CODEX_EXIT_BEFORE_MODEL = "1";
      process.env.EPICD_CODEX_MODEL_CHILD_PID_FILE = modelChildPidFile;
      let modelChildPid: number | undefined;

      try {
        await expect(
          resolveCodexModel(process.cwd(), { codexPath: setup.executable, attempts: 1 }),
        ).resolves.toBe("gpt-default");
        modelChildPid = Number(readFileSync(modelChildPidFile, "utf8"));
        await waitForProcessExit(modelChildPid);
        expect(isProcessRunning(modelChildPid)).toBe(false);
      } finally {
        if (!modelChildPid) return;
        try {
          process.kill(modelChildPid, "SIGKILL");
        } catch {
          // Already stopped by the implementation under test.
        }
      }
    },
  );

  it("surfaces redacted app-server stderr in the durable error message", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_FAIL_STARTUP = "1";

    const failure = resolveCodexModel(process.cwd(), { codexPath: setup.executable });
    await expect(failure).rejects.toThrow("app-server exited with code 7");
    await expect(failure).rejects.toThrow("invalid Codex configuration");
  });

  it("captures the current process environment for each newly opened thread", async () => {
    const setup = fakeCodex();
    const envLog = join(dirname(setup.executable), "environment.log");
    process.env.EPICD_CODEX_ARGUMENT_LOG = setup.argumentLog;
    process.env.EPICD_CODEX_ENV_LOG = envLog;
    const runtime = new CodexRuntime({
      repoPath: process.cwd(),
      codexPath: setup.executable,
      accessMode: "sandboxed",
    });
    process.env.EPICD_CODEX_DYNAMIC_ENV = "after-construction";

    const opened = await runtime.open("review", {
      kind: "new",
      settings: { model: "gpt-test", reasoningEffort: "xhigh" },
    });
    await runtime.run(opened, "Review");

    expect(readFileSync(envLog, "utf8")).toBe("after-construction");
  });

  it("does not retry a completed app-server process exit", async () => {
    const setup = fakeCodex();
    const countFile = join(dirname(setup.executable), "app-server-count");
    process.env.EPICD_CODEX_APP_SERVER_COUNT = countFile;
    process.env.EPICD_CODEX_FAIL_STARTUP_ONCE = "1";

    await expect(
      resolveCodexModel(process.cwd(), { codexPath: setup.executable, attempts: 2 }),
    ).rejects.toThrow("app-server exited with code 7");
    expect(readFileSync(countFile, "utf8")).toBe("1");
  });

  it("times out and terminates an unresponsive app-server", async () => {
    const setup = fakeCodex();
    const countFile = join(dirname(setup.executable), "app-server-count");
    process.env.EPICD_CODEX_APP_SERVER_COUNT = countFile;
    process.env.EPICD_CODEX_HANG = "1";

    await expect(
      resolveCodexModel(process.cwd(), { codexPath: setup.executable, timeoutMs: 1_000 }),
    ).rejects.toThrow("Timed out while resolving");
    expect(readFileSync(countFile, "utf8")).toBe("2");
  });

  it("honors a single model-resolution attempt", async () => {
    const setup = fakeCodex();
    const countFile = join(dirname(setup.executable), "app-server-count");
    process.env.EPICD_CODEX_APP_SERVER_COUNT = countFile;
    process.env.EPICD_CODEX_HANG = "1";

    await expect(
      resolveCodexModel(process.cwd(), {
        codexPath: setup.executable,
        attempts: 1,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("after 1 attempt:");
    expect(readFileSync(countFile, "utf8")).toBe("1");
  });

  it("cancels model resolution through AbortSignal", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_HANG = "1";
    const controller = new AbortController();
    const pending = resolveCodexModel(process.cwd(), {
      codexPath: setup.executable,
      signal: controller.signal,
    });

    controller.abort(new Error("operator cancelled"));

    await expect(pending).rejects.toThrow("operator cancelled");
  });

  it("rejects malformed app-server output", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_MALFORMED = "1";

    await expect(resolveCodexModel(process.cwd(), { codexPath: setup.executable })).rejects.toThrow(
      "malformed JSON-RPC output",
    );
  });

  it("resolves and pins the effective model when the configured model is null", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_ARGUMENT_LOG = setup.argumentLog;
    const runtime = new CodexRuntime({
      repoPath: process.cwd(),
      codexPath: setup.executable,
      accessMode: "sandboxed",
    });

    const opened = await runtime.open("review", {
      kind: "new",
      settings: { model: null, reasoningEffort: "xhigh" },
    });
    const result = await runtime.run(opened, "Review");

    expect(result).toEqual({ sessionId: "thr-test", finalResponse: "done" });
    expect(opened.contract).toEqual({
      runtime: "sdk",
      requested: { model: null, reasoningEffort: "xhigh" },
      effective: { model: "gpt-default", reasoningEffort: "xhigh" },
    });
    const args = JSON.parse(readFileSync(setup.argumentLog, "utf8")) as string[];
    expect(args).toContain("--model");
    expect(args).toContain("gpt-default");
    expect(args).toContain('model_reasoning_effort="xhigh"');
  });

  it("resolves the current default for each new model-less thread", async () => {
    const setup = fakeCodex();
    const countFile = join(dirname(setup.executable), "app-server-count");
    process.env.EPICD_CODEX_APP_SERVER_COUNT = countFile;
    const runtime = new CodexRuntime({
      repoPath: process.cwd(),
      codexPath: setup.executable,
      accessMode: "sandboxed",
    });

    process.env.EPICD_CODEX_DEFAULT_MODEL = "gpt-first";
    const first = await runtime.open("implementation", {
      kind: "new",
      settings: { model: null, reasoningEffort: "high" },
    });
    process.env.EPICD_CODEX_DEFAULT_MODEL = "gpt-second";
    const second = await runtime.open("review", {
      kind: "new",
      settings: { model: null, reasoningEffort: "xhigh" },
    });

    expect(first.contract.effective.model).toBe("gpt-first");
    expect(second.contract.effective.model).toBe("gpt-second");
    expect(readFileSync(countFile, "utf8")).toBe("2");
  });

  it("reuses one discovered default while preparing changed settings", async () => {
    const setup = fakeCodex();
    const countFile = join(dirname(setup.executable), "app-server-count");
    process.env.EPICD_CODEX_APP_SERVER_COUNT = countFile;
    process.env.EPICD_CODEX_DEFAULT_MODEL = "gpt-first";
    const runtime = new CodexRuntime({
      repoPath: process.cwd(),
      codexPath: setup.executable,
      accessMode: "sandboxed",
    });

    const first = await runtime.prepareNewSession("review", {
      model: null,
      reasoningEffort: "high",
    });
    process.env.EPICD_CODEX_DEFAULT_MODEL = "gpt-second";
    const second = await runtime.prepareNewSession(
      "review",
      { model: null, reasoningEffort: "xhigh" },
      first,
    );

    expect(second).toEqual({
      runtime: "sdk",
      requested: { model: null, reasoningEffort: "xhigh" },
      effective: { model: "gpt-first", reasoningEffort: "xhigh" },
    });
    expect(readFileSync(countFile, "utf8")).toBe("1");
  });

  it("passes an explicitly configured model to Codex", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_ARGUMENT_LOG = setup.argumentLog;
    const runtime = new CodexRuntime({
      repoPath: process.cwd(),
      codexPath: setup.executable,
      accessMode: "sandboxed",
    });

    const opened = await runtime.open("implementation", {
      kind: "new",
      settings: { model: "gpt-pinned", reasoningEffort: "high" },
    });
    await runtime.run(opened, "Implement");

    const args = JSON.parse(readFileSync(setup.argumentLog, "utf8")) as string[];
    expect(args).toContain("--model");
    expect(args).toContain("gpt-pinned");
  });

  it("replays explicit pinned model settings for a resumed thread", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_ARGUMENT_LOG = setup.argumentLog;
    const runtime = new CodexRuntime({
      repoPath: process.cwd(),
      codexPath: setup.executable,
      accessMode: "sandboxed",
    });

    const opened = await runtime.open("implementation", {
      kind: "existing",
      sessionId: "thr-existing",
      contract: {
        runtime: "sdk",
        requested: { model: "gpt-pinned", reasoningEffort: "high" },
        effective: { model: "gpt-pinned", reasoningEffort: "high" },
      },
    });
    await runtime.run(opened, "Continue implementation");

    const args = JSON.parse(readFileSync(setup.argumentLog, "utf8")) as string[];
    expect(args).toContain("gpt-pinned");
    expect(args).toContain('model_reasoning_effort="high"');
  });

  it("replays the original effective settings after the local default changes", async () => {
    const setup = fakeCodex();
    process.env.EPICD_CODEX_ARGUMENT_LOG = setup.argumentLog;
    process.env.EPICD_CODEX_DEFAULT_MODEL = "gpt-original";
    const runtime = new CodexRuntime({
      repoPath: process.cwd(),
      codexPath: setup.executable,
      accessMode: "sandboxed",
    });

    const created = await runtime.open("review", {
      kind: "new",
      settings: { model: null, reasoningEffort: "xhigh" },
    });
    process.env.EPICD_CODEX_DEFAULT_MODEL = "gpt-changed";
    const resumed = await runtime.open("review", {
      kind: "existing",
      sessionId: "thr-existing",
      contract: created.contract,
    });
    await runtime.run(resumed, "Continue review");

    const args = JSON.parse(readFileSync(setup.argumentLog, "utf8")) as string[];
    expect(args).toContain("gpt-original");
    expect(args).not.toContain("gpt-changed");
    expect(args).toContain('model_reasoning_effort="xhigh"');
  });

  it("rejects fabricated opened sessions before starting a turn", async () => {
    const runtime = new CodexRuntime({
      repoPath: process.cwd(),
      accessMode: "sandboxed",
    });
    const fabricated = {
      runtime: "sdk" as const,
      session: { runtime: "sdk" as const, id: null, role: "review" as const },
      contract: {
        runtime: "sdk" as const,
        requested: { model: "gpt-test", reasoningEffort: "xhigh" as const },
        effective: { model: "gpt-test", reasoningEffort: "xhigh" as const },
      },
    };

    await expect(runtime.run(fabricated, "Review")).rejects.toThrow("did not create");
  });
});
