import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunAlreadyControlledError, StateStore } from "../src/adapters/store.js";
import { CodexRuntime } from "../src/adapters/codex.js";
import { GitClient } from "../src/adapters/git.js";
import { HerdrRuntime } from "../src/adapters/herdr.js";
import { assertResumeOptionsAllowed, EpicEngine } from "../src/engine/engine.js";
import {
  AgentCleanupRequiredError,
  WorkflowCompletionReportingError,
} from "../src/engine/errors.js";
import { runCommand } from "../src/util/command.js";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;
const originalHerdrEnvironment = {
  herdr: process.env.HERDR_ENV,
  workspace: process.env.HERDR_WORKSPACE_ID,
  state: process.env.XDG_STATE_HOME,
};

afterEach(() => {
  vi.restoreAllMocks();
  process.env.PATH = originalPath;
  delete process.env.EPICD_FAKE_MODE;
  delete process.env.EPICD_FAKE_COUNTER;
  delete process.env.EPICD_FAKE_ARGS;
  delete process.env.EPICD_FAKE_MODEL_DELAY_MS;
  delete process.env.EPICD_FAKE_MODEL_MARKER;
  delete process.env.EPICD_HERDR_CLOSE_FAIL;
  delete process.env.EPICD_HERDR_REGISTRY;
  restoreEnvironment("HERDR_ENV", originalHerdrEnvironment.herdr);
  restoreEnvironment("HERDR_WORKSPACE_ID", originalHerdrEnvironment.workspace);
  restoreEnvironment("XDG_STATE_HOME", originalHerdrEnvironment.state);
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function executable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(): Promise<{
  repo: string;
  codex: string;
  herdr: string;
  store: StateStore;
}> {
  const root = mkdtempSync(join(tmpdir(), "epicd-e2e-"));
  tempDirs.push(root);
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  mkdirSync(join(repo, ".beads"));
  const issues = [
    {
      id: "demo",
      title: "Demo epic",
      description: "Ship the demo",
      acceptance_criteria: "All tasks verified",
      status: "open",
      priority: 1,
      issue_type: "epic",
      labels: [],
    },
    {
      id: "demo.1",
      title: "Add the feature",
      description: "Create feature.txt",
      acceptance_criteria: "feature.txt exists",
      status: "open",
      priority: 1,
      issue_type: "task",
      labels: [],
    },
  ];
  writeFileSync(join(repo, ".beads", "state.json"), JSON.stringify({ issues }, null, 2));
  writeFileSync(
    join(repo, ".beads", "issues.jsonl"),
    issues.map((issue) => JSON.stringify(issue)).join("\n") + "\n",
  );
  writeFileSync(join(repo, "README.md"), "# fixture\n");

  executable(
    join(bin, "br"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();
const statePath = path.join(root, ".beads", "state.json");
const exportPath = path.join(root, ".beads", "issues.jsonl");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("br fake 1.0"); process.exit(0); }
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); fs.writeFileSync(exportPath, state.issues.map(JSON.stringify).join("\\n") + "\\n"); };
if (args[0] === "list") console.log(JSON.stringify({issues: state.issues, total: state.issues.length, limit: 0, offset: 0, has_more: false}));
else if (args[0] === "show") console.log(JSON.stringify(state.issues.find(i => i.id === args[1])));
else if (args[0] === "ready") console.log(JSON.stringify(state.issues.filter(i => i.status === "open")));
else if (args[0] === "blocked") console.log(JSON.stringify([]));
else if (args[0] === "update") { const issue = state.issues.find(i => i.id === args[1]); const si = args.findIndex(arg => arg.startsWith("--status=")); if (si >= 0) issue.status = args[si].slice("--status=".length); if (args.includes("--claim")) { issue.status = "in_progress"; const ai = args.indexOf("--actor"); issue.assignee = ai >= 0 ? args[ai + 1] : "unknown"; } const ai = args.indexOf("--assignee"); if (ai >= 0) issue.assignee = args[ai + 1]; save(); console.log(JSON.stringify(issue)); }
else if (args[0] === "close") { const issue = state.issues.find(i => i.id === args[1]); issue.status = "closed"; save(); console.log(JSON.stringify(issue)); }
else if (args[0] === "sync") { save(); console.log("synced"); }
else { console.error("unsupported br", args); process.exit(2); }
`,
  );

  executable(
    join(bin, "bv"),
    `#!/usr/bin/env node
const arg = process.argv.slice(2).join(" ");
if (arg === "--version") console.log("bv fake 1.0");
else if (arg.includes("--robot-triage")) console.log(JSON.stringify({triage:{quick_ref:{top_picks:[{id:"demo.1"}]},recommendations:[]}}));
else if (arg.includes("--robot-plan")) console.log(JSON.stringify({plan:{tracks:[{items:["demo.1"]}]}}));
else if (arg.includes("--robot-graph")) console.log(JSON.stringify({nodes:["demo","demo.1"],edges:[{from:"demo.1",to:"demo",type:"parent-child"}]}));
else { console.error("unsupported bv", arg); process.exit(2); }
`,
  );

  const codex = join(bin, "codex-fake");
  process.env.EPICD_FAKE_COUNTER = join(root, "review-counter");
  executable(
    codex,
    `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.EPICD_FAKE_ARGS) fs.appendFileSync(process.env.EPICD_FAKE_ARGS, JSON.stringify(args) + "\\n");
if (args[0] === "app-server") {
  const lines = require("node:readline").createInterface({ input: process.stdin });
  lines.on("line", line => {
    const message = JSON.parse(line);
    if ("jsonrpc" in message) {
      console.error("app-server wire messages must omit the jsonrpc header");
      process.exit(9);
    }
    if (message.method === "initialize") {
      console.log(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.method === "config/read") {
      if (process.env.EPICD_FAKE_MODEL_MARKER) {
        fs.writeFileSync(process.env.EPICD_FAKE_MODEL_MARKER, "resolving");
      }
      const respond = () => console.log(JSON.stringify({
          id: message.id,
          result: { config: { model: "gpt-config-default" } }
        }));
      const delay = Number(process.env.EPICD_FAKE_MODEL_DELAY_MS || 0);
      if (delay > 0) setTimeout(respond, delay);
      else respond();
    }
  });
} else {
const mode = process.env.EPICD_FAKE_MODE || "happy";
const cdIndex = args.indexOf("--cd");
const repo = cdIndex >= 0 ? args[cdIndex + 1] : process.cwd();
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => prompt += chunk);
process.stdin.on("end", () => {
  const resumeIndex = args.indexOf("resume");
  const sourceIndex = args.indexOf("--thread-source");
  const role = sourceIndex >= 0 ? args[sourceIndex + 1] : "resumed";
  const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] : "thr-" + role + "-" + process.pid;
  let response;
  if (prompt.includes("persistent epicd orchestrator")) {
    const tracker = JSON.parse(fs.readFileSync(path.join(repo, ".beads", "state.json"), "utf8"));
    const candidate = tracker.issues.find(issue => issue.issue_type !== "epic" && issue.status !== "closed");
    response = {candidateId:candidate.id,rationale:"Next ready concrete task",dependencyNotes:[],riskNotes:[]};
  } else if (prompt.includes("You are the implementation owner") || prompt.includes("Continue as the implementation owner")) {
    const fixing = prompt.includes("Continue as the implementation owner");
    const committedFix = prompt.includes("last candidate was already committed");
    const secondTask = prompt.includes("demo.2");
    fs.writeFileSync(path.join(repo, "feature.txt"), committedFix ? "verified-fixed\\n" : fixing ? "fixed\\n" : secondTask ? "implemented-second\\n" : "implemented\\n");
    response = {status:"completed",summary:fixing ? "Fixed review finding" : "Implemented feature",changedFiles:["feature.txt"],tests:[{command:"test -f feature.txt",outcome:"passed",detail:"exists"}],blockers:[]};
  } else if (prompt.includes("final independent verifier")) {
    const head = cp.execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {encoding:"utf8"}).trim();
    response = {verdict:"approved",summary:"Epic accepted",revision:head,findings:[],tests:[{command:"test -f feature.txt",outcome:"passed",detail:"exists"}],residualRisks:[]};
  } else if (prompt.includes("fresh, independent comprehensive reviewer")) {
    if (mode === "reviewer-mutate") fs.writeFileSync(path.join(repo, "feature.txt"), "reviewer overwrite\\n");
    let requestFix = false;
    if (mode === "review-fix") {
      const counter = process.env.EPICD_FAKE_COUNTER;
      const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
      fs.writeFileSync(counter, String(count + 1));
      requestFix = count === 0;
    }
    if (mode === "review-and-verification-fix") {
      requestFix = fs.readFileSync(path.join(repo, "feature.txt"), "utf8") === "implemented\\n";
    }
    response = requestFix
      ? {verdict:"changes_requested",summary:"Feature needs correction",revision:null,findings:[{severity:"medium",title:"Wrong content",detail:"Expected fixed content",file:"feature.txt",line:1,remediation:"Write fixed content"}],tests:[{command:"test feature content",outcome:"failed",detail:"not fixed"}],residualRisks:[]}
      : {verdict:"approved",summary:"Task accepted",revision:null,findings:[],tests:[{command:"test -f feature.txt",outcome:"passed",detail:"exists"}],residualRisks:[]};
  } else if (prompt.includes("Continue as the independent reviewer")) {
    response = {verdict:"approved",summary:"Reported findings are resolved",revision:null,findings:[],tests:[{command:"test -f feature.txt",outcome:"passed",detail:"exists"}],residualRisks:[]};
  } else if (prompt.includes("fresh, independent exact-revision verifier")) {
    const actualHead = cp.execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {encoding:"utf8"}).trim();
    if (mode === "reviewer-commit") {
      fs.writeFileSync(path.join(repo, "reviewer.txt"), "unauthorized reviewer commit\\n");
      cp.execFileSync("git", ["-C", repo, "add", "reviewer.txt"]);
      cp.execFileSync("git", ["-C", repo, "commit", "-qm", "reviewer mutation"]);
    }
    const head = mode === "wrong-revision" ? "deadbeef" : actualHead;
    const feature = fs.readFileSync(path.join(repo, "feature.txt"), "utf8");
    const requestFix = (mode === "review-and-verification-fix" && feature === "fixed\\n")
      || (mode === "verification-fix" && feature === "implemented\\n");
    response = requestFix
      ? {verdict:"changes_requested",summary:"Exact revision fails acceptance evidence",revision:head,findings:[{severity:"high",title:"Exact revision mismatch",detail:"Expected verified content",file:"feature.txt",line:1,remediation:"Write verified content"}],tests:[{command:"test feature verified content",outcome:"failed",detail:"not verified"}],residualRisks:[]}
      : {verdict:"approved",summary:"Exact revision accepted",revision:head,findings:[],tests:[{command:"test -f feature.txt",outcome:"passed",detail:"exists"}],residualRisks:[]};
  } else {
    console.error("unknown prompt", prompt.slice(0, 200)); process.exit(2);
  }
  console.log(JSON.stringify({type:"thread.started",thread_id:threadId}));
  console.log(JSON.stringify({type:"turn.started"}));
  console.log(JSON.stringify({type:"item.completed",item:{id:"message-1",type:"agent_message",text:JSON.stringify(response)}}));
  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:1,reasoning_output_tokens:0}}));
});
}
`,
  );

  const herdr = join(bin, "herdr-fake");
  executable(
    herdr,
    `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const path = require("node:path");
const args = process.argv.slice(2);
const registryPath = process.env.EPICD_HERDR_REGISTRY;
const readAgents = () => fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, "utf8")) : [];
const writeAgents = agents => fs.writeFileSync(registryPath, JSON.stringify(agents));
if (args[0] === "tab" && args[1] === "create") {
  console.log(JSON.stringify({ok:true,result:{root_pane:{pane_id:"w-e2e:p9"}}}));
} else if (args[0] === "agent" && args[1] === "start") {
  const agents = readAgents();
  agents.push({name:args[2],tab_id:"w-e2e:t-" + args[2]});
  writeAgents(agents);
  console.log(JSON.stringify({ok:true,result:{agent:{name:args[2]}}}));
} else if (args[0] === "agent" && args[1] === "get") {
  const agent = readAgents().find(candidate => candidate.name === args[2]);
  if (!agent) process.exit(1);
  console.log(JSON.stringify({ok:true,result:{agent:{...agent,state:"idle"}}}));
} else if (args[0] === "agent" && args[1] === "list") {
  console.log(JSON.stringify({ok:true,result:{agents:readAgents()}}));
} else if (args[0] === "agent" && args[1] === "wait") {
  console.log(JSON.stringify({ok:true,result:{state:"idle"}}));
} else if (args[0] === "agent" && args[1] === "send-keys") {
  console.log(JSON.stringify({ok:true}));
} else if (args[0] === "tab" && args[1] === "close") {
  if (process.env.EPICD_HERDR_CLOSE_FAIL === "1") process.exit(1);
  writeAgents(readAgents().filter(agent => agent.tab_id !== args[2]));
  console.log(JSON.stringify({ok:true,result:{}}));
} else if (args[0] === "agent" && args[1] === "prompt") {
  const prompt = args[3];
  const marker = "write only the final JSON object to ";
  const markerStart = prompt.indexOf(marker) + marker.length;
  const markerRest = prompt.slice(markerStart);
  const resultPath = JSON.parse(markerRest.slice(0, markerRest.indexOf(". It must")));
  const repo = process.cwd();
  let response;
  if (prompt.includes("persistent epicd orchestrator")) {
    response = {candidateId:"demo.1",rationale:"Only ready concrete task",dependencyNotes:[],riskNotes:[]};
  } else if (prompt.includes("You are the implementation owner") || prompt.includes("Continue as the implementation owner")) {
    fs.writeFileSync(path.join(repo, "feature.txt"), "implemented\\n");
    response = {status:"completed",summary:"Implemented feature",changedFiles:["feature.txt"],tests:[{command:"test -f feature.txt",outcome:"passed",detail:"exists"}],blockers:[]};
  } else if (prompt.includes("final independent verifier")) {
    const head = cp.execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {encoding:"utf8"}).trim();
    response = {verdict:"approved",summary:"Epic accepted",revision:head,findings:[],tests:[{command:"test -f feature.txt",outcome:"passed",detail:"exists"}],residualRisks:[]};
  } else if (prompt.includes("fresh, independent comprehensive reviewer")) {
    response = {verdict:"approved",summary:"Task accepted",revision:null,findings:[],tests:[{command:"test -f feature.txt",outcome:"passed",detail:"exists"}],residualRisks:[]};
  } else if (prompt.includes("fresh, independent exact-revision verifier")) {
    const head = cp.execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {encoding:"utf8"}).trim();
    response = {verdict:"approved",summary:"Exact revision accepted",revision:head,findings:[],tests:[{command:"test -f feature.txt",outcome:"passed",detail:"exists"}],residualRisks:[]};
  } else process.exit(2);
  fs.writeFileSync(resultPath + ".tmp", JSON.stringify(response));
  fs.renameSync(resultPath + ".tmp", resultPath);
  console.log(JSON.stringify({ok:true,result:{state:"idle"}}));
} else process.exit(2);
`,
  );

  await runCommand("git", ["init", "-q"], { cwd: repo });
  await runCommand("git", ["config", "user.name", "Epicd Test"], { cwd: repo });
  await runCommand("git", ["config", "user.email", "epicd@example.test"], { cwd: repo });
  await runCommand("git", ["add", "-A"], { cwd: repo });
  await runCommand("git", ["commit", "-qm", "initial"], { cwd: repo });
  process.env.EPICD_HERDR_REGISTRY = join(root, "herdr-agents.json");
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  return { repo, codex, herdr, store: new StateStore(join(root, "epicd.sqlite3")) };
}

async function seedTaskOwnership(
  repo: string,
  status: "open" | "in_progress",
  assignee?: string,
): Promise<void> {
  const statePath = join(repo, ".beads", "state.json");
  const exportPath = join(repo, ".beads", "issues.jsonl");
  const tracker = JSON.parse(readFileSync(statePath, "utf8")) as {
    issues: Array<Record<string, unknown>>;
  };
  const task = tracker.issues.find((issue) => issue.id === "demo.1");
  if (!task) throw new Error("fixture task demo.1 is missing");
  task.status = status;
  if (assignee) task.assignee = assignee;
  else delete task.assignee;
  writeFileSync(statePath, JSON.stringify(tracker, null, 2));
  writeFileSync(exportPath, tracker.issues.map((issue) => JSON.stringify(issue)).join("\n") + "\n");
  await runCommand("git", ["add", ".beads/state.json", ".beads/issues.jsonl"], { cwd: repo });
  await runCommand("git", ["commit", "-qm", "seed task ownership"], { cwd: repo });
}

async function addSecondTask(repo: string): Promise<void> {
  const statePath = join(repo, ".beads", "state.json");
  const exportPath = join(repo, ".beads", "issues.jsonl");
  const tracker = JSON.parse(readFileSync(statePath, "utf8")) as {
    issues: Array<Record<string, unknown>>;
  };
  tracker.issues.push({
    id: "demo.2",
    title: "Add the second feature",
    description: "Update feature.txt again",
    acceptance_criteria: "feature.txt exists",
    status: "open",
    priority: 2,
    issue_type: "task",
    labels: [],
  });
  writeFileSync(statePath, JSON.stringify(tracker, null, 2));
  writeFileSync(exportPath, tracker.issues.map((issue) => JSON.stringify(issue)).join("\n") + "\n");
  await runCommand("git", ["add", ".beads/state.json", ".beads/issues.jsonl"], { cwd: repo });
  await runCommand("git", ["commit", "-qm", "add second task"], { cwd: repo });
}

describe.sequential("EpicEngine workflow", () => {
  it("records a settings event before publishing state to a competing controller", async () => {
    const setup = await fixture();
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    const competing = new StateStore(setup.store.path);
    let ownerToken: string | undefined;
    try {
      engine.onState(() => {
        ownerToken = competing.acquireLease(engine.snapshot().runId).ownerToken;
      });
      const settings = engine.snapshot().agentSettings;
      settings.review.model = "gpt-next";
      expect(() => engine.configureFutureAgentSettings(settings)).not.toThrow();
      expect(ownerToken).toBeDefined();
      expect(
        competing
          .events(engine.snapshot().runId)
          .filter((event) => event.kind === "agent.settings_updated"),
      ).toHaveLength(1);
      expect(competing.get(engine.snapshot().runId)?.agentSettings.review.model).toBe("gpt-next");
    } finally {
      if (ownerToken) competing.releaseLease(engine.snapshot().runId, ownerToken);
      competing.close();
      setup.store.close();
    }
  });

  it("persists a recoverable blocked run when lazy runtime initialization fails", async () => {
    const setup = await fixture();
    const missingCodex = join(setup.repo, "..", "missing-codex");

    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: missingCodex,
      },
      setup.store,
    );
    const blocked = await engine.run();

    expect(blocked.phase).toBe("blocked");
    expect(blocked.lastError).toContain("Configured Codex executable does not exist");
    expect(setup.store.list(setup.repo)).toHaveLength(1);
    setup.store.close();
  }, 30_000);

  it("keeps a default-model SDK coordinator across task selections", async () => {
    const setup = await fixture();
    await addSecondTask(setup.repo);
    const argumentLog = join(setup.repo, "..", "codex-multi-task.jsonl");
    process.env.EPICD_FAKE_ARGS = argumentLog;
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );

    const completed = await engine.run();

    expect(completed.phase, completed.lastError ?? undefined).toBe("complete");
    expect(
      setup.store
        .events(completed.runId)
        .some((event) => event.kind === "orchestrator.settings_rotated"),
    ).toBe(false);
    const invocations = readFileSync(argumentLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(
      invocations.filter(
        (args) => args.includes("--thread-source") && args.includes("epicd-orchestrator"),
      ),
    ).toHaveLength(1);
    expect(invocations.some((args) => args.includes("resume"))).toBe(true);
    setup.store.close();
  }, 45_000);

  it("applies resume model and reasoning flags only to future threads", async () => {
    const setup = await fixture();
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        agentSettings: { review: { model: "gpt-review", reasoningEffort: "xhigh" } },
      },
      setup.store,
    );
    const state = engine.snapshot();
    expect(state.maxReviewPasses).toBe(3);
    expect(state.agentAccessMode).toBe("sandboxed");
    state.agentSessions.review = {
      status: "active",
      sessionId: "thr-existing-review",
      contract: {
        runtime: "sdk",
        requested: { model: "gpt-review", reasoningEffort: "xhigh" },
        effective: { model: "gpt-review", reasoningEffort: "xhigh" },
      },
    };
    state.phase = "paused";
    state.resumePhase = "selecting";
    setup.store.save(state);
    const resumedEngine = EpicEngine.resume(
      state.runId,
      {
        codexPath: setup.codex,
        agentSettings: { review: { model: "gpt-next-review", reasoningEffort: "low" } },
      },
      setup.store,
    );
    const resumed = resumedEngine.snapshot();
    expect(resumed.agentSettings.review).toEqual({
      model: "gpt-next-review",
      reasoningEffort: "low",
    });
    expect(resumed.model).toBeNull();
    expect(resumed.agentSessions.review).toEqual({
      status: "active",
      sessionId: "thr-existing-review",
      contract: {
        runtime: "sdk",
        requested: { model: "gpt-review", reasoningEffort: "xhigh" },
        effective: { model: "gpt-review", reasoningEffort: "xhigh" },
      },
    });
    expect(setup.store.get(state.runId)?.agentSettings.review).toEqual({
      model: "gpt-review",
      reasoningEffort: "xhigh",
    });
    resumedEngine.requestPause();
    await resumedEngine.run();
    expect(setup.store.get(state.runId)?.agentSettings.review).toEqual({
      model: "gpt-next-review",
      reasoningEffort: "low",
    });
    const withFallback = EpicEngine.resume(
      resumed.runId,
      { codexPath: setup.codex, model: "gpt-resumed-fallback" },
      setup.store,
    ).snapshot();
    expect(withFallback.model).toBe("gpt-resumed-fallback");
    expect(withFallback.agentSettings.orchestrator.model).toBeNull();
    expect(withFallback.agentSettings.review.model).toBe("gpt-next-review");
    expect(withFallback.agentSessions.review).toMatchObject({
      status: "active",
      contract: {
        effective: { model: "gpt-review", reasoningEffort: "xhigh" },
      },
    });
    const withResetReviewModel = EpicEngine.resume(
      resumed.runId,
      {
        codexPath: setup.codex,
        agentSettings: { review: { model: null } },
      },
      setup.store,
    ).snapshot();
    expect(withResetReviewModel.agentSettings.review).toEqual({
      model: null,
      reasoningEffort: "low",
    });
    const liveSettings = {
      ...resumedEngine.snapshot().agentSettings,
      review: { model: "gpt-live-review", reasoningEffort: "high" as const },
    };
    resumedEngine.configureFutureAgentSettings(liveSettings);
    await resumedEngine.run();
    expect(setup.store.get(state.runId)?.agentSettings.review).toEqual(liveSettings.review);
    expect(() => EpicEngine.resume(state.runId, { maxReviewPasses: 4 }, setup.store)).toThrow(
      "persisted repair budget of 3 passes",
    );
    await expect(engine.resumeRun()).rejects.toThrow("Cannot resume a run in phase selecting");
    setup.store.close();
  });

  it("rejects direct engine resume of a clean completed run", async () => {
    const setup = await fixture();
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    const completed = engine.snapshot();
    completed.phase = "complete";
    setup.store.save(completed);

    expect(() => EpicEngine.resume(completed.runId, {}, setup.store)).toThrow(
      "is already complete",
    );
    setup.store.close();
  });

  it("keeps explicit role reasoning when the run-wide resume fallback changes", async () => {
    const setup = await fixture();
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        reasoningEffort: "high",
        agentSettings: { review: { reasoningEffort: "xhigh" } },
      },
      setup.store,
    );
    const state = engine.snapshot();
    state.phase = "paused";
    state.resumePhase = "selecting";
    setup.store.save(state);

    const resumed = EpicEngine.resume(
      state.runId,
      { codexPath: setup.codex, reasoningEffort: "medium" },
      setup.store,
    );

    expect(resumed.snapshot()).toMatchObject({
      reasoningEffort: "medium",
      agentSettings: {
        orchestrator: { reasoningEffort: null },
        implementation: { reasoningEffort: null },
        review: { reasoningEffort: "xhigh" },
      },
    });
    resumed.requestPause();
    await resumed.run();
    expect(setup.store.get(state.runId)).toMatchObject({
      reasoningEffort: "medium",
      agentSettings: { review: { reasoningEffort: "xhigh" } },
    });
    setup.store.close();
  });

  it("resets persisted run-wide fallbacks without disturbing role overrides", async () => {
    const setup = await fixture();
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        model: "gpt-run-wide",
        reasoningEffort: "high",
        agentSettings: { review: { model: "gpt-review", reasoningEffort: "xhigh" } },
      },
      setup.store,
    );
    const state = engine.snapshot();
    state.phase = "paused";
    state.resumePhase = "selecting";
    setup.store.save(state);

    const resumed = EpicEngine.resume(
      state.runId,
      { codexPath: setup.codex, model: null, reasoningEffort: null },
      setup.store,
    );

    expect(resumed.snapshot()).toMatchObject({
      model: null,
      reasoningEffort: null,
      agentSettings: {
        review: { model: "gpt-review", reasoningEffort: "xhigh" },
      },
    });
    resumed.requestPause();
    await resumed.run();
    expect(setup.store.get(state.runId)).toMatchObject({
      model: null,
      reasoningEffort: null,
      agentSettings: {
        review: { model: "gpt-review", reasoningEffort: "xhigh" },
      },
    });
    setup.store.close();
  });

  it("gives a pre-run live settings edit precedence over deferred resume flags", async () => {
    const setup = await fixture();
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    const state = engine.snapshot();
    state.phase = "paused";
    state.resumePhase = "selecting";
    setup.store.save(state);
    const resumed = EpicEngine.resume(
      state.runId,
      {
        codexPath: setup.codex,
        model: "gpt-resume-fallback",
        reasoningEffort: "low",
        agentSettings: { review: { reasoningEffort: "high" } },
      },
      setup.store,
    );
    const liveSettings = resumed.snapshot().agentSettings;
    liveSettings.review = { model: "gpt-live-review", reasoningEffort: "ultra" };

    resumed.configureFutureAgentSettings(liveSettings);

    expect(setup.store.get(state.runId)).toMatchObject({
      model: "gpt-resume-fallback",
      reasoningEffort: "low",
      agentSettings: {
        review: { model: "gpt-live-review", reasoningEffort: "ultra" },
      },
    });
    resumed.requestPause();
    await resumed.run();
    expect(setup.store.get(state.runId)).toMatchObject({
      model: "gpt-resume-fallback",
      reasoningEffort: "low",
      agentSettings: {
        review: { model: "gpt-live-review", reasoningEffort: "ultra" },
      },
    });
    setup.store.close();
  }, 30_000);

  it("keeps engine-owned state detached from public snapshots and resume input", async () => {
    const setup = await fixture();
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );

    const snapshot = engine.snapshot();
    snapshot.phase = "complete";
    snapshot.pendingAgentCleanup.push({ kind: "run", runtime: "sdk" });

    expect(engine.snapshot()).toMatchObject({ phase: "selecting", pendingAgentCleanup: [] });

    const resumeInput = engine.snapshot();
    const resumedEngine = EpicEngine.resume(
      resumeInput.runId,
      { codexPath: setup.codex },
      setup.store,
    );
    resumeInput.phase = "complete";
    resumeInput.pendingAgentCleanup.push({ kind: "run", runtime: "sdk" });

    expect(resumedEngine.snapshot()).toMatchObject({
      phase: "selecting",
      pendingAgentCleanup: [],
    });
    setup.store.close();
  });

  it("reloads authoritative state when a stale controller acquires the lease", async () => {
    const setup = await fixture();
    const created = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    const stale = EpicEngine.resume(
      created.snapshot().runId,
      { codexPath: setup.codex },
      setup.store,
    );
    const handoff = setup.store.acquireLease(created.snapshot().runId);
    handoff.state.phase = "complete";
    handoff.state.totalTasks = 99;
    setup.store.saveWithLease(handoff.state, handoff.ownerToken);
    setup.store.releaseLease(handoff.state.runId, handoff.ownerToken);

    const result = await stale.run();

    expect(result).toMatchObject({ phase: "complete", totalTasks: 99 });
    expect(setup.store.get(result.runId)).toMatchObject({ phase: "complete", totalTasks: 99 });
    setup.store.close();
  });

  it("revalidates stale resume options against cleanup-only state under the lease", async () => {
    const setup = await fixture();
    const created = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    const stale = EpicEngine.resume(
      created.snapshot().runId,
      { model: "gpt-stale-override", runtime: "herdr", herdrPath: setup.herdr },
      setup.store,
    );
    const handoff = setup.store.acquireLease(created.snapshot().runId);
    handoff.state.phase = "complete";
    handoff.state.pendingAgentCleanup = [{ kind: "run", runtime: "sdk" }];
    setup.store.saveWithLease(handoff.state, handoff.ownerToken);
    setup.store.releaseLease(handoff.state.runId, handoff.ownerToken);

    await expect(stale.run()).rejects.toThrow("only agent cleanup remains");

    expect(setup.store.get(handoff.state.runId)).toMatchObject({
      phase: "complete",
      runtime: "sdk",
      model: null,
      pendingAgentCleanup: [{ kind: "run", runtime: "sdk" }],
      lastError: null,
    });
    setup.store.close();
  });

  it.each(["unleased", "leased"] as const)(
    "does not arm a %s pause whose event could not be persisted",
    async (ownership) => {
      const setup = await fixture();
      try {
        const engine = await EpicEngine.create(
          { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
          setup.store,
        );
        let pauseError: unknown;
        const attemptPause = () => {
          const write = vi
            .spyOn(setup.store, ownership === "leased" ? "addEventWithLease" : "addEvent")
            .mockImplementationOnce(() => {
              throw new Error("pause event write failed");
            });
          try {
            engine.requestPause();
          } catch (error) {
            pauseError = error;
          } finally {
            write.mockRestore();
          }
        };
        if (ownership === "unleased") attemptPause();
        else {
          const offState = engine.onState(() => {
            offState();
            attemptPause();
          });
        }
        let selected = false;
        engine.onEvent((event) => {
          if (event.kind === "orchestrator.selected") {
            selected = true;
            engine.requestPause();
          }
        });
        await engine.run();
        expect(pauseError).toMatchObject({ message: "pause event write failed" });
        expect(selected).toBe(true);
        expect(engine.snapshot().phase).toBe("paused");
        expect(
          engine.recentEvents().filter((event) => event.kind === "run.pause_requested"),
        ).toHaveLength(1);
      } finally {
        setup.store.close();
      }
    },
  );

  it("explains rejected overrides for a completed run with only a saved diagnostic", async () => {
    const setup = await fixture();
    try {
      const engine = await EpicEngine.create(
        { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
        setup.store,
      );
      const state = {
        ...engine.snapshot(),
        phase: "complete" as const,
        lastError: "saved diagnostic",
      };
      expect(() => assertResumeOptionsAllowed(state, { model: "gpt-test" })).toThrow(
        "saved diagnostic remains",
      );
      expect(() => assertResumeOptionsAllowed(state, {})).not.toThrow();
    } finally {
      setup.store.close();
    }
  });

  it("preserves the run result when controller lease release fails", async () => {
    const setup = await fixture();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    vi.spyOn(setup.store, "releaseLease").mockImplementation(() => {
      throw new Error("database busy");
    });
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    engine.requestPause();

    const result = await engine.run();

    expect(result).toMatchObject({ phase: "paused", resumePhase: "selecting" });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Could not release the controller lease"),
    );
    setup.store.close();
  });

  it("isolates throwing observers from controller execution and lease ownership", async () => {
    const setup = await fixture();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    let firstNotification = true;
    const observer = vi.fn(() => {
      if (!firstNotification) return;
      firstNotification = false;
      throw new Error("observer failed");
    });
    engine.onState(observer);

    const result = await engine.run();
    expect(result.phase, result.lastError ?? undefined).toBe("complete");
    expect(warning).toHaveBeenCalledOnce();
    expect(observer.mock.calls.length).toBeGreaterThan(1);
    expect(warning).toHaveBeenCalledWith(
      "Epicd Error observer failure; controller execution continued",
      { code: "EPICD_OBSERVER_FAILURE" },
    );
    const replacement = setup.store.acquireLease(engine.snapshot().runId);
    setup.store.releaseLease(engine.snapshot().runId, replacement.ownerToken);
    warning.mockRestore();
    setup.store.close();
  }, 30_000);

  it("allows blocked runs to change recovery settings and rejects completed runs", async () => {
    const setup = await fixture();
    const created = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    const blocked = created.snapshot();
    blocked.phase = "blocked";
    blocked.resumePhase = "selecting";
    blocked.lastError = "model unavailable";
    setup.store.save(blocked);
    const engine = EpicEngine.resume(blocked.runId, { codexPath: setup.codex }, setup.store);
    const recoverySettings = {
      orchestrator: { model: "gpt-recovery", reasoningEffort: "high" as const },
      implementation: { model: "gpt-recovery", reasoningEffort: "high" as const },
      review: { model: "gpt-recovery", reasoningEffort: "xhigh" as const },
    };

    expect(() => engine.configureFutureAgentSettings(recoverySettings)).not.toThrow();
    const completed = setup.store.get(blocked.runId);
    if (!completed) throw new Error("missing run state");
    completed.phase = "complete";
    completed.resumePhase = null;
    completed.lastError = null;
    setup.store.save(completed);

    expect(() => engine.configureFutureAgentSettings(recoverySettings)).toThrow(
      "A completed run cannot create new agent threads",
    );
    setup.store.close();
  }, 30_000);

  it("refuses live configuration writes from a controller that does not own the lease", async () => {
    const setup = await fixture();
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    const competingStore = new StateStore(join(setup.repo, "..", "epicd.sqlite3"));
    const lease = competingStore.acquireLease(engine.snapshot().runId);
    const liveState = competingStore.get(engine.snapshot().runId);
    if (!liveState) throw new Error("missing live run state");
    liveState.totalTasks = 99;
    competingStore.saveWithLease(liveState, lease.ownerToken);

    expect(() =>
      engine.configureFutureAgentSettings({
        orchestrator: { model: "gpt-stale", reasoningEffort: "low" },
        implementation: { model: "gpt-stale", reasoningEffort: "low" },
        review: { model: "gpt-stale", reasoningEffort: "low" },
      }),
    ).toThrow("already controlled");
    const contender = EpicEngine.resume(
      engine.snapshot().runId,
      { agentSettings: { review: { model: "gpt-stale", reasoningEffort: "low" } } },
      setup.store,
    );
    await expect(contender.run()).rejects.toThrow("already controlled");
    await expect(engine.run()).rejects.toThrow(RunAlreadyControlledError);
    expect(competingStore.get(liveState.runId)).toMatchObject({
      totalTasks: 99,
      agentSettings: engine.snapshot().agentSettings,
    });

    competingStore.releaseLease(liveState.runId, lease.ownerToken);
    competingStore.close();
    setup.store.close();
  }, 30_000);

  it("adopts an unassigned in-progress descendant instead of stalling", async () => {
    const setup = await fixture();
    await seedTaskOwnership(setup.repo, "in_progress");
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );

    const state = await engine.run();

    expect(state.phase, state.lastError ?? undefined).toBe("complete");
    expect(engine.recentEvents().some((event) => event.kind === "beads.claim_reconciled")).toBe(
      true,
    );
    const tracker = JSON.parse(readFileSync(join(setup.repo, ".beads", "state.json"), "utf8")) as {
      issues: Array<{ id: string; assignee?: string }>;
    };
    expect(tracker.issues.find((issue) => issue.id === "demo.1")?.assignee).toBe(
      `epicd:${state.runId}`,
    );
    setup.store.close();
  }, 30_000);

  it("reports a one-time rotation of an unverifiable legacy SDK session", async () => {
    const setup = await fixture();
    const created = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    const state = created.snapshot();
    state.phase = "complete";
    state.completedTasks = state.totalTasks;
    state.pendingAgentCleanup.push({
      kind: "session",
      runtime: "sdk",
      role: "implementation",
      sessionId: "thr-legacy",
      reason: "unverifiable-session-contract",
    });
    setup.store.save(state);
    const engine = EpicEngine.resume(state.runId, {}, setup.store);

    const completed = await engine.run();

    expect(completed.phase, completed.lastError ?? undefined).toBe("complete");
    expect(
      setup.store
        .events(completed.runId)
        .some((event) => event.kind === "agent.legacy_session_rotated"),
    ).toBe(true);
    setup.store.close();
  }, 30_000);

  it("stops when cleanup completion cannot be persisted under the controller lease", async () => {
    const setup = await fixture();
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        herdrPath: setup.herdr,
      },
      setup.store,
    );
    const state = engine.snapshot();
    state.pendingAgentCleanup = [{ kind: "run", runtime: "herdr" }];
    setup.store.save(state);
    const competingStore = new StateStore(setup.store.path);
    vi.spyOn(HerdrRuntime.prototype, "releaseAll").mockImplementation(async () => {
      const lease = competingStore.controllerLease(state.runId);
      if (!lease) throw new Error("expected cleanup controller lease");
      competingStore.forceReleaseLease(state.runId, lease.pid, lease.leaseId);
    });

    await expect(engine.run()).rejects.toThrow("not controlled by this epicd process");

    expect(setup.store.get(state.runId)).toMatchObject({
      phase: "selecting",
      pendingAgentCleanup: [{ kind: "run", runtime: "herdr" }],
    });
    expect(existsSync(join(setup.repo, "feature.txt"))).toBe(false);
    competingStore.close();
    setup.store.close();
  });

  it("keeps cleanup-only diagnostics non-owning beside another active epic", async () => {
    const setup = await fixture();
    const created = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        herdrPath: setup.herdr,
      },
      setup.store,
    );
    const completed = created.snapshot();
    completed.phase = "complete";
    completed.completedTasks = completed.totalTasks;
    completed.pendingAgentCleanup = [{ kind: "run", runtime: "herdr" }];
    setup.store.save(completed);
    const now = new Date().toISOString();
    setup.store.create({
      ...completed,
      runId: "other-active-run",
      agentNamespace: "fedcba9876543210fedc",
      epicId: "other-epic",
      epicTitle: "Other epic",
      phase: "selecting",
      completedTasks: 0,
      pendingAgentCleanup: [],
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    const releaseAll = vi
      .spyOn(HerdrRuntime.prototype, "releaseAll")
      .mockRejectedValue(new Error("Herdr is unavailable"));
    const addEventWithLease = setup.store.addEventWithLease.bind(setup.store);
    const addEvent = vi
      .spyOn(setup.store, "addEventWithLease")
      .mockImplementation((runId, ownerToken, level, kind, message, detail) => {
        if (kind === "agent.cleanup_failed") {
          throw new Error("cleanup warning could not be recorded");
        }
        return addEventWithLease(runId, ownerToken, level, kind, message, detail);
      });
    const cleanup = EpicEngine.resume(completed.runId, { herdrPath: setup.herdr }, setup.store);

    const cleanupFailure = await cleanup.run().catch((error: unknown) => error);

    expect(cleanupFailure).toBeInstanceOf(AgentCleanupRequiredError);
    expect(cleanupFailure).toMatchObject({
      runId: completed.runId,
      epicId: completed.epicId,
      message: "cleanup warning could not be recorded",
    });

    expect(setup.store.get(completed.runId)).toMatchObject({
      phase: "complete",
      lastError: "cleanup warning could not be recorded",
      pendingAgentCleanup: [{ kind: "run", runtime: "herdr" }],
    });
    expect(setup.store.get("other-active-run")?.phase).toBe("selecting");
    expect(
      setup.store
        .events(completed.runId)
        .some((event) => event.kind === "agent.cleanup_needs_attention"),
    ).toBe(true);

    releaseAll.mockResolvedValue(undefined);
    addEvent.mockImplementation(addEventWithLease);
    const retried = await EpicEngine.resume(
      completed.runId,
      { herdrPath: setup.herdr },
      setup.store,
    ).run();

    expect(retried).toMatchObject({
      phase: "complete",
      lastError: null,
      pendingAgentCleanup: [],
    });
    setup.store.close();
  });

  it("does not reclassify a workflow reporting failure as cleanup after completion", async () => {
    const setup = await fixture();
    const addEventWithLease = setup.store.addEventWithLease.bind(setup.store);
    vi.spyOn(setup.store, "addEventWithLease").mockImplementation(
      (runId, ownerToken, level, kind, message, detail) => {
        if (kind === "epic.complete") throw new Error("completion event write failed");
        return addEventWithLease(runId, ownerToken, level, kind, message, detail);
      },
    );
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );

    const failure = await engine.run().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toBeInstanceOf(WorkflowCompletionReportingError);
    expect(failure).not.toBeInstanceOf(AgentCleanupRequiredError);
    expect(failure).toMatchObject({ message: "completion event write failed" });
    expect(setup.store.get(engine.snapshot().runId)).toMatchObject({
      phase: "complete",
      lastError: null,
      pendingAgentCleanup: [],
    });
    expect(
      setup.store
        .events(engine.snapshot().runId)
        .some((event) => event.kind === "agent.cleanup_needs_attention"),
    ).toBe(false);
    setup.store.close();
  }, 30_000);

  it("blocks from the durable phase when saving workflow completion fails", async () => {
    const setup = await fixture();
    const saveWithLease = setup.store.saveWithLease.bind(setup.store);
    const failingSave = vi
      .spyOn(setup.store, "saveWithLease")
      .mockImplementation((state, ownerToken) => {
        if (state.phase === "complete") throw new Error("completion state write failed");
        saveWithLease(state, ownerToken);
      });
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );

    const result = await engine.run();

    expect(result).toMatchObject({
      phase: "blocked",
      resumePhase: "final_review",
      lastError: "completion state write failed",
    });
    expect(
      setup.store
        .events(result.runId)
        .some((event) => event.kind === "agent.cleanup_needs_attention"),
    ).toBe(false);
    expect(setup.store.events(result.runId).some((event) => event.kind === "run.blocked")).toBe(
      true,
    );
    failingSave.mockRestore();
    const resumed = EpicEngine.resume(result.runId, { codexPath: setup.codex }, setup.store);
    const completed = await resumed.run();
    expect(completed).toMatchObject({ phase: "complete", lastError: null });
    expect(setup.store.findActive(setup.repo)).toBeNull();
    setup.store.close();
  }, 30_000);

  it("reports the owner when no descendant can be claimed", async () => {
    const setup = await fixture();
    await seedTaskOwnership(setup.repo, "in_progress", "other-agent");
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );

    const state = await engine.run();

    expect(state.phase).toBe("blocked");
    expect(state.lastError).toContain("none is claimable");
    expect(state.lastError).toContain("demo.1 (other-agent)");
    setup.store.close();
  }, 30_000);

  it("delivers through Herdr and treats tab cleanup failures as warnings", async () => {
    const setup = await fixture();
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w-e2e";
    process.env.XDG_STATE_HOME = join(setup.repo, ".state");
    process.env.EPICD_HERDR_CLOSE_FAIL = "1";
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        runtime: "herdr",
        herdrPath: setup.herdr,
        codexPath: setup.codex,
      },
      setup.store,
    );
    const state = await engine.run();
    expect(state.phase, state.lastError ?? undefined).toBe("complete");
    expect(state.runtime).toBe("herdr");
    expect(
      Object.values(state.agentSessions).every((session) => session.status === "inactive"),
    ).toBe(true);
    expect(
      setup.store.events(state.runId).some((event) => event.message.includes("herdr session")),
    ).toBe(true);
    expect(
      setup.store.events(state.runId).some((event) => event.kind === "agent.cleanup_failed"),
    ).toBe(true);
    expect(state.pendingAgentCleanup.length).toBeGreaterThan(0);

    expect(() =>
      EpicEngine.resume(state.runId, { herdrPath: setup.herdr, model: "gpt-unused" }, setup.store),
    ).toThrow("only agent cleanup remains");
    expect(() =>
      EpicEngine.resume(
        state.runId,
        { herdrPath: setup.herdr, codexPath: setup.codex },
        setup.store,
      ),
    ).toThrow("only agent cleanup remains");
    expect(setup.store.get(state.runId)).toMatchObject({
      phase: "complete",
      runtime: "herdr",
      model: null,
    });

    delete process.env.EPICD_HERDR_CLOSE_FAIL;
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_WORKSPACE_ID;
    const cleanupRetry = EpicEngine.resume(state.runId, { herdrPath: setup.herdr }, setup.store);
    const recovered = await cleanupRetry.run();
    expect(recovered.pendingAgentCleanup).toEqual([]);
    setup.store.close();
  }, 30_000);

  it("atomically switches an SDK repair to full-access Herdr without losing workflow state", async () => {
    const setup = await fixture();
    process.env.EPICD_FAKE_MODE = "review-fix";
    const sdkEngine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    sdkEngine.onEvent((event) => {
      if (event.kind === "review.changes_requested") sdkEngine.requestPause();
    });

    const paused = await sdkEngine.run();
    expect(paused.phase).toBe("paused");
    expect(paused.resumePhase).toBe("fixing");
    expect(paused.runtime).toBe("sdk");
    expect(paused.agentSessions.implementation).toMatchObject({
      status: "active",
      sessionId: expect.stringMatching(/^thr-/),
    });
    expect(paused.agentSessions.review).toMatchObject({
      status: "active",
      sessionId: expect.stringMatching(/^thr-/),
    });
    const pendingFindingCount = paused.pendingFindings.length;
    expect(pendingFindingCount).toBeGreaterThan(0);

    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w-e2e";
    process.env.XDG_STATE_HOME = join(setup.repo, ".state");
    const herdrEngine = EpicEngine.resume(
      paused.runId,
      {
        runtime: "herdr",
        herdrPath: setup.herdr,
        codexPath: setup.codex,
        accessMode: "danger-full-access",
      },
      setup.store,
    );
    expect(paused.runtime).toBe("sdk");
    const handoffStates: Array<typeof paused> = [];
    herdrEngine.onState((state) => {
      if (state.runtime === "herdr") handoffStates.push(state);
    });
    const completed = await herdrEngine.run();

    expect(completed.phase, completed.lastError ?? undefined).toBe("complete");
    expect(completed.runtime).toBe("herdr");
    expect(completed.agentAccessMode).toBe("danger-full-access");
    const handoffState = handoffStates[0];
    expect(handoffState).toMatchObject({
      runtime: "herdr",
      agentAccessMode: "danger-full-access",
    });
    expect(
      Object.values(handoffState?.agentSessions ?? {}).every(
        (session) => session.status === "inactive",
      ),
    ).toBe(true);
    expect(handoffState?.pendingFindings).toHaveLength(pendingFindingCount);
    const events = setup.store.events(completed.runId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "runtime.switched",
          message: "Switched runtime from sdk to herdr",
        }),
        expect.objectContaining({
          kind: "permissions.switched",
          message: "Enabled dangerous full access for all agents",
        }),
        expect.objectContaining({
          kind: "fix.started",
          message: `Starting a fresh implementation session for ${pendingFindingCount} finding(s)`,
        }),
      ]),
    );
    setup.store.close();
  }, 30_000);

  it("rotates blocked sessions when enabling dangerous full access", async () => {
    const setup = await fixture();
    const argumentLog = join(setup.repo, "..", "codex-args.jsonl");
    process.env.EPICD_FAKE_ARGS = argumentLog;
    process.env.EPICD_FAKE_MODE = "review-fix";
    const sandboxedEngine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    sandboxedEngine.onEvent((event) => {
      if (event.kind === "review.changes_requested") sandboxedEngine.requestPause();
    });

    const paused = await sandboxedEngine.run();
    expect(paused.phase).toBe("paused");
    expect(paused.agentAccessMode).toBe("sandboxed");
    expect(paused.agentSessions.implementation).toMatchObject({
      status: "active",
      sessionId: expect.stringMatching(/^thr-/),
    });
    expect(paused.agentSessions.review).toMatchObject({
      status: "active",
      sessionId: expect.stringMatching(/^thr-/),
    });

    const fullAccessEngine = EpicEngine.resume(
      paused.runId,
      {
        codexPath: setup.codex,
        accessMode: "danger-full-access",
      },
      setup.store,
    );
    const switchedStates: Array<typeof paused> = [];
    fullAccessEngine.onState((state) => {
      if (state.agentAccessMode === "danger-full-access") switchedStates.push(state);
    });
    const completed = await fullAccessEngine.run();

    expect(completed.phase, completed.lastError ?? undefined).toBe("complete");
    expect(completed.agentAccessMode).toBe("danger-full-access");
    expect(
      Object.values(switchedStates[0]?.agentSessions ?? {}).every(
        (session) => session.status === "inactive",
      ),
    ).toBe(true);
    expect(
      setup.store.events(completed.runId).some((event) => event.kind === "permissions.switched"),
    ).toBe(true);
    const invocations = readFileSync(argumentLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(invocations.some((args) => args[0] === "app-server")).toBe(true);
    expect(
      invocations.some((args) => args.includes("--sandbox") && args.includes("danger-full-access")),
    ).toBe(true);
    setup.store.close();
  }, 30_000);

  it("cold-switches a Herdr run back to SDK", async () => {
    const setup = await fixture();
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w-e2e";
    process.env.XDG_STATE_HOME = join(setup.repo, ".state");
    const herdrEngine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        runtime: "herdr",
        herdrPath: setup.herdr,
        codexPath: setup.codex,
      },
      setup.store,
    );
    herdrEngine.onEvent((event) => {
      if (event.kind === "orchestrator.selected") herdrEngine.requestPause();
    });

    const paused = await herdrEngine.run();
    expect(paused.phase).toBe("paused");
    expect(paused.resumePhase).toBe("claiming");
    expect(paused.agentSessions.orchestrator).toMatchObject({
      status: "active",
      sessionId: expect.stringMatching(/^ed-/),
    });

    const sdkEngine = EpicEngine.resume(
      paused.runId,
      { runtime: "sdk", codexPath: setup.codex },
      setup.store,
    );
    const completed = await sdkEngine.run();

    expect(completed.phase, completed.lastError ?? undefined).toBe("complete");
    expect(completed.runtime).toBe("sdk");
    expect(
      setup.store
        .events(completed.runId)
        .some(
          (event) =>
            event.kind === "runtime.switched" &&
            event.message === "Switched runtime from herdr to sdk",
        ),
    ).toBe(true);
    setup.store.close();
  }, 30_000);

  it("delivers, independently reviews, commits, verifies, and closes an epic", async () => {
    const setup = await fixture();
    const argumentLog = join(setup.repo, "..", "codex-args.jsonl");
    process.env.EPICD_FAKE_ARGS = argumentLog;
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        model: "gpt-fallback",
        agentSettings: {
          orchestrator: { model: "gpt-orchestrator", reasoningEffort: "medium" },
          implementation: { reasoningEffort: "max" },
          review: { model: "gpt-review", reasoningEffort: "ultra" },
        },
      },
      setup.store,
    );
    const state = await engine.run();
    expect(state.phase, state.lastError ?? undefined).toBe("complete");
    expect(state.completedTasks).toBe(1);
    expect(state.model).toBe("gpt-fallback");
    expect(state.recentOutcomes).toHaveLength(1);
    expect(state.recentOutcomes[0]).toMatchObject({ beadId: "demo.1", title: "Add the feature" });
    expect(state.agentSettings).toEqual({
      orchestrator: { model: "gpt-orchestrator", reasoningEffort: "medium" },
      implementation: { model: null, reasoningEffort: "max" },
      review: { model: "gpt-review", reasoningEffort: "ultra" },
    });
    const invocations = readFileSync(argumentLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expectInvocation(invocations, "epicd-orchestrator", "gpt-orchestrator", "medium");
    expectInvocation(invocations, "epicd-implementation", "gpt-fallback", "max");
    expectInvocation(invocations, "epicd-review", "gpt-review", "ultra");
    expect(readFileSync(join(setup.repo, "feature.txt"), "utf8")).toBe("implemented\n");
    const tracker = JSON.parse(readFileSync(join(setup.repo, ".beads", "state.json"), "utf8")) as {
      issues: Array<{ id: string; status: string }>;
    };
    expect(tracker.issues.every((issue) => issue.status === "closed")).toBe(true);
    const log = await runCommand("git", ["log", "--format=%s"], { cwd: setup.repo });
    expect(log.stdout).toContain("Add the feature (demo.1)");
    expect(log.stdout).toContain("chore(beads): close demo.1");
    expect(log.stdout).toContain("chore(beads): close demo");
    expect((await runCommand("git", ["status", "--porcelain"], { cwd: setup.repo })).stdout).toBe(
      "",
    );
    setup.store.close();
  }, 30_000);

  it("routes review findings back to the original implementation thread before committing", async () => {
    const setup = await fixture();
    const argumentLog = join(setup.repo, "..", "codex-args.jsonl");
    process.env.EPICD_FAKE_ARGS = argumentLog;
    process.env.EPICD_FAKE_MODE = "review-fix";
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        reasoningEffort: "medium",
        agentSettings: { review: { reasoningEffort: "xhigh" } },
      },
      setup.store,
    );
    const state = await engine.run();
    expect(state.phase, state.lastError ?? undefined).toBe("complete");
    expect(state.reviewPass).toBe(0);
    expect(readFileSync(join(setup.repo, "feature.txt"), "utf8")).toBe("fixed\n");
    expect(
      setup.store.events(state.runId).some((event) => event.kind === "review.changes_requested"),
    ).toBe(true);
    expect(setup.store.events(state.runId).some((event) => event.kind === "fix.completed")).toBe(
      true,
    );
    const invocations = readFileSync(argumentLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const agentInvocations = invocations.filter((args) => args[0] !== "app-server");
    expect(
      agentInvocations.every(
        (args) => args.includes("--model") && args.includes("gpt-config-default"),
      ),
    ).toBe(true);
    expectInvocation(invocations, "epicd-orchestrator", "gpt-config-default", "medium");
    expectInvocation(invocations, "epicd-implementation", "gpt-config-default", "medium");
    expectInvocation(invocations, "epicd-review", "gpt-config-default", "xhigh");
    const resumedInvocations = invocations.filter((args) => args.includes("resume"));
    expect(resumedInvocations.length).toBeGreaterThan(0);
    expect(
      resumedInvocations.every((args) =>
        args.some((arg) => arg.startsWith("model_reasoning_effort=")),
      ),
    ).toBe(true);
    setup.store.close();
  }, 30_000);

  it("applies live model changes only to threads created after the change", async () => {
    const setup = await fixture();
    const argumentLog = join(setup.repo, "..", "codex-args.jsonl");
    process.env.EPICD_FAKE_ARGS = argumentLog;
    process.env.EPICD_FAKE_MODE = "review-fix";
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        agentSettings: {
          orchestrator: { model: "gpt-old-orchestrator", reasoningEffort: "medium" },
          implementation: { model: "gpt-old-implementation", reasoningEffort: "high" },
          review: { model: "gpt-old-review", reasoningEffort: "xhigh" },
        },
      },
      setup.store,
    );
    engine.onEvent((event) => {
      if (event.kind === "review.changes_requested") engine.requestPause();
    });

    const paused = await engine.run();
    expect(paused.phase).toBe("paused");
    expect(paused.agentSessions).toMatchObject({
      implementation: {
        status: "active",
        contract: {
          effective: { model: "gpt-old-implementation", reasoningEffort: "high" },
        },
      },
      review: {
        status: "active",
        contract: { effective: { model: "gpt-old-review", reasoningEffort: "xhigh" } },
      },
    });
    const resumedEngine = EpicEngine.resume(paused.runId, { codexPath: setup.codex }, setup.store);

    const nextSettings = {
      orchestrator: { model: "gpt-new-orchestrator", reasoningEffort: "low" as const },
      implementation: { model: "gpt-new-implementation", reasoningEffort: "max" as const },
      review: { model: "gpt-new-review", reasoningEffort: "ultra" as const },
    };
    resumedEngine.configureFutureAgentSettings(nextSettings);
    const configured = resumedEngine.snapshot();
    expect(configured.agentSettings).toEqual(nextSettings);
    expect(configured.agentSessions).toMatchObject({
      orchestrator: {
        status: "active",
        contract: {
          effective: { model: "gpt-old-orchestrator", reasoningEffort: "medium" },
        },
      },
      implementation: {
        status: "active",
        contract: {
          effective: { model: "gpt-old-implementation", reasoningEffort: "high" },
        },
      },
      review: {
        status: "active",
        contract: { effective: { model: "gpt-old-review", reasoningEffort: "xhigh" } },
      },
    });

    const completed = await resumedEngine.resumeRun();
    expect(completed.phase, completed.lastError ?? undefined).toBe("complete");
    expect(completed.agentSettings).toEqual(nextSettings);
    expect(
      Object.values(completed.agentSessions).every((session) => session.status === "inactive"),
    ).toBe(true);

    const invocations = readFileSync(argumentLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const resumed = invocations.filter((args) => args.includes("resume"));
    expect(
      resumed.some(
        (args) =>
          args.includes("gpt-old-implementation") && args.includes('model_reasoning_effort="high"'),
      ),
    ).toBe(true);
    expect(
      resumed.some(
        (args) => args.includes("gpt-new-implementation") || args.includes("gpt-new-review"),
      ),
    ).toBe(false);
    expect(
      resumed.some(
        (args) =>
          args.includes("gpt-old-review") && args.includes('model_reasoning_effort="xhigh"'),
      ),
    ).toBe(true);
    expect(
      invocations.some(
        (args) =>
          !args.includes("resume") &&
          args.includes("gpt-new-review") &&
          args.includes('model_reasoning_effort="ultra"'),
      ),
    ).toBe(true);
    expect(
      setup.store.events(completed.runId).some((event) => event.kind === "agent.settings_updated"),
    ).toBe(true);
    setup.store.close();
  }, 30_000);

  it("applies a live change made while a new thread is resolving its default model", async () => {
    const setup = await fixture();
    const argumentLog = join(setup.repo, "..", "codex-model-race.jsonl");
    const marker = join(setup.repo, "..", "model-resolution-started");
    process.env.EPICD_FAKE_ARGS = argumentLog;
    process.env.EPICD_FAKE_MODEL_MARKER = marker;
    process.env.EPICD_FAKE_MODEL_DELAY_MS = "100";
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );

    const running = engine.run();
    await waitForFile(marker);
    engine.configureFutureAgentSettings({
      orchestrator: { model: "gpt-live-orchestrator", reasoningEffort: "low" },
      implementation: { model: "gpt-live-implementation", reasoningEffort: "high" },
      review: { model: "gpt-live-review", reasoningEffort: "xhigh" },
    });
    const completed = await running;

    expect(completed.phase, completed.lastError ?? undefined).toBe("complete");
    const invocations = readFileSync(argumentLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expectInvocation(invocations, "epicd-orchestrator", "gpt-live-orchestrator", "low");
    expect(
      invocations.some(
        (args) => args.includes("epicd-orchestrator") && args.includes("gpt-config-default"),
      ),
    ).toBe(false);
    setup.store.close();
  }, 30_000);

  it("coalesces repeated settings changes without pausing or repeating model discovery", async () => {
    const setup = await fixture();
    const argumentLog = join(setup.repo, "..", "codex-model-churn.jsonl");
    const marker = join(setup.repo, "..", "codex-model-churn-started");
    process.env.EPICD_FAKE_ARGS = argumentLog;
    process.env.EPICD_FAKE_MODEL_MARKER = marker;
    process.env.EPICD_FAKE_MODEL_DELAY_MS = "100";
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        agentSettings: {
          implementation: { model: "gpt-implementation" },
          review: { model: "gpt-review" },
        },
      },
      setup.store,
    );

    const running = engine.run();
    await waitForFile(marker);
    for (const reasoningEffort of ["low", "medium", "xhigh"] as const) {
      const settings = engine.snapshot().agentSettings;
      settings.orchestrator.reasoningEffort = reasoningEffort;
      engine.configureFutureAgentSettings(settings);
    }
    const completed = await running;

    expect(completed.phase, completed.lastError ?? undefined).toBe("complete");
    expect(
      setup.store
        .events(completed.runId)
        .filter((event) => event.kind === "agent.settings_changed_during_open")
        .map((event) => [event.message, event.detail]),
    ).toEqual([
      [
        "Applied updated orchestrator settings before creating its session",
        "1 change observed across 2 preparation attempts; no external session was created",
      ],
    ]);
    const invocations = readFileSync(argumentLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(invocations.filter((args) => args[0] === "app-server")).toHaveLength(1);
    expectInvocation(invocations, "epicd-orchestrator", "gpt-config-default", "xhigh");
    setup.store.close();
  }, 30_000);

  it("bounds repeated settings changes while preparing a new session", async () => {
    const setup = await fixture();
    const argumentLog = join(setup.repo, "..", "codex-bounded-settings.jsonl");
    process.env.EPICD_FAKE_ARGS = argumentLog;
    const originalPrepare = CodexRuntime.prototype.prepareNewSession;
    const startedResolvers: Array<() => void> = [];
    const releaseResolvers: Array<() => void> = [];
    const started = Array.from(
      { length: 3 },
      () => new Promise<void>((resolve) => startedResolvers.push(resolve)),
    );
    const releases = Array.from(
      { length: 3 },
      () => new Promise<void>((resolve) => releaseResolvers.push(resolve)),
    );
    let orchestratorPreparations = 0;
    vi.spyOn(CodexRuntime.prototype, "prepareNewSession").mockImplementation(async function (
      this: CodexRuntime,
      role,
      settings,
      previous,
      signal,
    ) {
      const contract = await originalPrepare.call(this, role, settings, previous, signal);
      if (role !== "orchestrator" || orchestratorPreparations >= 3) return contract;
      const attempt = orchestratorPreparations;
      orchestratorPreparations += 1;
      startedResolvers[attempt]?.();
      await releases[attempt];
      return contract;
    });
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        agentSettings: {
          orchestrator: { model: "gpt-step-0", reasoningEffort: "high" },
          implementation: { model: "gpt-implementation", reasoningEffort: "high" },
          review: { model: "gpt-review", reasoningEffort: "xhigh" },
        },
      },
      setup.store,
    );

    const running = engine.run();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await started[attempt];
      const settings = engine.snapshot().agentSettings;
      settings.orchestrator.model = `gpt-step-${attempt + 1}`;
      engine.configureFutureAgentSettings(settings);
      releaseResolvers[attempt]?.();
    }
    const completed = await running;

    expect(completed.phase, completed.lastError ?? undefined).toBe("complete");
    expect(completed.agentSettings.orchestrator.model).toBe("gpt-step-3");
    expect(orchestratorPreparations).toBe(3);
    expect(
      setup.store
        .events(completed.runId)
        .filter((event) => event.kind === "agent.settings_changed_during_open")
        .map((event) => [event.message, event.detail]),
    ).toEqual([
      [
        "Pinned orchestrator settings after repeated changes during session preparation",
        "3 changes observed across 3 preparation attempts; settings saved after the final preparation apply to the next session",
      ],
    ]);
    const invocations = readFileSync(argumentLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expectInvocation(invocations, "epicd-orchestrator", "gpt-step-2", "high");
    setup.store.close();
  }, 30_000);

  it("pins an opened turn while accepting new defaults under the active lease", async () => {
    const setup = await fixture();
    const argumentLog = join(setup.repo, "..", "codex-inflight-settings.jsonl");
    process.env.EPICD_FAKE_ARGS = argumentLog;
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        model: "gpt-before",
      },
      setup.store,
    );
    let configured = false;
    engine.onEvent((event) => {
      if (event.kind !== "implementation.started" || configured) return;
      configured = true;
      engine.configureFutureAgentSettings({
        orchestrator: { model: "gpt-after", reasoningEffort: "high" },
        implementation: { model: "gpt-after", reasoningEffort: "high" },
        review: { model: "gpt-after", reasoningEffort: "xhigh" },
      });
    });

    const completed = await engine.run();

    expect(completed.phase, completed.lastError ?? undefined).toBe("complete");
    const invocations = readFileSync(argumentLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expectInvocation(invocations, "epicd-implementation", "gpt-before", "high");
    expectInvocation(invocations, "epicd-review", "gpt-after", "xhigh");
    setup.store.close();
  }, 30_000);

  it("preserves approved workflow state when settings change during tree materialization", async () => {
    const setup = await fixture();
    const originalProspectiveTree = GitClient.prototype.prospectiveTree;
    let treeStarted!: () => void;
    let finishTree!: () => void;
    const started = new Promise<void>((resolve) => {
      treeStarted = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishTree = resolve;
    });
    vi.spyOn(GitClient.prototype, "prospectiveTree").mockImplementation(async function (
      this: GitClient,
    ) {
      treeStarted();
      await finish;
      return await originalProspectiveTree.call(this);
    });
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );

    const running = engine.run();
    await started;
    const settings = engine.snapshot().agentSettings;
    settings.review = { model: "gpt-next-review", reasoningEffort: "high" };
    engine.configureFutureAgentSettings(settings);
    finishTree();
    const completed = await running;

    expect(completed.phase, completed.lastError ?? undefined).toBe("complete");
    expect(completed.agentSettings.review).toEqual(settings.review);
    expect(setup.store.get(completed.runId)?.phase).toBe("complete");
    setup.store.close();
  }, 30_000);

  it("blocks from the last durable checkpoint when a transition invariant fails", async () => {
    const setup = await fixture();
    vi.spyOn(GitClient.prototype, "prospectiveTree").mockResolvedValue("");
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );

    const blocked = await engine.run();

    expect(blocked.phase).toBe("blocked");
    expect(blocked.resumePhase).toBe("reviewing");
    expect(blocked.lastError).toContain("reviewedTree");
    expect(setup.store.get(blocked.runId)).toMatchObject({
      phase: "blocked",
      resumePhase: "reviewing",
      lastError: blocked.lastError,
    });
    setup.store.close();
  }, 30_000);

  it("preserves a role reset to the run-wide model", async () => {
    const setup = await fixture();
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        model: "gpt-run-wide",
      },
      setup.store,
    );
    const inherited = engine.snapshot().agentSettings;
    inherited.orchestrator.model = null;
    inherited.orchestrator.reasoningEffort = null;
    engine.configureFutureAgentSettings(inherited);
    expect(engine.snapshot().agentSettings.orchestrator.model).toBeNull();
    expect(engine.snapshot().agentSettings.orchestrator.reasoningEffort).toBeNull();
    expect(engine.snapshot().model).toBe("gpt-run-wide");
    setup.store.close();
  });

  it("rotates a persistent coordinator before its next selection when settings change", async () => {
    const setup = await fixture();
    const argumentLog = join(setup.repo, "..", "codex-coordinator-rotation.jsonl");
    process.env.EPICD_FAKE_ARGS = argumentLog;
    const oldSettings = {
      orchestrator: { model: "gpt-old-orchestrator", reasoningEffort: "high" as const },
      implementation: { model: "gpt-implementation", reasoningEffort: "high" as const },
      review: { model: "gpt-review", reasoningEffort: "xhigh" as const },
    };
    const created = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        agentSettings: oldSettings,
      },
      setup.store,
    );
    const persisted = created.snapshot();
    persisted.agentSessions.orchestrator = {
      status: "active",
      sessionId: "thr-existing-orchestrator",
      contract: {
        runtime: "sdk",
        requested: oldSettings.orchestrator,
        effective: oldSettings.orchestrator,
      },
    };
    setup.store.save(persisted);
    const engine = EpicEngine.resume(persisted.runId, { codexPath: setup.codex }, setup.store);
    engine.configureFutureAgentSettings({
      ...oldSettings,
      orchestrator: { model: "gpt-new-orchestrator", reasoningEffort: "low" },
    });

    const completed = await engine.run();

    expect(completed.phase, completed.lastError ?? undefined).toBe("complete");
    const invocations = readFileSync(argumentLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expectInvocation(invocations, "epicd-orchestrator", "gpt-new-orchestrator", "low");
    expect(
      invocations.some(
        (args) => args.includes("resume") && args.includes("thr-existing-orchestrator"),
      ),
    ).toBe(false);
    expect(
      setup.store
        .events(completed.runId)
        .some((event) => event.kind === "orchestrator.settings_rotated"),
    ).toBe(true);
    setup.store.close();
  }, 30_000);

  it("uses targeted repair review and a fresh repair budget after exact verification", async () => {
    const setup = await fixture();
    const argumentLog = join(setup.repo, "..", "codex-args.jsonl");
    process.env.EPICD_FAKE_ARGS = argumentLog;
    process.env.EPICD_FAKE_MODE = "review-and-verification-fix";
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        maxReviewPasses: 1,
      },
      setup.store,
    );

    const state = await engine.run();

    expect(state.phase, state.lastError ?? undefined).toBe("complete");
    expect(state.maxReviewPasses).toBe(1);
    expect(readFileSync(join(setup.repo, "feature.txt"), "utf8")).toBe("verified-fixed\n");
    const events = setup.store.events(state.runId);
    expect(events.filter((event) => event.kind === "fix.completed")).toHaveLength(2);
    expect(events.filter((event) => event.kind === "git.committed")).toHaveLength(2);
    expect(
      events.filter(
        (event) =>
          event.kind === "review.started" && event.message.startsWith("Verifying fixes from"),
      ),
    ).toHaveLength(2);
    const invocations = readFileSync(argumentLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(invocations.filter((args) => args.includes("resume"))).toHaveLength(4);
    setup.store.close();
  }, 30_000);

  it("recovers the exhausted post-commit repair budget from legacy run state", async () => {
    const setup = await fixture();
    process.env.EPICD_FAKE_MODE = "verification-fix";
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    engine.onEvent((event) => {
      if (event.kind === "review.changes_requested" && engine.snapshot().candidateRevision) {
        engine.requestPause();
      }
    });

    const paused = await engine.run();
    expect(paused.phase).toBe("paused");
    expect(paused.resumePhase).toBe("fixing");
    paused.phase = "blocked";
    paused.reviewPass = 5;
    paused.lastError = "Review did not converge after 5 fix passes";
    setup.store.save(paused);

    const resumedEngine = EpicEngine.resume(paused.runId, { codexPath: setup.codex }, setup.store);
    const resumed = await resumedEngine.run();

    expect(resumed.phase, resumed.lastError ?? undefined).toBe("complete");
    expect(readFileSync(join(setup.repo, "feature.txt"), "utf8")).toBe("verified-fixed\n");
    expect(
      setup.store.events(resumed.runId).some((event) => event.kind === "repair.budget_recovered"),
    ).toBe(true);
    setup.store.close();
  }, 30_000);

  it("does not close a task when the verifier cites the wrong revision", async () => {
    const setup = await fixture();
    process.env.EPICD_FAKE_MODE = "wrong-revision";
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    const state = await engine.run();
    expect(state.phase).toBe("blocked");
    expect(state.resumePhase).toBe("verifying");
    expect(state.lastError).toContain("expected exact revision");
    const tracker = JSON.parse(readFileSync(join(setup.repo, ".beads", "state.json"), "utf8")) as {
      issues: Array<{ id: string; status: string }>;
    };
    expect(tracker.issues.find((issue) => issue.id === "demo.1")?.status).toBe("in_progress");
    process.env.EPICD_FAKE_MODE = "happy";
    const resumed = await engine.resumeRun();
    expect(resumed.phase, resumed.lastError ?? undefined).toBe("complete");
    setup.store.close();
  }, 30_000);

  it("detects a reviewer overwriting a file that was already dirty", async () => {
    const setup = await fixture();
    process.env.EPICD_FAKE_MODE = "reviewer-mutate";
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );

    const state = await engine.run();

    expect(state.phase).toBe("blocked");
    expect(state.resumePhase).toBe("reviewing");
    expect(state.lastError).toContain("Reviewer modified the working tree");
    expect(readFileSync(join(setup.repo, "feature.txt"), "utf8")).toBe("reviewer overwrite\n");
    setup.store.close();
  }, 30_000);

  it("detects a reviewer commit that leaves the working tree clean", async () => {
    const setup = await fixture();
    process.env.EPICD_FAKE_MODE = "reviewer-commit";
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );

    const state = await engine.run();

    expect(state.phase).toBe("blocked");
    expect(state.resumePhase).toBe("verifying");
    expect(state.lastError).toContain("Reviewer modified the working tree");
    expect(
      (
        await runCommand(
          "git",
          ["status", "--porcelain", "--", ".", ":(exclude).beads", ":(exclude).beads/**"],
          { cwd: setup.repo },
        )
      ).stdout,
    ).toBe("");
    setup.store.close();
  }, 30_000);

  it("rejects final-review session setup changes without persisting a false baseline", async () => {
    const setup = await fixture();
    const originalPrepare = CodexRuntime.prototype.prepareNewSession;
    let reviewPreparations = 0;
    vi.spyOn(CodexRuntime.prototype, "prepareNewSession").mockImplementation(async function (
      this: CodexRuntime,
      role,
      settings,
      previous,
      signal,
    ) {
      const contract = await originalPrepare.call(this, role, settings, previous, signal);
      if (role === "review") {
        reviewPreparations += 1;
        if (reviewPreparations === 3) {
          writeFileSync(join(setup.repo, "provider-startup.txt"), "unexpected startup output\n");
        }
      }
      return contract;
    });
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        model: "gpt-explicit",
      },
      setup.store,
    );

    const state = await engine.run();

    expect(state.phase).toBe("blocked");
    expect(state.resumePhase).toBe("final_review");
    expect(state.lastError).toContain("Final review session setup modified the working tree");
    expect(state.reviewBaselineFingerprint).toBeNull();
    expect(readFileSync(join(setup.repo, "provider-startup.txt"), "utf8")).toBe(
      "unexpected startup output\n",
    );
    setup.store.close();
  }, 30_000);

  it("labels integrity failures during exact-revision verification", async () => {
    const setup = await fixture();
    const originalPrepare = CodexRuntime.prototype.prepareNewSession;
    let reviewPreparations = 0;
    vi.spyOn(CodexRuntime.prototype, "prepareNewSession").mockImplementation(async function (
      this: CodexRuntime,
      role,
      settings,
      previous,
      signal,
    ) {
      const contract = await originalPrepare.call(this, role, settings, previous, signal);
      if (role === "review") {
        reviewPreparations += 1;
        if (reviewPreparations === 2) {
          writeFileSync(join(setup.repo, "verification-startup.txt"), "unexpected output\n");
        }
      }
      return contract;
    });
    const engine = await EpicEngine.create(
      {
        repoPath: setup.repo,
        epicId: "demo",
        codexPath: setup.codex,
        model: "gpt-explicit",
      },
      setup.store,
    );

    const state = await engine.run();

    expect(state.phase).toBe("blocked");
    expect(state.resumePhase).toBe("verifying");
    expect(state.lastError).toContain("Verification session setup modified the working tree");
    setup.store.close();
  }, 30_000);

  it("refuses changes made while paused between review and commit", async () => {
    const setup = await fixture();
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    engine.onEvent((event) => {
      if (event.kind === "review.started") engine.requestPause();
    });

    const paused = await engine.run();
    expect(paused.phase).toBe("paused");
    expect(paused.resumePhase).toBe("committing");
    writeFileSync(join(setup.repo, "feature.txt"), "changed after review\n");

    const resumed = await engine.resumeRun();
    expect(resumed.phase).toBe("blocked");
    expect(resumed.lastError).toContain("working tree changed after review");
    setup.store.close();
  }, 30_000);

  it("refuses to close after the verified application tree changes", async () => {
    const setup = await fixture();
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
      setup.store,
    );
    engine.onEvent((event) => {
      if (event.kind === "verification.started") engine.requestPause();
    });

    const paused = await engine.run();
    expect(paused.phase).toBe("paused");
    expect(paused.resumePhase).toBe("closing");
    writeFileSync(join(setup.repo, "feature.txt"), "changed after verification\n");

    const resumed = await engine.resumeRun();
    expect(resumed.phase).toBe("blocked");
    expect(resumed.lastError).toContain("clean application tree");
    const tracker = JSON.parse(readFileSync(join(setup.repo, ".beads", "state.json"), "utf8")) as {
      issues: Array<{ id: string; status: string }>;
    };
    expect(tracker.issues.find((issue) => issue.id === "demo.1")?.status).toBe("in_progress");
    setup.store.close();
  }, 30_000);
});

function expectInvocation(
  invocations: string[][],
  source: string,
  model: string,
  reasoning: string,
): void {
  const invocation = invocations.find((args) => args.includes(source));
  expect(invocation, `missing ${source} invocation`).toBeDefined();
  expect(invocation).toContain(model);
  expect(invocation).toContain(`model_reasoning_effort="${reasoning}"`);
}
