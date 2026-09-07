import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { PublicationGit, RUN_OWNERSHIP_REF } from "../src/adapters/publication-git.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { RepositoryAdmission } from "../src/kernel/repository-admission.js";
import { runRepositoryIO } from "../dist/adapters/repository-io.js";
import { handoffRuntime } from "../src/bootstrap.js";
import * as codexSettings from "../src/adapters/codex-settings.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { SdkAgentSessionContractSchema, resolveAgentRoleSettings } from "../src/domain/types.js";
import { RuntimeHandoffTargetSchema } from "../src/domain/runtime-handoff.js";
import { buildOrchestratorContext } from "../src/orchestrator/context.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) close();
});
async function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-runtime-handoff-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(repo, "app.txt"), "baseline\n");
  git("add", "app.txt");
  git("commit", "-qm", "baseline");
  const repository = await new PublicationGit().bind(repo);
  const path = join(root, "state.sqlite3");
  let store = new StateStore(path);
  cleanup.push(() => store.close());
  const codex = join(root, "codex"),
    herdr = join(root, "herdr"),
    commands = join(root, "herdr-commands");
  writeFileSync(
    codex,
    '#!/bin/sh\ntest "$1" = --version || exit 31\nprintf "codex-cli 0.153.4\\n"\n',
    { mode: 0o700 },
  );
  // This strict CLI fixture permits discovery only. It does not start a native session or model.
  writeFileSync(
    herdr,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${commands}'\ncase "$*" in\n'status server') printf 'socket: /fixture/socket\\ncompatible: yes\\n';;\n'session list --json') printf '%s\\n' '{"sessions":[{"name":"fixture","running":true,"socket_path":"/fixture/socket"}]}';;\n'pane current --current') printf '%s\\n' '{"result":{"pane":{"workspace_id":"w-test"}}}';;\n*) exit 32;;\nesac\n`,
    { mode: 0o700 },
  );
  const state = store.create(
    {
      ...initialRun(),
      repoPath: repo,
      epicBaseRevision: git("rev-parse", "HEAD"),
      runtimeConfiguration: {
        commonDirectory: repository.commonDirectory,
        executable: codex,
        trackerExecutable: "/usr/bin/false",
        workspaceRoot: join(root, "workspaces"),
        runtimeRoot: join(root, "runtime"),
        authCachePath: null,
        turnTimeoutMs: 30000,
        herdr: null,
      },
    },
    RepositoryPolicySchema.parse({ schemaVersion: 1, budgets: { epicDecisions: 8 } }),
  );
  const lease = store.acquireLease(state.runId);
  let authority = { runId: state.runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
  const journal = store.orchestration;
  const admission = new RepositoryAdmission(
    store,
    authority,
    repository,
    undefined,
    runRepositoryIO,
  );
  await admission.enter();
  const manager = new WorkspaceManager(journal, state.runtimeConfiguration!.workspaceRoot);
  const workspace = await manager.create(authority, repo, state.epicBaseRevision, "coordinator");
  const settings = { model: "gpt-6-astra", reasoningEffort: "high" as const };
  const agent = journal.agents.reserveAgent(
    authority,
    {
      ...workspace,
      role: "orchestrator",
      purpose: "coordination",
      taskId: null,
      candidateId: null,
      instructions: "Coordinate this bounded fixture",
      contract: SdkAgentSessionContractSchema.parse({
        runtime: "sdk",
        requested: settings,
        effective: settings,
      }),
      confinementProfile: "epicd-isolated",
    },
    journal.control(state.runId).controlVersion,
  );
  const target = RuntimeHandoffTargetSchema.parse({
    runtime: "herdr",
    executable: codex,
    herdr: { executable: herdr, sessionName: "fixture", workspaceId: "w-test" },
  });
  const version = () => store.orchestration.control(state.runId).controlVersion;
  const pause = () =>
    store.orchestration.operatorControl(state.runId, version(), { kind: "pause" });
  const detach = () => store.releaseLease(state.runId, authority.ownerToken);
  const reopen = () => {
    store.close();
    store = new StateStore(path);
    const next = store.acquireLease(state.runId);
    authority = { runId: state.runId, ownerToken: next.ownerToken, leaseId: next.leaseId };
    return store;
  };
  const db = new Database(path);
  cleanup.push(() => db.close());
  return {
    root,
    repo,
    path,
    git,
    state,
    journal,
    admission,
    workspace,
    agent,
    target,
    version,
    pause,
    detach,
    reopen,
    db,
    codex,
    herdr,
    commands,
    get store() {
      return store;
    },
    get authority() {
      return authority;
    },
  };
}

describe.runIf(process.platform === "linux")("explicit current-format runtime handoff", () => {
  it("cold-switches SDK to Herdr to SDK without sharing conversations, refilling budgets or changing user work", async () => {
    const f = await fixture(),
      run = f.state.runId;
    const memory = f.journal.recordMemory(f.authority, {
      kind: "strategy",
      content: "Investigate browser failure before review",
      scope: "run",
      taskId: null,
      confidence: "hypothesis",
      observationIds: [],
      evidenceIds: [],
      revision: null,
      environmentGeneration: null,
      supersedes: null,
    });
    const ticket = f.journal.beginDecision(
      f.authority,
      f.journal.latestObservationCursor(run),
      f.version(),
    );
    const before = f.journal.control(run);
    const workspace = f.journal.agents.workspace(run, f.workspace),
      owner = f.git("rev-parse", RUN_OWNERSHIP_REF),
      index = readFileSync(join(f.repo, ".git/index"));
    writeFileSync(join(f.repo, "app.txt"), "user-owned change\n");
    f.pause();
    const changed = f.journal.handoffRuntime(f.authority, f.version(), f.target);
    expect(changed.runtime).toBe("herdr");
    expect(changed.runtimeConfiguration).toEqual({
      ...f.state.runtimeConfiguration,
      herdr: f.target.herdr,
    });
    expect(resolveAgentRoleSettings(changed, "orchestrator")).toEqual({
      model: "gpt-6-astra",
      reasoningEffort: "high",
    });
    expect(f.journal.agents.instance(run, f.agent)).toMatchObject({
      status: "released",
      provider: null,
      contract: f.agent.contract,
    });
    expect(f.journal.agents.workspace(run, f.workspace)).toEqual(workspace);
    expect(
      f.db.prepare("SELECT status FROM decisions WHERE decision_id = ?").get(ticket.decisionId),
    ).toEqual({ status: "cancelled" });
    expect(f.journal.memory(run)).toEqual([memory]);
    expect(f.journal.control(run)).toMatchObject({
      status: "paused",
      decisionsUsed: before.decisionsUsed,
      maxDecisions: before.maxDecisions,
      policyDigest: before.policyDigest,
      observationCursor: before.observationCursor,
    });
    f.detach();
    const reopened = f.reopen();
    const back = reopened.orchestration.handoffRuntime(f.authority, f.version(), {
      runtime: "sdk",
      executable: f.codex,
      herdr: null,
    });
    expect(back.runtimeConfiguration).toEqual(f.state.runtimeConfiguration);
    const context = buildOrchestratorContext(new ActionKernel(reopened.orchestration), run);
    expect(context.memory).toEqual([memory]);
    expect(
      context.observations.filter((event) => event.kind === "operator.runtime_handoff"),
    ).toHaveLength(2);
    expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(owner);
    expect(f.git("rev-parse", "HEAD")).toBe(f.state.epicBaseRevision);
    expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("user-owned change\n");
    expect(reopened.orchestration.agents.turns(run)).toEqual([]);
  });

  it("retires a stopped conversation but preserves its exact successful turn and provider identity", async () => {
    const f = await fixture(),
      run = f.state.runId;
    const provider = { runtime: "sdk" as const, sessionId: randomUUID() };
    f.journal.agents.bindProvider(f.authority, f.agent, provider);
    const turn = f.journal.agents.prepareTurn(
      f.authority,
      f.agent,
      randomUUID(),
      "A scripted result",
      { type: "object" },
      f.version(),
    );
    f.journal.agents.markSubmitting(f.authority, turn.identity);
    f.journal.agents.acknowledgePrompt(
      f.authority,
      turn.identity,
      turn.promptDigest,
      "Fixture acknowledged exact turn",
    );
    f.journal.agents.finishTurn(f.authority, turn.identity, {
      status: "completed",
      result: { fact: "retained" },
      stopEvidence: "Fixture has no external process",
    });
    const settled = f.journal.agents.turn(run, turn.identity);
    expect(settled.resultEligible).toBe(true);
    f.pause();
    f.journal.handoffRuntime(f.authority, f.version(), f.target);
    expect(f.journal.agents.turn(run, turn.identity)).toEqual(settled);
    expect(f.journal.agents.instance(run, f.agent).provider).toEqual(provider);
    f.journal.operatorControl(run, f.version(), { kind: "resume" });
    expect(() =>
      f.journal.agents.prepareTurn(
        f.authority,
        f.agent,
        randomUUID(),
        "Do not reuse old conversation",
        { type: "object" },
        f.version(),
      ),
    ).toThrow();
  });

  it.each([
    "active",
    "stale_version",
    "stale_lease",
    "unsettled_turn",
    "workspace_io",
    "pending_message",
    "unfinished_action",
    "unsettled_decision",
    "unknown_admission",
  ])("refuses %s without retiring agents or rewriting runtime state", async (reason) => {
    const f = await fixture(),
      run = f.state.runId;
    if (reason === "unsettled_turn")
      f.journal.agents.prepareTurn(
        f.authority,
        f.agent,
        randomUUID(),
        "Unsubmitted is not settled",
        { type: "object" },
        f.version(),
      );
    if (reason === "workspace_io")
      f.journal.agents.beginWorkspaceOperation(f.authority, f.workspace, "capture", f.version());
    if (reason === "pending_message")
      f.journal.agents.enqueueAgentMessage(
        f.authority,
        f.agent,
        randomUUID(),
        "Unconsumed operator instruction",
      );
    if (reason === "unfinished_action") {
      const ticket = f.journal.beginDecision(
        f.authority,
        f.journal.latestObservationCursor(run),
        f.version(),
      );
      f.journal.acceptAction(f.authority, {
        explanation: "Unfinished fixture action",
        evidenceIds: [],
        request: {
          schemaVersion: 1,
          decisionId: ticket.decisionId,
          observationCursor: ticket.observationCursor,
          expectedControlVersion: ticket.expectedControlVersion,
          action: { kind: "inspect_run" },
        },
      });
    }
    if (reason === "unknown_admission") {
      const record = f.journal.repositoryAdmission.record(run)!;
      f.db
        .prepare("UPDATE repository_admissions SET record_json = ? WHERE run_id = ?")
        .run(
          JSON.stringify({ ...record, phase: "acquiring", ioStopped: false, ioReceipt: null }),
          run,
        );
    }
    if (reason === "unsettled_decision") {
      const context = buildOrchestratorContext(new ActionKernel(f.journal), run);
      const ticket = f.journal.beginDecision(f.authority, context.observationCursor, f.version());
      f.journal.decisionSource.prepare(f.authority, ticket, JSON.stringify(context));
      f.journal.decisionSource.start(f.authority, ticket.decisionId);
    }
    const oldVersion = f.version(),
      oldAuthority = f.authority;
    if (reason !== "active") f.pause();
    if (reason === "stale_lease") {
      f.detach();
      f.reopen();
    }
    const journal = f.store.orchestration;
    const state = f.store.get(run),
      agents = journal.agents.instances(run),
      observations = journal.observations(run);
    expect(() =>
      journal.handoffRuntime(
        reason === "stale_lease" ? oldAuthority : f.authority,
        reason === "stale_version" ? oldVersion : f.version(),
        f.target,
      ),
    ).toThrow();
    expect(f.store.get(run)).toEqual(state);
    expect(journal.agents.instances(run)).toEqual(agents);
    expect(journal.observations(run)).toEqual(observations);
  });

  it("rolls back retirement, runtime, ticket cancellation and control version if audit persistence fails", async () => {
    const f = await fixture(),
      run = f.state.runId;
    f.journal.beginDecision(f.authority, f.journal.latestObservationCursor(run), f.version());
    f.pause();
    const state = f.store.get(run),
      agent = f.journal.agents.instance(run, f.agent),
      control = f.journal.control(run),
      ticket = f.journal.pendingDecision(run),
      events = f.journal.observations(run);
    const observe = f.journal.appendObservation.bind(f.journal);
    vi.spyOn(f.journal, "appendObservation").mockImplementation((authority, input) => {
      if (input.kind !== "operator.runtime_handoff") return observe(authority, input);
      // Fail the final audit only after every mutation is visible on this transaction's connection.
      expect(f.store.get(run)?.runtime).toBe("herdr");
      expect(f.journal.agents.instance(run, f.agent).status).toBe("released");
      expect(f.journal.pendingDecision(run)).toBeNull();
      expect(f.journal.control(run).controlVersion).toBeGreaterThan(control.controlVersion);
      throw new Error("Audit failure");
    });
    expect(() => f.journal.handoffRuntime(f.authority, f.version(), f.target)).toThrow(
      "Audit failure",
    );
    expect(f.store.get(run)).toEqual(state);
    expect(f.journal.agents.instance(run, f.agent)).toEqual(agent);
    expect(f.journal.control(run)).toEqual(control);
    expect(f.journal.pendingDecision(run)).toEqual(ticket);
    expect(f.journal.observations(run)).toEqual(events);
  });

  it("preserves an unanswered escalation and does not mint fixture authority", async () => {
    const f = await fixture(),
      run = f.state.runId;
    const id = f.journal.setEscalation(
      f.authority,
      "May I create the declared fixture?",
      "authority",
      [],
    );
    const question = f.journal.pendingEscalation(run),
      policy = f.journal.policy(run),
      fixtures = f.journal.fixtures.summary(run);
    f.journal.handoffRuntime(f.authority, f.version(), f.target);
    expect(f.journal.pendingEscalation(run)).toEqual(question);
    expect(f.journal.pendingEscalation(run)?.escalationId).toBe(id);
    expect(f.journal.control(run).status).toBe("awaiting_user");
    expect(f.journal.policy(run)).toEqual(policy);
    expect(f.journal.fixtures.summary(run)).toEqual(fixtures);
  });

  it("runs only strict native caller discovery and leaves the selected runtime unstarted", async () => {
    const f = await fixture();
    f.pause();
    f.detach();
    vi.stubEnv("HERDR_ENV", "1");
    const next = await handoffRuntime(f.store, f.state.runId, {
      runtime: "herdr",
      controlVersion: f.version(),
      codexPath: f.codex,
      herdrPath: f.herdr,
    });
    expect(next.runtimeConfiguration?.herdr).toEqual(f.target.herdr);
    expect(readFileSync(f.commands, "utf8").trim().split("\n")).toEqual([
      "status server",
      "session list --json",
      "pane current --current",
    ]);
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
    expect(f.journal.agents.turns(f.state.runId)).toEqual([]);
  });

  it("rejects Herdr outside a managed caller without issuing discovery or changing the selection", async () => {
    const f = await fixture();
    f.pause();
    f.detach();
    vi.stubEnv("HERDR_ENV", "0");
    await expect(
      handoffRuntime(f.store, f.state.runId, {
        runtime: "herdr",
        controlVersion: f.version(),
        codexPath: f.codex,
        herdrPath: f.herdr,
      }),
    ).rejects.toThrow("Herdr-managed caller");
    expect(f.store.get(f.state.runId)).toEqual(f.state);
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
    expect(() => readFileSync(f.commands)).toThrow();
  });

  it("rechecks operator control after asynchronous executable preflight", async () => {
    const f = await fixture();
    f.pause();
    f.detach();
    vi.stubEnv("HERDR_ENV", "1");
    vi.spyOn(codexSettings, "verifyCodexExecutable").mockImplementation(async () => {
      f.pause();
      return "fixture";
    });
    await expect(
      handoffRuntime(f.store, f.state.runId, {
        runtime: "herdr",
        controlVersion: f.version(),
        codexPath: f.codex,
        herdrPath: f.herdr,
      }),
    ).rejects.toThrow("Control changed");
    expect(f.store.get(f.state.runId)).toEqual(f.state);
    expect(f.journal.agents.instance(f.state.runId, f.agent).status).toBe("reserved");
  });

  it("checks physical repository ownership before applying the handoff", async () => {
    const f = await fixture();
    f.pause();
    f.detach();
    f.git("update-ref", RUN_OWNERSHIP_REF, f.state.epicBaseRevision);
    vi.stubEnv("HERDR_ENV", "1");
    await expect(
      handoffRuntime(f.store, f.state.runId, {
        runtime: "herdr",
        controlVersion: f.version(),
        codexPath: f.codex,
        herdrPath: f.herdr,
      }),
    ).rejects.toThrow("ownership changed");
    expect(f.store.get(f.state.runId)).toEqual(f.state);
    expect(f.git("rev-parse", RUN_OWNERSHIP_REF)).toBe(f.state.epicBaseRevision);
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
  });

  it("exposes handoff through the compiled CLI and retains resume's fixed-runtime contract", async () => {
    const f = await fixture();
    f.pause();
    f.detach();
    const result = spawnSync(
      process.execPath,
      [
        "dist/cli.js",
        "handoff",
        f.state.runId,
        "--state",
        f.path,
        "--runtime",
        "herdr",
        "--control-version",
        String(f.version()),
        "--codex-path",
        f.codex,
        "--herdr-path",
        f.herdr,
      ],
      { encoding: "utf8", timeout: 10000, env: { ...process.env, HERDR_ENV: "1" } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No model started");
    expect(f.store.get(f.state.runId)?.runtime).toBe("herdr");
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
  });
});
