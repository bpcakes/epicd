import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { EpicEngine } from "../src/engine/engine.js";
import { runCommand } from "../src/util/command.js";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;
const originalHerdrEnvironment = {
  herdr: process.env.HERDR_ENV,
  workspace: process.env.HERDR_WORKSPACE_ID,
  state: process.env.XDG_STATE_HOME,
};

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.EPICD_FAKE_MODE;
  delete process.env.EPICD_FAKE_COUNTER;
  delete process.env.EPICD_FAKE_ARGS;
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
    response = {candidateId:"demo.1",rationale:"Only ready concrete task",dependencyNotes:[],riskNotes:[]};
  } else if (prompt.includes("You are the implementation owner") || prompt.includes("Continue as the implementation owner")) {
    const fixing = prompt.includes("Continue as the implementation owner");
    const committedFix = prompt.includes("last candidate was already committed");
    fs.writeFileSync(path.join(repo, "feature.txt"), committedFix ? "verified-fixed\\n" : fixing ? "fixed\\n" : "implemented\\n");
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

describe.sequential("EpicEngine workflow", () => {
  it("rejects per-role model or reasoning changes when resuming", async () => {
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
    expect(() =>
      EpicEngine.resume(
        state,
        { agentSettings: { review: { model: "gpt-review", reasoningEffort: "low" } } },
        setup.store,
      ),
    ).toThrow("persisted per-role model/reasoning settings");
    expect(() =>
      EpicEngine.resume(
        state,
        { agentSettings: { review: { model: "gpt-review", reasoningEffort: "xhigh" } } },
        setup.store,
      ),
    ).not.toThrow();
    expect(() => EpicEngine.resume(state, { maxReviewPasses: 4 }, setup.store)).toThrow(
      "persisted repair budget of 3 passes",
    );
    await expect(engine.resumeRun()).rejects.toThrow("Cannot resume a run in phase selecting");
    setup.store.close();
  });

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
    const resumedEngine = EpicEngine.resume(resumeInput, { codexPath: setup.codex }, setup.store);
    resumeInput.phase = "complete";
    resumeInput.pendingAgentCleanup.push({ kind: "run", runtime: "sdk" });

    expect(resumedEngine.snapshot()).toMatchObject({
      phase: "selecting",
      pendingAgentCleanup: [],
    });
    setup.store.close();
  });

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
      },
      setup.store,
    );
    const state = await engine.run();
    expect(state.phase, state.lastError ?? undefined).toBe("complete");
    expect(state.runtime).toBe("herdr");
    expect(state.orchestratorThreadId).toBeNull();
    expect(state.implementationThreadId).toBeNull();
    expect(state.reviewThreadId).toBeNull();
    expect(
      setup.store.events(state.runId).some((event) => event.message.includes("herdr session")),
    ).toBe(true);
    expect(
      setup.store.events(state.runId).some((event) => event.kind === "agent.cleanup_failed"),
    ).toBe(true);
    expect(state.pendingAgentCleanup.length).toBeGreaterThan(0);

    delete process.env.EPICD_HERDR_CLOSE_FAIL;
    const cleanupRetry = EpicEngine.resume(state, { herdrPath: setup.herdr }, setup.store);
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
    expect(paused.implementationThreadId).toMatch(/^thr-/);
    expect(paused.reviewThreadId).toMatch(/^thr-/);
    const pendingFindingCount = paused.pendingFindings.length;
    expect(pendingFindingCount).toBeGreaterThan(0);

    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w-e2e";
    process.env.XDG_STATE_HOME = join(setup.repo, ".state");
    const herdrEngine = EpicEngine.resume(
      paused,
      {
        runtime: "herdr",
        herdrPath: setup.herdr,
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
      orchestratorThreadId: null,
      implementationThreadId: null,
      reviewThreadId: null,
    });
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
    expect(paused.implementationThreadId).toMatch(/^thr-/);
    expect(paused.reviewThreadId).toMatch(/^thr-/);

    const fullAccessEngine = EpicEngine.resume(
      paused,
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
    expect(switchedStates[0]).toMatchObject({
      orchestratorThreadId: null,
      implementationThreadId: null,
      reviewThreadId: null,
    });
    expect(
      setup.store.events(completed.runId).some((event) => event.kind === "permissions.switched"),
    ).toBe(true);
    const invocations = readFileSync(argumentLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
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
      },
      setup.store,
    );
    herdrEngine.onEvent((event) => {
      if (event.kind === "orchestrator.selected") herdrEngine.requestPause();
    });

    const paused = await herdrEngine.run();
    expect(paused.phase).toBe("paused");
    expect(paused.resumePhase).toBe("claiming");
    expect(paused.orchestratorThreadId).toMatch(/^ed-/);

    const sdkEngine = EpicEngine.resume(
      paused,
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
    expect(state.recentOutcomes).toHaveLength(1);
    expect(state.recentOutcomes[0]).toMatchObject({ beadId: "demo.1", title: "Add the feature" });
    expect(state.agentSettings).toEqual({
      orchestrator: { model: "gpt-orchestrator", reasoningEffort: "medium" },
      implementation: { model: "gpt-fallback", reasoningEffort: "max" },
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
    process.env.EPICD_FAKE_MODE = "review-fix";
    const engine = await EpicEngine.create(
      { repoPath: setup.repo, epicId: "demo", codexPath: setup.codex },
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

    const resumedEngine = EpicEngine.resume(paused, { codexPath: setup.codex }, setup.store);
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
