import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrRuntime } from "../src/adapters/herdr.js";
import type { AgentSessionSpec, OpenedAgentSession } from "../src/adapters/runtime.js";
import type {
  AgentAccessMode,
  AgentRoleSettings,
  HerdrAgentSessionContract,
} from "../src/domain/types.js";

const AGENT_NAMESPACE = "0123456789abcdef0123";

const tempDirs: string[] = [];
const originalEnvironment = {
  herdr: process.env.HERDR_ENV,
  workspace: process.env.HERDR_WORKSPACE_ID,
  state: process.env.XDG_STATE_HOME,
  log: process.env.EPICD_HERDR_LOG,
  mode: process.env.EPICD_HERDR_MODE,
  runPrefix: process.env.EPICD_HERDR_RUN_PREFIX,
};

afterEach(() => {
  restore("HERDR_ENV", originalEnvironment.herdr);
  restore("HERDR_WORKSPACE_ID", originalEnvironment.workspace);
  restore("XDG_STATE_HOME", originalEnvironment.state);
  restore("EPICD_HERDR_LOG", originalEnvironment.log);
  restore("EPICD_HERDR_MODE", originalEnvironment.mode);
  restore("EPICD_HERDR_RUN_PREFIX", originalEnvironment.runPrefix);
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fixture(): { root: string; herdr: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "epicd-herdr-"));
  tempDirs.push(root);
  const herdr = join(root, "herdr-fake");
  const log = join(root, "calls.jsonl");
  writeFileSync(
    herdr,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.EPICD_HERDR_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "tab" && args[1] === "create") {
  const paneId = process.env.EPICD_HERDR_MODE === "invalid-create" ? 42 : "w-test:p9";
  console.log(JSON.stringify({ok:true,result:{root_pane:{pane_id:paneId}}}));
} else if (args[0] === "agent" && args[1] === "start") {
  console.log(JSON.stringify({ok:true,result:{agent:{name:args[2]}}}));
} else if (args[0] === "agent" && args[1] === "get") {
  const state = process.env.EPICD_HERDR_MODE === "blocked" ? "blocked" : "idle";
  console.log(JSON.stringify({ok:true,result:{agent:{name:args[2],agent_status:state,interactive_ready:state === "idle",tab_id:"w-test:t9",pane_id:"w-test:p9",terminal_id:"terminal-9"}}}));
} else if (args[0] === "agent" && args[1] === "list") {
  const prefix = process.env.EPICD_HERDR_RUN_PREFIX;
  const agents = [
    {name:"ed-0123456789abcdef0123-i-complete",tab_id:"w-test:t9"},
    ...(prefix ? [
    {name:"ed-" + prefix + "-i-orphan",tab_id:"w-test:t10"},
    ] : []),
    {name:"unrelated-agent",tab_id:"w-test:t11"}
  ];
  console.log(JSON.stringify({ok:true,result:{agents}}));
} else if (args[0] === "agent" && args[1] === "wait") {
  console.log(JSON.stringify({ok:true,result:{state:"idle"}}));
} else if (args[0] === "agent" && args[1] === "send-keys") {
  console.log(JSON.stringify({ok:true}));
} else if (args[0] === "tab" && args[1] === "close") {
  console.log(JSON.stringify({ok:true,result:{}}));
} else if (args[0] === "agent" && args[1] === "prompt") {
  if (process.env.EPICD_HERDR_MODE === "hang") setInterval(() => {}, 1000);
  else {
    const marker = "write only the final JSON object to ";
    const start = args[3].indexOf(marker) + marker.length;
    const rest = args[3].slice(start);
    const resultPath = JSON.parse(rest.slice(0, rest.indexOf(". It must")));
    fs.writeFileSync(resultPath + ".tmp", JSON.stringify({answer:"ok"}));
    fs.renameSync(resultPath + ".tmp", resultPath);
    console.log(JSON.stringify({ok:true,result:{state:"idle"}}));
  }
} else process.exit(2);
`,
  );
  chmodSync(herdr, 0o755);
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = "w-test";
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.EPICD_HERDR_LOG = log;
  return { root, herdr, log };
}

function createRuntime(
  setup: ReturnType<typeof fixture>,
  runId: string,
  accessMode: AgentAccessMode = "sandboxed",
): HerdrRuntime {
  return new HerdrRuntime({
    repoPath: setup.root,
    runId,
    agentNamespace: AGENT_NAMESPACE,
    herdrPath: setup.herdr,
    accessMode,
  });
}

describe("HerdrRuntime", () => {
  it.each(["new", "existing"] as const)(
    "rejects a foreign %s contract before returning a Herdr handle",
    async (kind) => {
      const runtime = createRuntime(fixture(), "foreign-contract");
      const contract = {
        runtime: "sdk" as const,
        requested: { model: "gpt-explicit", reasoningEffort: "high" as const },
        effective: { model: "gpt-explicit", reasoningEffort: "high" as const },
      };
      const spec: AgentSessionSpec<"sdk"> =
        kind === "new"
          ? { kind, contract }
          : { kind, contract, sessionId: `ed-${AGENT_NAMESPACE}-r-existing` };
      // @ts-expect-error Untyped callers must not produce contradictory runtime discriminants.
      await expect(runtime.open("review", spec)).rejects.toThrow("runtime");
    },
  );

  it("owns and freezes prepared settings independently of its caller", async () => {
    const runtime = createRuntime(fixture(), "immutable-preparation");
    const settings: AgentRoleSettings = { model: null, reasoningEffort: "high" };
    const contract = await runtime.prepareNewSession("review", settings);
    settings.model = "gpt-changed";
    settings.reasoningEffort = "low";
    expect(contract.requested).toEqual({ model: null, reasoningEffort: "high" });
    expect(contract.effective).toEqual(contract.requested);
    expect(Reflect.set(contract.effective, "model", "gpt-changed")).toBe(false);
    expect(Reflect.set(contract.requested, "reasoningEffort", "low")).toBe(false);
    expect(Reflect.set(contract, "runtime", "sdk")).toBe(false);
  });

  it.each(["new", "existing"] as const)(
    "copies and freezes a supplied %s contract before opening",
    async (kind) => {
      const runtime = createRuntime(fixture(), "immutable-open");
      const settings: AgentRoleSettings = { model: null, reasoningEffort: "high" };
      const contract: HerdrAgentSessionContract = {
        runtime: "herdr",
        requested: settings,
        effective: settings,
      };
      const opened = await runtime.open(
        "review",
        kind === "new"
          ? { kind, contract }
          : { kind, contract, sessionId: `ed-${AGENT_NAMESPACE}-r-existing` },
      );
      settings.model = "gpt-changed";
      expect(opened.contract.effective.model).toBeNull();
      expect(opened.contract.requested.model).toBeNull();
      expect(Reflect.set(opened.contract.effective, "model", "gpt-changed")).toBe(false);
      expect(Reflect.set(opened, "contract", contract)).toBe(false);
    },
  );

  it("rejects a session opened by another runtime", async () => {
    const setup = fixture();
    const runtime = createRuntime(setup, "foreign-session-run");
    const foreignSession = { runtime: "sdk" } as OpenedAgentSession;

    // @ts-expect-error Exercise the runtime guard for untyped callers too.
    await expect(runtime.run(foreignSession, "Review")).rejects.toThrow(
      "Herdr runtime received a non-Herdr session",
    );
  });

  it("creates a visible Codex agent and resumes it through an opaque session id", async () => {
    const setup = fixture();
    const runtime = createRuntime(setup, "12345678-run");
    const events: string[] = [];
    const session = await runtime.open("implementation", {
      kind: "new",
      settings: { model: "gpt-live", reasoningEffort: "max" },
    });
    const first = await runtime.run(session, "Do the task", {
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
      onEvent: (event) => {
        if (event.type === "session.started") events.push(event.sessionId);
      },
    });
    expect(JSON.parse(first.finalResponse)).toEqual({ answer: "ok" });
    expect(first.sessionId).toMatch(/^ed-0123456789abcdef0123-i-/);
    expect(events).toEqual([first.sessionId]);

    const resumed = await runtime.open("implementation", {
      kind: "existing",
      sessionId: first.sessionId,
      contract: {
        runtime: "herdr",
        requested: { model: "gpt-live", reasoningEffort: "max" },
        effective: { model: "gpt-live", reasoningEffort: "max" },
      },
    });
    const second = await runtime.run(resumed, "Continue", {
      outputSchema: { type: "object" },
    });
    expect(second.sessionId).toBe(first.sessionId);

    const calls = readFileSync(setup.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const create = calls.find((args) => args[0] === "tab" && args[1] === "create");
    expect(create).toContain("--no-focus");
    expect(create).toContain("w-test");
    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    expect(start).toContain("gpt-live");
    expect(start).toContain('model_reasoning_effort="max"');
    expect(calls.filter((args) => args[0] === "agent" && args[1] === "start")).toHaveLength(1);
    expect(start).toContain("workspace-write");
    expect(start?.[start.indexOf("--add-dir") + 1]).toContain(first.sessionId);
    expect(
      calls
        .filter((args) => args[0] === "agent" && args[1] === "prompt")
        .every((args) => !args.includes("--wait")),
    ).toBe(true);
    expect(calls.some((args) => args[0] === "agent" && args[1] === "get")).toBe(true);
  });

  it("does not sweep another turn's unacknowledged artifacts", async () => {
    const setup = fixture();
    const root = join(setup.root, "state", "epicd", "herdr", "artifact-run");
    mkdirSync(root, { recursive: true });
    const preserved = join(root, "old-result.json");
    writeFileSync(preserved, "unacknowledged");
    const runtime = createRuntime(setup, "artifact-run");
    const first = await runtime.open("review", {
      kind: "new",
      settings: { model: "gpt-test", reasoningEffort: "high" },
    });
    const second = await runtime.open("review", {
      kind: "new",
      settings: { model: "gpt-test", reasoningEffort: "high" },
    });
    const results = await Promise.all([
      runtime.run(first, "Review one"),
      runtime.run(second, "Review two"),
    ]);
    expect(results.every((value) => JSON.parse(value.finalResponse).answer === "ok")).toBe(true);
    expect(readFileSync(preserved, "utf8")).toBe("unacknowledged");
  });

  it("does not submit a prompt or accept a result from an approval dialog", async () => {
    const setup = fixture();
    process.env.EPICD_HERDR_MODE = "blocked";
    const runtime = createRuntime(setup, "blocked-run");
    const opened = await runtime.open("review", {
      kind: "new",
      settings: { model: "gpt-test", reasoningEffort: "high" },
    });
    await expect(runtime.run(opened, "Review")).rejects.toThrow("Herdr turn failed");
    const calls = readFileSync(setup.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.some((args) => args[0] === "agent" && args[1] === "prompt")).toBe(false);
  });

  it("runs a prepared session through a replacement adapter instance", async () => {
    const setup = fixture();
    const firstRuntime = createRuntime(setup, "replacement-adapter-run");
    const secondRuntime = createRuntime(setup, "replacement-adapter-run");
    const opened = await firstRuntime.open("implementation", {
      kind: "new",
      settings: { model: "gpt-live", reasoningEffort: "high" },
    });

    const result = await secondRuntime.run(opened, "Do the task", {
      outputSchema: { type: "object" },
    });

    expect(result.sessionId).toMatch(/^ed-0123456789abcdef0123-i-/);
    const calls = readFileSync(setup.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.find((args) => args[0] === "agent" && args[1] === "start")).toContain("gpt-live");
  });

  it("delegates model selection to the Herdr-managed Codex agent", async () => {
    const setup = fixture();
    const runtime = createRuntime(setup, "delegated-model-run");

    const opened = await runtime.open("review", {
      kind: "new",
      settings: { model: null, reasoningEffort: "xhigh" },
    });
    await runtime.run(opened, "Review", { outputSchema: { type: "object" } });

    const calls = readFileSync(setup.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    expect(start).not.toContain("--model");
    expect(start).toContain('model_reasoning_effort="xhigh"');
  });

  it("closes run-owned tabs through the Herdr server outside a managed pane", async () => {
    const setup = fixture();
    process.env.EPICD_HERDR_RUN_PREFIX = AGENT_NAMESPACE;
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_WORKSPACE_ID;
    const runtime = createRuntime(setup, "cleanup1-run");

    await runtime.release(`ed-${AGENT_NAMESPACE}-i-complete`);
    await runtime.releaseAll();

    const calls = readFileSync(setup.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls).toContainEqual(["tab", "close", "w-test:t9"]);
    expect(calls).toContainEqual(["tab", "close", "w-test:t10"]);
    expect(calls).not.toContainEqual(["tab", "close", "w-test:t11"]);
  });

  it("interrupts the Herdr agent when the controlling signal is aborted", async () => {
    const setup = fixture();
    process.env.EPICD_HERDR_MODE = "hang";
    const runtime = createRuntime(setup, "87654321-run");
    const controller = new AbortController();
    const opened = await runtime.open("review", {
      kind: "new",
      settings: { model: "gpt-test", reasoningEffort: "xhigh" },
    });
    const pending = runtime.run(opened, "Review", {
      outputSchema: { type: "object" },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("operator interrupt")), 50);
    await expect(pending).rejects.toThrow("operator interrupt");
    const calls = readFileSync(setup.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(
      calls.some(
        (args) => args[0] === "agent" && args[1] === "send-keys" && args.at(-1) === "ctrl+c",
      ),
    ).toBe(true);
  });

  it("forwards the explicit dangerous full-access opt-in to Codex", async () => {
    const setup = fixture();
    const runtime = createRuntime(setup, "full-access-run", "danger-full-access");

    const opened = await runtime.open("implementation", {
      kind: "new",
      settings: { model: "gpt-test", reasoningEffort: "high" },
    });
    await runtime.run(opened, "Run Docker", { outputSchema: { type: "object" } });

    const calls = readFileSync(setup.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    expect(start).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(start).not.toContain("workspace-write");
    expect(start).not.toContain("sandbox_workspace_write.network_access=false");
  });

  it("rejects a structurally invalid Herdr creation response", async () => {
    const setup = fixture();
    process.env.EPICD_HERDR_MODE = "invalid-create";
    const runtime = createRuntime(setup, "invalid-envelope");

    const opened = await runtime.open("review", {
      kind: "new",
      settings: { model: "gpt-test", reasoningEffort: "xhigh" },
    });
    await expect(runtime.run(opened, "Review")).rejects.toThrow(
      "Could not start Herdr review agent",
    );
  });

  it("refuses to operate outside a Herdr-managed environment", async () => {
    const setup = fixture();
    delete process.env.HERDR_ENV;
    const runtime = createRuntime(setup, "outside-run");
    const opened = await runtime.open("orchestrator", {
      kind: "new",
      settings: { model: "gpt-test", reasoningEffort: "high" },
    });
    await expect(runtime.run(opened, "Select")).rejects.toThrow("HERDR_ENV=1");
  });

  it("refuses to release a session outside the run namespace", async () => {
    const setup = fixture();
    const runtime = createRuntime(setup, "owned-run");

    await expect(runtime.release("unrelated-agent")).rejects.toThrow("not owned by this run");
  });
});
