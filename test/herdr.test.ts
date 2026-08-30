import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrRuntime } from "../src/adapters/herdr.js";
import type { AgentSession } from "../src/adapters/runtime.js";
import {
  DEFAULT_AGENT_SETTINGS,
  type AgentAccessMode,
  type AgentSettings,
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
  console.log(JSON.stringify({ok:true,result:{agent:{name:args[2],state:"idle",tab_id:"w-test:t9"}}}));
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
  settings: AgentSettings = DEFAULT_AGENT_SETTINGS,
  accessMode: AgentAccessMode = "sandboxed",
): HerdrRuntime {
  return new HerdrRuntime({
    repoPath: setup.root,
    runId,
    agentNamespace: AGENT_NAMESPACE,
    settings,
    herdrPath: setup.herdr,
    accessMode,
  });
}

describe("HerdrRuntime", () => {
  it("creates a visible Codex agent and resumes it through an opaque session id", async () => {
    const setup = fixture();
    const runtime = createRuntime(setup, "12345678-run", {
      ...DEFAULT_AGENT_SETTINGS,
      implementation: { model: "gpt-test", reasoningEffort: "ultra" },
    });
    const events: string[] = [];
    const session = runtime.start("implementation");
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

    const resumed = runtime.resume(first.sessionId, "implementation");
    const second = await runtime.run(resumed, "Continue", { outputSchema: { type: "object" } });
    expect(second.sessionId).toBe(first.sessionId);

    const calls = readFileSync(setup.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const create = calls.find((args) => args[0] === "tab" && args[1] === "create");
    expect(create).toContain("--no-focus");
    expect(create).toContain("w-test");
    const start = calls.find((args) => args[0] === "agent" && args[1] === "start");
    expect(start).toContain("gpt-test");
    expect(start).toContain('model_reasoning_effort="ultra"');
    expect(start).toContain("workspace-write");
    expect(calls.some((args) => args[0] === "agent" && args[1] === "get")).toBe(true);
  });

  it("closes a completed session and all remaining run-owned tabs", async () => {
    const setup = fixture();
    process.env.EPICD_HERDR_RUN_PREFIX = AGENT_NAMESPACE;
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
    const pending = runtime.run(runtime.start("review"), "Review", {
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
    const runtime = createRuntime(
      setup,
      "full-access-run",
      DEFAULT_AGENT_SETTINGS,
      "danger-full-access",
    );

    await runtime.run(runtime.start("implementation"), "Run Docker", {
      outputSchema: { type: "object" },
    });

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

    await expect(runtime.run(runtime.start("review"), "Review")).rejects.toThrow(
      "Could not start Herdr review agent",
    );
  });

  it("refuses to operate outside a Herdr-managed environment", async () => {
    const setup = fixture();
    delete process.env.HERDR_ENV;
    const runtime = createRuntime(setup, "outside-run");
    await expect(runtime.run(runtime.start("orchestrator"), "Select")).rejects.toThrow(
      "HERDR_ENV=1",
    );
  });

  it("rejects sessions belonging to another runtime", async () => {
    const setup = fixture();
    const runtime = createRuntime(setup, "foreign-session");
    const foreignSession: AgentSession = { runtime: "sdk", id: null, role: "review" };

    await expect(runtime.run(foreignSession, "Review")).rejects.toThrow("non-Herdr session");
  });

  it("refuses to release a session outside the run namespace", async () => {
    const setup = fixture();
    const runtime = createRuntime(setup, "owned-run");

    await expect(runtime.release("unrelated-agent")).rejects.toThrow("not owned by this run");
  });
});
