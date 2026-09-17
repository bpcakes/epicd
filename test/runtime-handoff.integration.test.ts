import { freezeAccountDraft } from "../src/adapters/accounts.js";
import { AccountPreferencesSchema, resolveAccountDraft } from "../src/domain/accounts.js";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { StateStore } from "../src/adapters/store.js";
import { OrchestrationJournal } from "../src/adapters/orchestration-journal.js";
import { ControlledHerdrRuntime } from "../src/adapters/controlled-herdr.js";
import { ControlledSdkRuntime } from "../src/adapters/controlled-sdk.js";
import { ControlledAgentDispatcher } from "../src/adapters/agent-dispatch.js";
import { OrchestratorController } from "../src/controller.js";
import { ControlledLaunches } from "../src/adapters/controlled-launch.js";
import { codexConfinementConfig } from "../src/adapters/codex-confinement.js";
import { PublicationGit, RUN_OWNERSHIP_REF } from "../src/adapters/publication-git.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { RepositoryAdmission } from "../src/kernel/repository-admission.js";
import { runRepositoryIO } from "../dist/adapters/repository-io.js";
import { handoffRuntime, handoffRuntimeEffect } from "../src/bootstrap.js";
import { runStatusView, humanRunStatus } from "../src/status.js";
import { RunOperator } from "../src/operator-controls.js";
import * as codexSettings from "../src/adapters/codex-settings.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import {
  HerdrAgentSessionContractSchema,
  SdkAgentSessionContractSchema,
  resolveAgentRoleSettings,
} from "../src/domain/types.js";
import { RuntimeHandoffTargetSchema } from "../src/domain/runtime-handoff.js";
import { buildOrchestratorContext } from "../src/orchestrator/context.js";
import {
  coordinatorConversationPressure,
  COORDINATOR_CONVERSATION_LIMITS,
} from "../src/orchestrator/conversation.js";
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
  const accountHome = join(root, "account");
  {
    mkdirSync(accountHome, { mode: 0o700 });
    writeFileSync(
      join(accountHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: "2026-09-01T00:00:00Z",
        tokens: {
          account_id: "fixture",
          access_token: "synthetic-access",
          id_token: `e30.${Buffer.from('{"sub":"member"}').toString("base64url")}.c2ln`,
        },
      }),
      { mode: 0o600 },
    );
  }
  const accounts = await freezeAccountDraft(
    resolveAccountDraft({
      preferences: AccountPreferencesSchema.parse({ schemaVersion: 1 }),
      configPath: join(root, "accounts.json"),
      cwd: root,
      operatorHome: root,
      overrides: { codexHome: accountHome },
    }),
  );
  const state = store.create(
    {
      ...initialRun(),
      stateSchemaVersion: 4,
      repoPath: repo,
      epicBaseRevision: git("rev-parse", "HEAD"),
      runtimeConfiguration: {
        commonDirectory: repository.commonDirectory,
        executable: codex,
        trackerExecutable: "/usr/bin/false",
        workspaceRoot: join(root, "workspaces"),
        runtimeRoot: join(root, "runtime"),
        accounts,
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
        backend: "codex",
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

function retainedTarget(f: Awaited<ReturnType<typeof fixture>>) {
  const provider = f.journal.agents.instance(f.state.runId, f.agent).provider;
  const sessionId = provider?.runtime === "sdk" ? provider.sessionId : randomUUID();
  if (provider === null)
    f.journal.agents.bindProvider(f.authority, f.agent, {
      backend: "codex",
      runtime: "sdk",
      sessionId,
    });
  f.pause();
  f.journal.handoffRuntime(f.authority, f.version(), f.target, true);
  const transfer = f.journal.agents.pendingCoordinatorConversationTransfer(f.state.runId, "herdr")!;
  f.journal.operatorControl(f.state.runId, f.version(), { kind: "resume" });
  const settings = { model: "gpt-6-astra", reasoningEffort: "high" as const };
  const contract = HerdrAgentSessionContractSchema.parse({
    backend: "codex",
    runtime: "herdr",
    requested: settings,
    effective: settings,
  });
  const target = f.journal.agents.reserveAgent(
    f.authority,
    {
      ...f.workspace,
      role: "orchestrator",
      purpose: "coordination",
      taskId: null,
      candidateId: null,
      instructions: "Resume retained session",
      contract,
      confinementProfile: "epicd-isolated",
      replaces: f.agent,
      conversationTransferId: transfer.transferId,
    },
    f.version(),
  );
  return { sessionId, transfer, target, contract };
}

describe.runIf(process.platform === "linux")("explicit current-format runtime handoff", () => {
  it("keeps conversation pressure across the validated runtime-transfer lineage", async () => {
    const f = await fixture();
    f.journal.agents.bindProvider(f.authority, f.agent, {
      backend: "codex",
      runtime: "sdk",
      sessionId: randomUUID(),
    });
    for (let index = 0; index < COORDINATOR_CONVERSATION_LIMITS.turns - 1; index += 1) {
      const turn = f.journal.agents.prepareTurn(
        f.authority,
        f.agent,
        randomUUID(),
        `Retained source turn ${index}`,
        { type: "object" },
        f.version(),
      );
      f.journal.agents.markSubmitting(f.authority, turn.identity);
      f.journal.agents.acknowledgePrompt(
        f.authority,
        turn.identity,
        turn.promptDigest,
        "Fixture accepted retained source turn",
      );
      f.journal.agents.finishTurn(f.authority, turn.identity, {
        status: "completed",
        result: { index },
        stopEvidence: "Fixture has no external process",
      });
    }
    const { sessionId, target } = retainedTarget(f);
    f.journal.agents.bindProvider(f.authority, target, {
      backend: "codex",
      runtime: "herdr",
      name: "continued",
      paneId: "pane",
      tabId: "tab",
      terminalId: "terminal",
      sessionId,
    });
    const targetTurn = f.journal.agents.prepareTurn(
      f.authority,
      target,
      randomUUID(),
      "Reach the retained conversation rollover boundary",
      { type: "object" },
      f.version(),
    );
    f.journal.agents.markSubmitting(f.authority, targetTurn.identity);
    f.journal.agents.acknowledgePrompt(
      f.authority,
      targetTurn.identity,
      targetTurn.promptDigest,
      "Fixture accepted retained target turn",
    );
    f.journal.agents.finishTurn(f.authority, targetTurn.identity, {
      status: "completed",
      result: { retained: true },
      stopEvidence: "Fixture has no external process",
    });
    const turns = f.journal.agents.operationalTurns(f.state.runId);
    expect(coordinatorConversationPressure(target, turns).turns).toBe(1);
    const lineage = f.journal.agents.conversationLineageIdentities(f.state.runId, target);
    expect(coordinatorConversationPressure(target, turns, lineage)).toMatchObject({
      reasons: ["turn_limit"],
      turns: COORDINATOR_CONVERSATION_LIMITS.turns,
    });
    f.pause();
    expect(() =>
      f.journal.handoffRuntime(
        f.authority,
        f.version(),
        { runtime: "sdk", executable: f.codex, herdr: null },
        true,
      ),
    ).toThrow("reached its rollover boundary");
    expect(f.journal.agents.instance(f.state.runId, target)).toMatchObject({
      status: "ready",
      provider: { sessionId },
    });
  });

  it("rejects retained continuity from a revoked coordinator at handoff and journal boundaries", async () => {
    const f = await fixture(),
      run = f.state.runId;
    f.journal.agents.bindProvider(f.authority, f.agent, {
      backend: "codex",
      runtime: "sdk",
      sessionId: randomUUID(),
    });
    f.journal.agents.revokeAgent(f.authority, f.agent, "Conversation authority was revoked");
    f.pause();
    const version = f.version();

    expect(() => f.journal.handoffRuntime(f.authority, version, f.target, true)).toThrow(
      "Retaining continuity requires exactly one stopped coordinator",
    );
    expect(f.version()).toBe(version);
    expect(f.store.get(run)?.runtime).toBe("sdk");
    expect(f.journal.agents.instance(run, f.agent)).toMatchObject({
      status: "revoked",
      revokedReason: "Conversation authority was revoked",
    });
    expect(f.journal.agents.hasOpenConversationTransfers(run)).toBe(false);

    const released = f.journal.agents.retireStoppedAgent(f.authority, f.agent);
    expect(released).toMatchObject({
      status: "released",
      revokedReason: "Conversation authority was revoked",
    });
    expect(() =>
      f.journal.agents.createCoordinatorConversationTransfer(f.authority, released, "herdr"),
    ).toThrow("non-revoked");
  });

  it("does not rescan ownership when a continued provider binding is unchanged", async () => {
    const f = await fixture();
    const { target, sessionId } = retainedTarget(f);
    const provider = {
      backend: "codex" as const,
      runtime: "herdr" as const,
      name: "continued",
      paneId: "pane",
      tabId: "tab",
      terminalId: "terminal",
      sessionId,
    };
    let ownershipInventories = 0;
    const db = new Database(f.path, {
      verbose: (sql) => {
        if (
          typeof sql === "string" &&
          sql.includes("FROM agent_instances agent") &&
          sql.includes("LEFT JOIN agent_ownership_revisions")
        )
          ownershipInventories += 1;
      },
    });
    const journal = new OrchestrationJournal(db, () => f.store.storageIdentity());
    try {
      expect(journal.agents.bindProvider(f.authority, target, provider)).toMatchObject({
        provider,
      });
      expect(ownershipInventories).toBe(1);
      for (let attempt = 0; attempt < 4; attempt += 1)
        expect(journal.agents.bindProvider(f.authority, target, provider)).toMatchObject({
          provider,
        });
      expect(ownershipInventories).toBe(1);
    } finally {
      db.close();
    }
  });

  it("keeps a coordinator workspace registered while an open transfer pins it", async () => {
    const f = await fixture();
    f.journal.agents.bindProvider(f.authority, f.agent, {
      backend: "codex",
      runtime: "sdk",
      sessionId: randomUUID(),
    });
    f.pause();
    f.journal.handoffRuntime(f.authority, f.version(), f.target, true);
    const transfer = f.journal.agents.pendingCoordinatorConversationTransfer(
      f.state.runId,
      "herdr",
    );
    f.journal.operatorControl(f.state.runId, f.version(), { kind: "resume" });

    expect(() => f.journal.agents.retireWorkspace(f.authority, f.workspace)).toThrow(
      "explicitly abandon",
    );
    expect(f.journal.agents.workspace(f.state.runId, f.workspace).status).toBe("ready");
    expect(f.journal.agents.hasOpenConversationTransfers(f.state.runId)).toBe(true);
    expect(transfer?.status).toBe("pending");
  });

  it.each(["claimed", "pending"] as const)(
    "abandons a %s failed native resume through the operator boundary and starts fresh after reopen",
    async (transferState) => {
      const f = await fixture(),
        run = f.state.runId;
      const { transfer, target, sessionId } = retainedTarget(f);
      const turn = f.journal.agents.prepareTurn(
        f.authority,
        target,
        randomUUID(),
        "Resume missing session",
        { type: "object" },
        f.version(),
      );
      vi.stubEnv("HERDR_ENV", "1");
      const runtime = new ControlledHerdrRuntime(f.journal, {
        root: target.execution.runtimeRoot,
        executable: f.codex,
        turnTimeoutMs: target.execution.turnTimeoutMs,
        launcherEntrypoint: join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
        herdrPath: f.herdr,
        sessionName: "fixture",
        workspaceId: "w-test",
      });
      const failed = await runtime.run(f.authority, turn.identity);
      expect(failed.status).toBe("failed");
      expect(
        f.journal
          .observations(run)
          .filter((entry) => entry.kind === "runtime.problem")
          .map((entry) => entry.summary)
          .join(" "),
      ).toContain("recorded native conversation is missing");
      expect(failed.stopEvidence).not.toBeNull();
      expect(failed.launch?.stop?.processTreeStopped).toBe(true);
      expect(f.journal.agents.instance(run, target).provider).toBeNull();
      if (transferState === "pending") {
        f.journal.agents.retireStoppedAgent(f.authority, target);
        const unrelatedCopy = await new WorkspaceManager(
          f.journal,
          f.state.runtimeConfiguration!.workspaceRoot,
        ).create(f.authority, f.repo, f.state.epicBaseRevision, "coordinator");
        const unrelated = f.journal.agents.reserveAgent(
          f.authority,
          {
            ...unrelatedCopy,
            role: "orchestrator",
            purpose: "coordination",
            taskId: null,
            candidateId: null,
            instructions: "Unrelated stopped historical owner",
            confinementProfile: "epicd-isolated",
            contract: target.contract,
            replaces: target,
          },
          f.version(),
        );
        f.journal.agents.retireStoppedAgent(f.authority, unrelated);
        const damaged = { ...f.journal.agents.instance(run, unrelated), schemaVersion: 1 };
        f.db
          .prepare(
            "UPDATE agent_instances SET record_json=? WHERE run_id=? AND agent_id=? AND generation=?",
          )
          .run(JSON.stringify(damaged), run, unrelated.agentId, unrelated.agentGeneration);
        expect(f.journal.agents.ownershipAssessment(run, unrelated).state).toBe("isolated");
      }
      f.pause();
      const operator = new RunOperator(f.store, run);
      await expect(
        operator.submit({
          kind: "abandon_conversation",
          controlVersion: f.version(),
          transferId: transfer.transferId,
          reason: "Session is unavailable",
        }),
      ).rejects.toThrow();
      expect(f.journal.agents.conversationTransfer(run, transfer.transferId).status).toBe(
        transferState,
      );
      f.detach();
      const version = f.version();
      await expect(
        operator.submit({
          kind: "abandon_conversation",
          controlVersion: version - 1,
          transferId: transfer.transferId,
          reason: "Session is unavailable",
        }),
      ).rejects.toThrow("Control changed");
      if (transferState === "pending") {
        const command = spawnSync(
          process.execPath,
          [
            "dist/cli.js",
            "abandon-conversation",
            run,
            transfer.transferId,
            "--state",
            f.path,
            "--control-version",
            String(version),
            "--reason",
            "Session is unavailable",
          ],
          { encoding: "utf8", timeout: 10000 },
        );
        expect(command.status, command.stderr).toBe(0);
        expect(command.stdout).toContain("Conversation transfer abandoned");
      } else {
        await operator.submit({
          kind: "abandon_conversation",
          controlVersion: version,
          transferId: transfer.transferId,
          reason: "Session is unavailable",
        });
      }
      expect(f.store.controllerLease(run)).toBeNull();
      const acknowledgedVersion = f.version();
      const acknowledgedEvents = f.store.events(run);
      const acknowledgedObservations = f.store.orchestration.observations(run);
      await operator.submit({
        kind: "abandon_conversation",
        controlVersion: version,
        transferId: transfer.transferId,
        reason: "Retry lost acknowledgement",
      });
      expect(f.version()).toBe(acknowledgedVersion);
      expect(f.store.events(run)).toEqual(acknowledgedEvents);
      expect(f.store.orchestration.observations(run)).toEqual(acknowledgedObservations);
      expect(operator.status().conversationTransfers).toContainEqual(
        expect.objectContaining({ transferId: transfer.transferId, status: "abandoned" }),
      );
      const store = f.reopen(),
        journal = store.orchestration;
      const abandoned = journal.agents.conversationTransfer(run, transfer.transferId);
      expect(abandoned).toMatchObject({
        status: "abandoned",
        targetAgentId: transferState === "claimed" ? target.agentId : null,
        abandonment: { reason: "Session is unavailable", stoppedTurnIds: [turn.identity.turnId] },
      });
      expect(journal.agents.instance(run, target).status).toBe("released");
      expect(journal.agents.pendingCoordinatorConversationTransfer(run, "herdr")).toBeNull();
      expect(journal.agents.openConversationTransfers(run)).toEqual([]);
      expect(journal.agents.turn(run, turn.identity)).toEqual(failed);
      const retryVersion = f.version();
      const allObservations = journal.observations(run);
      const allEvents = store.events(run);
      expect(
        allObservations.filter(
          (entry) => entry.kind === "agent.conversation_transfer_relinquished",
        ),
      ).toHaveLength(transferState === "pending" ? 1 : 0);
      const before = journal
        .observations(run)
        .filter((entry) => entry.kind === "operator.conversation_abandoned");
      journal.abandonConversationTransfer(
        f.authority,
        f.version(),
        transfer.transferId,
        "Retry after lost acknowledgement",
      );
      journal.abandonConversationTransfer(
        f.authority,
        version,
        transfer.transferId,
        "Retry with original version",
      );
      expect(f.version()).toBe(retryVersion);
      expect(journal.observations(run)).toEqual(allObservations);
      expect(store.events(run)).toEqual(allEvents);
      expect(
        journal
          .observations(run)
          .filter((entry) => entry.kind === "operator.conversation_abandoned"),
      ).toEqual(before);
      expect(journal.agents.conversationTransfer(run, transfer.transferId)).toEqual(abandoned);
      journal.handoffRuntime(f.authority, f.version(), {
        runtime: "sdk",
        executable: f.codex,
        herdr: null,
      });
      journal.operatorControl(run, f.version(), { kind: "resume" });
      // An abandoned ID cannot be claimed again, even with otherwise exact bindings.
      if (transferState === "claimed")
        expect(() =>
          journal.agents.reserveAgent(
            f.authority,
            {
              ...f.workspace,
              role: "orchestrator",
              purpose: "coordination",
              taskId: null,
              candidateId: null,
              instructions: "Invalid retry",
              confinementProfile: "epicd-isolated",
              contract: f.agent.contract,
              replaces: target,
              conversationTransferId: transfer.transferId,
            },
            f.version(),
          ),
        ).toThrow("Conversation transfer does not match");
      f.detach();
      copyFileSync("/bin/false", join(f.root, "codex-code-mode-host"));
      let freshSession: string | null = null;
      await new OrchestratorController(store, run, {
        dispatcher: () =>
          new ControlledAgentDispatcher(journal, {
            "codex:sdk": (j, execution) => ({
              backend: "codex",
              kind: "sdk",
              async run(authority, identity, signal) {
                const owner = j.agents.instance(run, identity);
                expect(owner.conversationContinuation).toBeNull();
                expect(owner.provider).toBeNull();
                const prompt = j.agents.turn(run, identity).prompt.instructions;
                const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
                freshSession = randomUUID();
                const decision = {
                  explanation: "Fresh test conversation",
                  evidenceIds: [],
                  request: {
                    schemaVersion: 1,
                    decisionId: input.ticket.decisionId,
                    observationCursor: input.ticket.observationCursor,
                    expectedControlVersion: input.ticket.expectedControlVersion,
                    action: {
                      kind: "escalate",
                      question: "Fresh conversation reached",
                      reason: "judgment",
                      evidenceIds: [],
                    },
                  },
                };
                const events = [
                  { type: "thread.started", thread_id: freshSession },
                  { type: "turn.started" },
                  {
                    type: "item.completed",
                    item: { type: "agent_message", id: "decision", text: JSON.stringify(decision) },
                  },
                  {
                    type: "turn.completed",
                    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
                  },
                ];
                writeFileSync(
                  f.codex,
                  "#!/bin/sh\ncat >/dev/null\n" +
                    events
                      .map(
                        (event) =>
                          "printf '%s\\n' '" + JSON.stringify(event).replaceAll("'", "'\\''") + "'",
                      )
                      .join("\n") +
                    "\n",
                  { mode: 0o700 },
                );
                return new ControlledSdkRuntime(j, {
                  root: execution.runtimeRoot,
                  executable: execution.executable,
                  turnTimeoutMs: execution.turnTimeoutMs,
                  launcherEntrypoint: join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
                }).run(authority, identity, signal);
              },
              reconcile: (authority, identity) =>
                new ControlledSdkRuntime(j, {
                  root: execution.runtimeRoot,
                  executable: execution.executable,
                  turnTimeoutMs: execution.turnTimeoutMs,
                  launcherEntrypoint: join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
                }).reconcile(authority, identity),
            }),
          }),
      }).run();
      expect(freshSession).not.toBeNull();
      expect(freshSession).not.toBe(sessionId);
      expect(
        journal.pendingEscalation(run)?.question,
        JSON.stringify(
          journal.observations(run).filter((entry) => entry.kind === "runtime.problem"),
        ),
      ).toBe("Fresh conversation reached");
      expect(journal.agents.conversationTransfer(run, transfer.transferId)).toEqual(abandoned);
    },
  );

  it.each(["pending", "claimed"] as const)(
    "abandons a %s transfer with an isolated unreadable source after restart",
    async (status) => {
      const f = await fixture(),
        run = f.state.runId;
      const { transfer, target } = retainedTarget(f);
      if (status === "pending") f.journal.agents.retireStoppedAgent(f.authority, target);
      f.pause();
      const source = f.journal.agents.instance(run, f.agent);
      const raw = JSON.stringify({ ...source, schemaVersion: 1 });
      f.db
        .prepare("UPDATE agent_instances SET record_json = ? WHERE agent_id = ? AND generation = ?")
        .run(raw, source.agentId, source.agentGeneration);
      f.detach();
      const store = f.reopen(),
        journal = store.orchestration;
      const completionResources = () =>
        (
          f.store.orchestration as unknown as {
            completionResources(runId: string, operationId: string): unknown;
          }
        ).completionResources(run, "no-operation");
      expect(() => completionResources()).toThrow("Completion cannot abandon");
      expect(journal.agents.ownershipAssessment(run, source).state).toBe("isolated");
      expect(runStatusView(store, run).conversationTransfers).toContainEqual(
        expect.objectContaining({ transferId: transfer.transferId, status }),
      );
      expect(() => journal.agents.conversationTransfer(run, transfer.transferId)).toThrow(
        "abandon-conversation",
      );
      expect(() =>
        journal.handoffRuntime(f.authority, f.version(), {
          runtime: "sdk",
          executable: f.codex,
          herdr: null,
        }),
      ).toThrow("explicitly abandon");
      if (status === "pending") {
        f.detach();
        journal.operatorControl(run, f.version(), { kind: "resume" });
        await expect(new OrchestratorController(store, run).run()).rejects.toThrow(
          "abandon-conversation",
        );
        expect(journal.pendingEscalation(run)?.question).toContain(transfer.transferId);
        f.reopen();
      }
      const current = f.store.orchestration;
      const abandoned = current.abandonConversationTransfer(
        f.authority,
        f.version(),
        transfer.transferId,
        "Isolated source cannot resume",
      );
      expect(abandoned.status).toBe("abandoned");
      expect(current.agents.hasOpenConversationTransfers(run)).toBe(false);
      expect(completionResources()).toMatchObject({ disposition: "retained_for_inspection" });
      expect(current.agents.instance(run, target).status).toBe("released");
      expect(() =>
        current.handoffRuntime(f.authority, f.version(), {
          runtime: "sdk",
          executable: f.codex,
          herdr: null,
        }),
      ).not.toThrow();
      expect(
        (
          f.db
            .prepare(
              "SELECT record_json FROM agent_instances WHERE agent_id = ? AND generation = ?",
            )
            .get(source.agentId, source.agentGeneration) as { record_json: string }
        ).record_json,
      ).toBe(raw);
    },
  );

  it("reports an unreadable exact transfer claimant through a stable recovery error", async () => {
    const f = await fixture();
    const { transfer, target } = retainedTarget(f);
    const damaged = JSON.stringify({ ...target, schemaVersion: 1 });
    f.db
      .prepare(
        "UPDATE agent_instances SET record_json = ? WHERE run_id = ? AND agent_id = ? AND generation = ?",
      )
      .run(damaged, f.state.runId, target.agentId, target.agentGeneration);
    f.pause();

    await expect(
      Promise.resolve().then(() =>
        f.journal.abandonConversationTransfer(
          f.authority,
          f.version(),
          transfer.transferId,
          "Unreadable claim target",
        ),
      ),
    ).rejects.toMatchObject({ code: "conversation_transfer_claimant_unreadable" });
  });

  it("does not abandon a transfer while its exact claimant still has uncontained work", async () => {
    const f = await fixture(),
      run = f.state.runId;
    const { transfer, target } = retainedTarget(f);
    const turn = f.journal.agents.prepareTurn(
      f.authority,
      target,
      randomUUID(),
      "Unsettled target",
      { type: "object" },
      f.version(),
    );
    f.pause();
    const source = f.journal.agents.instance(run, f.agent);
    f.db
      .prepare("UPDATE agent_instances SET record_json = ? WHERE agent_id = ? AND generation = ?")
      .run(JSON.stringify({ ...source, schemaVersion: 1 }), source.agentId, source.agentGeneration);
    expect(f.journal.agents.ownershipAssessment(run, source).state).toBe("isolated");
    const version = f.version(),
      observations = f.journal.observations(run);
    expect(() =>
      f.journal.abandonConversationTransfer(
        f.authority,
        version,
        transfer.transferId,
        "Unsafe abandonment",
      ),
    ).toThrow(/stop/i);
    expect(f.version()).toBe(version);
    expect(f.journal.observations(run)).toEqual(observations);
    expect(f.journal.agents.turn(run, turn.identity).stopEvidence).toBeNull();
    expect(f.journal.agents.hasOpenConversationTransfers(run)).toBe(true);
  });

  it("abandons a stopped transfer without depending on unrelated damaged turn history", async () => {
    const f = await fixture(),
      run = f.state.runId;
    const { transfer, target } = retainedTarget(f);
    const diagnostic = await new WorkspaceManager(
      f.journal,
      f.state.runtimeConfiguration!.workspaceRoot,
    ).create(f.authority, f.repo, f.state.epicBaseRevision, "diagnostic");
    const unrelated = f.journal.agents.reserveAgent(
      f.authority,
      {
        ...diagnostic,
        role: "implementation",
        purpose: "specialist",
        taskId: null,
        candidateId: null,
        instructions: "Unrelated historical diagnostic",
        confinementProfile: "epicd-isolated",
        contract: target.contract,
      },
      f.version(),
    );
    const stopped = f.journal.agents.cancelPreparedTurn(
      f.authority,
      f.journal.agents.prepareTurn(
        f.authority,
        unrelated,
        randomUUID(),
        "Stopped unrelated diagnostic",
        { type: "object" },
        f.version(),
      ).identity,
    );
    const damaged = structuredClone(stopped);
    damaged.prompt.instructions = "Changed without updating the retained prompt digest";
    f.db
      .prepare("UPDATE agent_turns SET record_json=? WHERE run_id=? AND turn_id=?")
      .run(JSON.stringify(damaged), run, stopped.identity.turnId);
    cleanup.push(() =>
      f.db
        .prepare("UPDATE agent_turns SET record_json=? WHERE run_id=? AND turn_id=?")
        .run(JSON.stringify(stopped), run, stopped.identity.turnId),
    );
    expect(f.journal.agents.ownershipAssessment(run, unrelated)).toMatchObject({
      state: "uncontained",
      incident: { ownerRecordReadable: true },
    });
    f.pause();

    expect(
      f.journal.abandonConversationTransfer(
        f.authority,
        f.version(),
        transfer.transferId,
        "Retained session is unused",
      ),
    ).toMatchObject({ status: "abandoned" });
    expect(f.journal.agents.instance(run, target).status).toBe("released");
    expect(f.journal.agents.ownershipAssessment(run, unrelated).state).toBe("uncontained");
  });

  it.each(["pending", "claimed"] as const)(
    "keeps %s transfer diagnostics readable while malformed rows still block handoff",
    async (transferStatus) => {
      const f = await fixture(),
        run = f.state.runId;
      const { transfer, target } = retainedTarget(f);
      if (transferStatus === "pending") f.journal.agents.retireStoppedAgent(f.authority, target);
      f.pause();
      const raw = JSON.stringify({
        ...f.journal.agents.conversationTransfer(run, transfer.transferId),
        schemaVersion: 999,
      });
      f.db
        .prepare("UPDATE agent_conversation_transfers SET record_json = ? WHERE transfer_id = ?")
        .run(raw, transfer.transferId);
      f.detach();
      const store = f.reopen();
      const status = runStatusView(store, run);
      expect(status.conversationTransfers).toContainEqual({
        transferId: transfer.transferId,
        status: transferStatus,
        targetRuntime: "herdr",
        unreadable: true,
        abandonment: null,
      });
      expect(humanRunStatus(status)).toContain("unreadable record");
      if (transferStatus === "pending")
        expect(() =>
          store.orchestration.agents.pendingCoordinatorConversationTransfer(run, "herdr"),
        ).toThrow("is unreadable");
      expect(() =>
        store.orchestration.handoffRuntime(f.authority, f.version(), {
          runtime: "sdk",
          executable: f.codex,
          herdr: null,
        }),
      ).toThrow("explicitly abandon");
      expect(() =>
        store.orchestration.abandonConversationTransfer(
          f.authority,
          f.version(),
          transfer.transferId,
          "Unknown record",
        ),
      ).toThrow("is unreadable");
      expect(
        (
          f.db
            .prepare("SELECT record_json FROM agent_conversation_transfers WHERE transfer_id = ?")
            .get(transfer.transferId) as { record_json: string }
        ).record_json,
      ).toBe(raw);
    },
  );

  it("rolls back claim retirement when recording the operator observation fails", async () => {
    const f = await fixture(),
      run = f.state.runId;
    const { target, transfer } = retainedTarget(f);
    f.pause();
    const version = f.version();
    const before = f.journal.agents.conversationTransfer(run, transfer.transferId);
    f.db.exec(`CREATE TRIGGER reject_abandonment BEFORE INSERT ON observations
      WHEN NEW.source_event_id LIKE 'conversation-abandoned-%'
      BEGIN SELECT RAISE(ABORT, 'Injected observation failure'); END`);
    expect(() =>
      f.journal.abandonConversationTransfer(
        f.authority,
        version,
        transfer.transferId,
        "Unavailable session",
      ),
    ).toThrow("Injected observation failure");
    expect(f.version()).toBe(version);
    expect(f.journal.agents.conversationTransfer(run, transfer.transferId)).toEqual(before);
    expect(f.journal.agents.instance(run, target).status).toBe("reserved");
    f.db.exec("DROP TRIGGER reject_abandonment");
    f.journal.abandonConversationTransfer(
      f.authority,
      version,
      transfer.transferId,
      "Unavailable session",
    );
    expect(f.journal.agents.conversationTransfer(run, transfer.transferId).status).toBe(
      "abandoned",
    );
    expect(f.journal.agents.instance(run, target).status).toBe("released");
  });

  it("refuses abandonment for uncertain or consumed targets without changing the reservation", async () => {
    const f = await fixture(),
      run = f.state.runId;
    const { target, transfer, sessionId } = retainedTarget(f);
    const turn = f.journal.agents.prepareTurn(
      f.authority,
      target,
      randomUUID(),
      "No stop proof",
      { type: "object" },
      f.version(),
    );
    f.pause();
    const before = f.journal.agents.conversationTransfer(run, transfer.transferId);
    expect(() =>
      f.journal.abandonConversationTransfer(
        f.authority,
        f.version(),
        transfer.transferId,
        "Unsafe",
      ),
    ).toThrow(/stop|busy/i);
    expect(f.journal.agents.conversationTransfer(run, transfer.transferId)).toEqual(before);
    expect(f.journal.agents.instance(run, target).status).toBe("busy");
    f.journal.agents.cancelPreparedTurn(f.authority, turn.identity);
    f.journal.operatorControl(run, f.version(), { kind: "resume" });
    f.journal.agents.bindProvider(f.authority, target, {
      backend: "codex",
      runtime: "herdr",
      name: "bound",
      paneId: "pane",
      tabId: "tab",
      terminalId: "terminal",
      sessionId,
    });
    f.pause();
    expect(() =>
      f.journal.abandonConversationTransfer(
        f.authority,
        f.version(),
        transfer.transferId,
        "Consumed",
      ),
    ).toThrow("Consumed conversation ownership");
    expect(f.journal.agents.conversationTransfer(run, transfer.transferId).status).toBe("consumed");
  });

  it("keeps a consumed continuation executable after its stopped source becomes isolated", async () => {
    const f = await fixture();
    const { target, transfer, sessionId } = retainedTarget(f);
    const provider = {
      backend: "codex" as const,
      runtime: "herdr" as const,
      name: "continued",
      paneId: "pane",
      tabId: "tab",
      terminalId: "terminal",
      sessionId,
    };
    f.journal.agents.bindProvider(f.authority, target, provider);
    const source = f.journal.agents.instance(f.state.runId, f.agent);
    const damaged = JSON.stringify({ ...source, schemaVersion: 1 });
    f.db
      .prepare(
        "UPDATE agent_instances SET record_json = ? WHERE run_id = ? AND agent_id = ? AND generation = ?",
      )
      .run(damaged, f.state.runId, source.agentId, source.agentGeneration);

    expect(f.journal.agents.ownershipAssessment(f.state.runId, source).state).toBe("isolated");
    expect(f.journal.agents.conversationTransfer(f.state.runId, transfer.transferId).status).toBe(
      "consumed",
    );
    expect(() => f.journal.agents.bindProvider(f.authority, target, provider)).not.toThrow();
    const turn = f.journal.agents.prepareTurn(
      f.authority,
      target,
      randomUUID(),
      "Continue despite isolated historical damage",
      { type: "object" },
      f.version(),
    );
    const launches = new ControlledLaunches({
      root: target.execution.runtimeRoot,
      executable: target.execution.executable,
    });
    expect(() => launches.reserve(f.journal, f.authority, turn.identity)).not.toThrow();
    expect(
      f.db
        .prepare(
          "SELECT conversation_transfer_id FROM agent_instances WHERE run_id = ? AND agent_id = ? AND generation = ?",
        )
        .get(f.state.runId, target.agentId, target.agentGeneration),
    ).toEqual({ conversation_transfer_id: transfer.transferId });
  });

  it("reuses the coordinator workspace past an isolated transferred ancestor", async () => {
    const f = await fixture();
    const sessionId = randomUUID();
    f.journal.agents.bindProvider(f.authority, f.agent, {
      backend: "codex",
      runtime: "sdk",
      sessionId,
    });
    f.pause();
    f.journal.handoffRuntime(f.authority, f.version(), f.target, true);
    const transfer = f.journal.agents.pendingCoordinatorConversationTransfer(
      f.state.runId,
      "herdr",
    )!;
    f.journal.operatorControl(f.state.runId, f.version(), { kind: "resume" });
    const settings = { model: "gpt-6-astra", reasoningEffort: "high" as const };
    const successor = f.journal.agents.reserveAgent(
      f.authority,
      {
        ...f.workspace,
        role: "orchestrator",
        purpose: "coordination",
        taskId: null,
        candidateId: null,
        instructions: "Continue the retained conversation",
        contract: HerdrAgentSessionContractSchema.parse({
          backend: "codex",
          runtime: "herdr",
          requested: settings,
          effective: settings,
        }),
        confinementProfile: "epicd-isolated",
        replaces: f.agent,
        conversationTransferId: transfer.transferId,
      },
      f.version(),
    );
    f.journal.agents.bindProvider(f.authority, successor, {
      backend: "codex",
      runtime: "herdr",
      name: "continued",
      paneId: "pane",
      tabId: "tab",
      terminalId: "terminal",
      sessionId,
    });

    const row = f.db
      .prepare(
        "SELECT record_json FROM agent_instances WHERE run_id = ? AND agent_id = ? AND generation = ?",
      )
      .get(f.state.runId, f.agent.agentId, f.agent.agentGeneration) as {
      record_json: string;
    };
    const damaged = JSON.parse(row.record_json);
    damaged.schemaVersion = 1;
    f.db
      .prepare(
        "UPDATE agent_instances SET record_json = ? WHERE run_id = ? AND agent_id = ? AND generation = ?",
      )
      .run(JSON.stringify(damaged), f.state.runId, f.agent.agentId, f.agent.agentGeneration);
    expect(f.journal.agents.ownershipAssessment(f.state.runId, f.agent).state).toBe("isolated");

    f.pause();
    f.journal.handoffRuntime(
      f.authority,
      f.version(),
      { runtime: "sdk", executable: f.codex, herdr: null },
      true,
    );
    const backTransfer = f.journal.agents.pendingCoordinatorConversationTransfer(
      f.state.runId,
      "sdk",
    )!;
    f.journal.operatorControl(f.state.runId, f.version(), { kind: "resume" });
    expect(() =>
      f.journal.agents.reserveAgent(
        f.authority,
        {
          ...f.workspace,
          role: "orchestrator",
          purpose: "coordination",
          taskId: null,
          candidateId: null,
          instructions: "Continue past the isolated historical owner",
          contract: SdkAgentSessionContractSchema.parse({
            backend: "codex",
            runtime: "sdk",
            requested: settings,
            effective: settings,
          }),
          confinementProfile: "epicd-isolated",
          replaces: successor,
          conversationTransferId: backTransfer.transferId,
        },
        f.version(),
      ),
    ).not.toThrow();
  });

  it.each([false, true])(
    "transfers one stopped coordinator session across runtimes (failed prior claim: %s)",
    async (failedClaim) => {
      const f = await fixture();
      const sessionId = randomUUID();
      f.journal.agents.bindProvider(f.authority, f.agent, {
        backend: "codex",
        runtime: "sdk",
        sessionId,
      });
      const launches = new ControlledLaunches({
        root: f.state.runtimeConfiguration!.runtimeRoot,
        executable: f.codex,
        launcherEntrypoint: join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
      });
      const sourceTurn = f.journal.agents.prepareTurn(
        f.authority,
        f.agent,
        randomUUID(),
        "Record a stopped source conversation",
        { type: "object" },
        f.version(),
      );
      const sourceLaunch = launches.reserve(f.journal, f.authority, sourceTurn.identity).manifest;
      await launches.materialize(sourceLaunch, null);
      f.journal.agents.acknowledgePrompt(
        f.authority,
        sourceTurn.identity,
        sourceTurn.promptDigest,
        "Fixture accepted source turn",
      );
      const sourceStop = {
        generation: sourceLaunch.generation,
        stoppedAt: new Date().toISOString(),
        kind: "stopped" as const,
        code: 0,
        signal: null,
        interrupted: false,
        processTreeStopped: true as const,
      };
      f.journal.agents.recordLaunchStop(f.authority, sourceTurn.identity, sourceStop);
      f.journal.agents.finishTurn(f.authority, sourceTurn.identity, {
        status: "completed",
        result: { kind: "decision" },
        stopEvidence: JSON.stringify(sourceStop),
      });
      f.pause();
      f.journal.handoffRuntime(f.authority, f.version(), f.target, true);
      expect(f.journal.agents.instance(f.state.runId, f.agent).status).toBe("released");
      const transfer = f.journal.agents.pendingCoordinatorConversationTransfer(
        f.state.runId,
        "herdr",
      );
      expect(transfer).toMatchObject({
        sourceAgentId: f.agent.agentId,
        sourceAgentGeneration: f.agent.agentGeneration,
        sessionId,
        status: "pending",
      });
      expect(() =>
        f.journal.handoffRuntime(f.authority, f.version(), {
          runtime: "sdk",
          executable: f.codex,
          herdr: null,
        }),
      ).toThrow("claim the reserved coordinator conversation");

      f.journal.operatorControl(f.state.runId, f.version(), { kind: "resume" });
      const settings = { model: "gpt-6-astra", reasoningEffort: "high" as const };
      let predecessor = f.agent;
      if (failedClaim) {
        predecessor = f.journal.agents.reserveAgent(
          f.authority,
          {
            ...f.workspace,
            role: "orchestrator",
            purpose: "coordination",
            taskId: null,
            candidateId: null,
            instructions: "Claim whose launch fails before provider binding",
            contract: HerdrAgentSessionContractSchema.parse({
              backend: "codex",
              runtime: "herdr",
              requested: settings,
              effective: settings,
            }),
            confinementProfile: "epicd-isolated",
            replaces: f.agent,
            conversationTransferId: transfer!.transferId,
          },
          f.version(),
        );
        const failedTurn = f.journal.agents.prepareTurn(
          f.authority,
          predecessor,
          randomUUID(),
          "Failed claim",
          { type: "object" },
          f.version(),
        );
        const failedLaunch = launches.reserve(f.journal, f.authority, failedTurn.identity).manifest;
        f.journal.agents.recordLaunchStop(f.authority, failedTurn.identity, {
          generation: failedLaunch.generation,
          stoppedAt: new Date().toISOString(),
          kind: "stopped",
          code: 1,
          signal: null,
          interrupted: true,
          processTreeStopped: true,
        });
        f.journal.agents.finishTurn(f.authority, failedTurn.identity, {
          status: "failed",
          result: null,
          stopEvidence: "Failed launch stopped before provider binding",
        });
        f.journal.agents.retireStoppedAgent(f.authority, predecessor);
      }
      const replacement = f.journal.agents.reserveAgent(
        f.authority,
        {
          ...f.workspace,
          role: "orchestrator",
          purpose: "coordination",
          taskId: null,
          candidateId: null,
          instructions: "Continue after explicit handoff",
          contract: HerdrAgentSessionContractSchema.parse({
            backend: "codex",
            runtime: "herdr",
            requested: settings,
            effective: settings,
          }),
          confinementProfile: "epicd-isolated",
          replaces: predecessor,
          conversationTransferId: transfer!.transferId,
        },
        f.version(),
      );
      expect(replacement).toMatchObject({
        agentId: f.agent.agentId,
        agentGeneration: predecessor.agentGeneration + 1,
        conversationContinuation: { sessionId, transferId: transfer!.transferId },
        provider: null,
      });
      expect(
        f.journal.agents.conversationTransfer(f.state.runId, transfer!.transferId).status,
      ).toBe("claimed");
      expect(() =>
        f.journal.agents.bindProvider(f.authority, replacement, {
          backend: "codex",
          runtime: "herdr",
          name: "continued",
          paneId: "pane",
          tabId: "tab",
          terminalId: "terminal",
          sessionId: "wrong-session",
        }),
      ).toThrow("exact stopped Codex session");
      f.journal.agents.bindProvider(f.authority, replacement, {
        backend: "codex",
        runtime: "herdr",
        name: "continued",
        paneId: "pane",
        tabId: "tab",
        terminalId: "terminal",
        sessionId,
      });
      expect(
        f.journal.agents.conversationTransfer(f.state.runId, transfer!.transferId).status,
      ).toBe("consumed");
      expect(
        f.journal.agents.pendingCoordinatorConversationTransfer(f.state.runId, "herdr"),
      ).toBeNull();
      const continuedTurn = f.journal.agents.prepareTurn(
        f.authority,
        replacement,
        randomUUID(),
        "Continue after runtime handoff",
        { type: "object" },
        f.version(),
      );
      const continuedLaunch = launches.reserve(
        f.journal,
        f.authority,
        continuedTurn.identity,
      ).manifest;
      await launches.materialize(continuedLaunch, null);
      expect(continuedLaunch.confinement).toMatchObject({
        providerHome: transfer!.providerHome,
        workspace: f.workspace.path,
      });
      expect(readFileSync(join(continuedLaunch.controlDirectory, "config.toml"), "utf8")).toBe(
        codexConfinementConfig(continuedLaunch.confinement),
      );
      expect(readFileSync(join(transfer!.providerHome, "config.toml"), "utf8")).toBe(
        codexConfinementConfig(sourceLaunch.confinement),
      );
      expect(continuedLaunch.confinement.scratch).not.toBe(sourceLaunch.confinement.scratch);
      const native = {
        sessionName: "fixture",
        socketPath: "/fixture/socket",
        socketIdentity: "fixture-server-incarnation",
        workspaceId: "w-test",
        tabId: "continued-tab",
        paneId: "continued-pane",
        terminalId: "continued-terminal",
        name: "continued",
      };
      f.journal.agents.bindNativeLaunch(f.authority, continuedTurn.identity, native);
      f.journal.agents.acknowledgePrompt(
        f.authority,
        continuedTurn.identity,
        continuedTurn.promptDigest,
        "Continued native prompt accepted",
      );
      expect(() =>
        f.journal.agents.bindTurnProvider(f.authority, continuedTurn.identity, {
          backend: "codex",
          runtime: "herdr",
          name: native.name,
          paneId: native.paneId,
          tabId: native.tabId,
          terminalId: native.terminalId,
          sessionId,
        }),
      ).not.toThrow();
      const continuedStop = {
        generation: continuedLaunch.generation,
        stoppedAt: new Date().toISOString(),
        kind: "stopped" as const,
        code: 0,
        signal: null,
        interrupted: false,
        processTreeStopped: true as const,
      };
      f.journal.agents.recordLaunchStop(f.authority, continuedTurn.identity, continuedStop);
      f.journal.agents.finishTurn(f.authority, continuedTurn.identity, {
        status: "completed",
        result: { kind: "continued" },
        stopEvidence: JSON.stringify(continuedStop),
      });

      f.pause();
      f.journal.handoffRuntime(
        f.authority,
        f.version(),
        { runtime: "sdk", executable: f.codex, herdr: null },
        true,
      );
      const backTransfer = f.journal.agents.pendingCoordinatorConversationTransfer(
        f.state.runId,
        "sdk",
      )!;
      f.journal.operatorControl(f.state.runId, f.version(), { kind: "resume" });
      const resumed = f.journal.agents.reserveAgent(
        f.authority,
        {
          ...f.workspace,
          role: "orchestrator",
          purpose: "coordination",
          taskId: null,
          candidateId: null,
          instructions: "Continue the validated transfer lineage",
          contract: SdkAgentSessionContractSchema.parse({
            backend: "codex",
            runtime: "sdk",
            requested: settings,
            effective: settings,
          }),
          confinementProfile: "epicd-isolated",
          replaces: replacement,
          conversationTransferId: backTransfer.transferId,
        },
        f.version(),
      );
      expect(() =>
        f.journal.agents.bindProvider(f.authority, resumed, {
          backend: "codex",
          runtime: "sdk",
          sessionId,
        }),
      ).not.toThrow();
      const resumedTurn = f.journal.agents.prepareTurn(
        f.authority,
        resumed,
        randomUUID(),
        "Exercise the third generation's launch storage",
        { type: "object" },
        f.version(),
      );
      expect(() => launches.reserve(f.journal, f.authority, resumedTurn.identity)).not.toThrow();
    },
  );

  it("releases a stopped unbound claim for a later retained replacement generation", async () => {
    const f = await fixture();
    const sessionId = randomUUID();
    f.journal.agents.bindProvider(f.authority, f.agent, {
      backend: "codex",
      runtime: "sdk",
      sessionId,
    });
    f.pause();
    f.journal.handoffRuntime(f.authority, f.version(), f.target, true);
    const transfer = f.journal.agents.pendingCoordinatorConversationTransfer(
      f.state.runId,
      "herdr",
    )!;
    f.journal.operatorControl(f.state.runId, f.version(), { kind: "resume" });
    const settings = { model: "gpt-6-astra", reasoningEffort: "high" as const };
    const contract = HerdrAgentSessionContractSchema.parse({
      backend: "codex",
      runtime: "herdr",
      requested: settings,
      effective: settings,
    });
    const firstTarget = f.journal.agents.reserveAgent(
      f.authority,
      {
        ...f.workspace,
        role: "orchestrator",
        purpose: "coordination",
        taskId: null,
        candidateId: null,
        instructions: "First stopped claim attempt",
        contract,
        confinementProfile: "epicd-isolated",
        replaces: f.agent,
        conversationTransferId: transfer.transferId,
      },
      f.version(),
    );
    f.journal.agents.retireStoppedAgent(
      f.authority,
      firstTarget,
      "Provider identity was never acquired",
    );
    expect(f.journal.agents.conversationTransfer(f.state.runId, transfer.transferId)).toMatchObject(
      {
        status: "pending",
        targetAgentId: null,
        targetAgentGeneration: null,
        claimedAt: null,
      },
    );
    const retry = f.journal.agents.reserveAgent(
      f.authority,
      {
        ...f.workspace,
        role: "orchestrator",
        purpose: "coordination",
        taskId: null,
        candidateId: null,
        instructions: "Retry the same retained claim",
        contract,
        confinementProfile: "epicd-isolated",
        replaces: firstTarget,
        conversationTransferId: transfer.transferId,
      },
      f.version(),
    );
    expect(retry).toMatchObject({
      agentId: f.agent.agentId,
      agentGeneration: f.agent.agentGeneration + 2,
      conversationContinuation: { transferId: transfer.transferId },
    });
  });

  it.each(["providerHome", "workspaceId", "workspaceGeneration"] as const)(
    "rejects a schema-valid transfer whose derived %s binding changed",
    async (field) => {
      const f = await fixture();
      f.journal.agents.bindProvider(f.authority, f.agent, {
        backend: "codex",
        runtime: "sdk",
        sessionId: randomUUID(),
      });
      f.pause();
      f.journal.handoffRuntime(f.authority, f.version(), f.target, true);
      const transfer = f.journal.agents.pendingCoordinatorConversationTransfer(
        f.state.runId,
        "herdr",
      )!;
      const changed = structuredClone(transfer);
      if (field === "providerHome") changed.providerHome = join(f.root, "redirected-provider");
      else if (field === "workspaceId") changed.workspaceId = randomUUID();
      else changed.workspaceGeneration += 1;
      f.db
        .prepare("UPDATE agent_conversation_transfers SET record_json = ? WHERE transfer_id = ?")
        .run(JSON.stringify(changed), transfer.transferId);
      expect(() =>
        f.journal.agents.conversationTransfer(f.state.runId, transfer.transferId),
      ).toThrow("derived transfer binding changed");
    },
  );

  it("rejects a schema-valid target continuation that no longer matches its claimed transfer", async () => {
    const f = await fixture();
    const sessionId = randomUUID();
    f.journal.agents.bindProvider(f.authority, f.agent, {
      backend: "codex",
      runtime: "sdk",
      sessionId,
    });
    f.pause();
    f.journal.handoffRuntime(f.authority, f.version(), f.target, true);
    const transfer = f.journal.agents.pendingCoordinatorConversationTransfer(
      f.state.runId,
      "herdr",
    )!;
    f.journal.operatorControl(f.state.runId, f.version(), { kind: "resume" });
    const settings = { model: "gpt-6-astra", reasoningEffort: "high" as const };
    const target = f.journal.agents.reserveAgent(
      f.authority,
      {
        ...f.workspace,
        role: "orchestrator",
        purpose: "coordination",
        taskId: null,
        candidateId: null,
        instructions: "Reject corrupted continuation metadata",
        contract: HerdrAgentSessionContractSchema.parse({
          backend: "codex",
          runtime: "herdr",
          requested: settings,
          effective: settings,
        }),
        confinementProfile: "epicd-isolated",
        replaces: f.agent,
        conversationTransferId: transfer.transferId,
      },
      f.version(),
    );
    const changed = structuredClone(target);
    changed.conversationContinuation!.providerHome = join(f.root, "redirected-provider");
    f.db
      .prepare(
        "UPDATE agent_instances SET record_json = ? WHERE run_id = ? AND agent_id = ? AND generation = ?",
      )
      .run(JSON.stringify(changed), f.state.runId, target.agentId, target.agentGeneration);
    expect(() =>
      f.journal.agents.bindProvider(f.authority, target, {
        backend: "codex",
        runtime: "herdr",
        name: "continued",
        paneId: "pane",
        tabId: "tab",
        terminalId: "terminal",
        sessionId,
      }),
    ).toThrow("exact durable transfer");
  });

  it("uses the operator-console boundary for stopped native handoff without starting or answering work", async () => {
    const f = await fixture(),
      run = f.state.runId;
    const escalationId = f.journal.setEscalation(
      f.authority,
      "Need operator judgment",
      "judgment",
      [],
    );
    f.detach();
    vi.stubEnv("HERDR_ENV", "1");
    const before = f.store.get(run)!;
    const operator = new RunOperator(f.store, run);
    await expect(
      operator.submit({
        kind: "handoff",
        runtime: "herdr",
        controlVersion: f.version(),
        codexPath: f.codex,
        herdrPath: f.herdr,
      }),
    ).resolves.toContain("No model started");
    expect(f.store.get(run)!.runtime).toBe("herdr");
    expect(f.store.get(run)!.agentSettings).toEqual(before.agentSettings);
    expect(f.journal.pendingEscalation(run)?.escalationId).toBe(escalationId);
    expect(f.journal.agents.turns(run)).toEqual([]);
    expect(f.store.controllerLease(run)).toBeNull();
    expect(readFileSync(f.commands, "utf8").trim().split("\n")).toEqual([
      "status server",
      "session list --json",
      "pane current --current",
    ]);
  });

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
    const provider = {
      backend: "codex" as const,
      runtime: "sdk" as const,
      sessionId: randomUUID(),
    };
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
    const settings = { model: "gpt-6-astra", reasoningEffort: "high" as const };
    const freshReplacement = f.journal.agents.reserveAgent(
      f.authority,
      {
        ...f.workspace,
        role: "orchestrator",
        purpose: "coordination",
        taskId: null,
        candidateId: null,
        instructions: "Start fresh after the default handoff",
        contract: HerdrAgentSessionContractSchema.parse({
          backend: "codex",
          runtime: "herdr",
          requested: settings,
          effective: settings,
        }),
        confinementProfile: "epicd-isolated",
        replaces: f.agent,
      },
      f.version(),
    );
    expect(freshReplacement.conversationContinuation).toBeNull();
    expect(() =>
      f.journal.agents.bindProvider(f.authority, freshReplacement, {
        backend: "codex",
        runtime: "herdr",
        name: "fresh",
        paneId: "pane",
        tabId: "tab",
        terminalId: "terminal",
        sessionId: provider.sessionId,
      }),
    ).toThrow("explicit runtime handoff");
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
    vi.spyOn(codexSettings, "verifyCodexExecutableEffect").mockReturnValue(
      Effect.sync(() => {
        f.pause();
        return "fixture";
      }),
    );
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

  it("releases the controller lease when a handoff Effect is interrupted", async () => {
    const f = await fixture();
    f.pause();
    f.detach();
    const verify = vi
      .spyOn(codexSettings, "verifyCodexExecutableEffect")
      .mockReturnValue(Effect.never);
    const fiber = Effect.runFork(
      handoffRuntimeEffect(f.store, f.state.runId, {
        runtime: "sdk",
        controlVersion: f.version(),
        codexPath: f.codex,
      }),
    );
    await expect.poll(() => verify).toHaveBeenCalledOnce();
    expect(f.store.controllerLease(f.state.runId)).not.toBeNull();
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
    expect(f.store.get(f.state.runId)).toEqual(f.state);
  });

  it("retains a typed handoff stage and cause while releasing its lease", async () => {
    const f = await fixture(),
      cause = new Error("version preflight failed");
    f.pause();
    f.detach();
    vi.spyOn(codexSettings, "verifyCodexExecutableEffect").mockReturnValue(
      Effect.fail(new codexSettings.CodexExecutableVerificationFailed({ cause })),
    );
    const result = await Effect.runPromise(
      Effect.result(
        handoffRuntimeEffect(f.store, f.state.runId, {
          runtime: "sdk",
          controlVersion: f.version(),
          codexPath: f.codex,
        }),
      ),
    );
    if (!Result.isFailure(result)) throw new Error("Expected handoff failure");
    expect(result.failure).toMatchObject({
      _tag: "RuntimeHandoffFailed",
      stage: "verify_runtime",
      cause,
    });
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
    expect(f.store.get(f.state.runId)).toEqual(f.state);
  });

  it("reports a lease-release failure over an earlier handoff failure", async () => {
    const f = await fixture(),
      handoffCause = new Error("version preflight failed"),
      releaseCause = new Error("lease release failed");
    f.pause();
    f.detach();
    vi.spyOn(codexSettings, "verifyCodexExecutableEffect").mockReturnValue(
      Effect.fail(new codexSettings.CodexExecutableVerificationFailed({ cause: handoffCause })),
    );
    let heldOwnerToken: string | undefined;
    const release = vi
      .spyOn(f.store, "releaseLease")
      .mockImplementationOnce((_runId, ownerToken) => {
        heldOwnerToken = ownerToken;
        throw releaseCause;
      });
    const result = await Effect.runPromise(
      Effect.result(
        handoffRuntimeEffect(f.store, f.state.runId, {
          runtime: "sdk",
          controlVersion: f.version(),
          codexPath: f.codex,
        }),
      ),
    );
    if (!Result.isFailure(result)) throw new Error("Expected handoff failure");
    expect(result.failure).toMatchObject({
      _tag: "RuntimeHandoffFailed",
      stage: "release_lease",
      cause: releaseCause,
    });
    expect(f.store.controllerLease(f.state.runId)).not.toBeNull();
    release.mockRestore();
    f.store.releaseLease(f.state.runId, heldOwnerToken!);
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

it("retains v4 account bindings across a durable SDK/native runtime round trip", async () => {
  const f = await fixture();
  const before = f.state.runtimeConfiguration!.accounts!;
  const binding = f.agent.accountBinding;
  expect(binding).toBeDefined();
  f.pause();
  f.journal.handoffRuntime(f.authority, f.version(), f.target);
  expect(f.store.get(f.state.runId)!.runtimeConfiguration!.accounts).toEqual(before);
  f.detach();
  f.reopen();
  expect(f.store.orchestration.agents.instance(f.state.runId, f.agent).accountBinding).toEqual(
    binding,
  );
  f.store.orchestration.handoffRuntime(f.authority, f.version(), {
    runtime: "sdk",
    executable: f.codex,
    herdr: null,
  });
  expect(f.store.get(f.state.runId)).toMatchObject({
    stateSchemaVersion: 4,
    runtime: "sdk",
    runtimeConfiguration: { accounts: before },
  });
});

it("rejects a handoff executable inside a frozen account home before changing runtime", async () => {
  const f = await fixture();
  f.pause();
  const version = f.version();
  const before = f.store.get(f.state.runId);
  const executable = join(f.state.runtimeConfiguration!.accounts.sources[0]!.codexHome, "codex");
  writeFileSync(executable, "#!/bin/sh\nexit 93\n", { mode: 0o700 });
  f.detach();
  await expect(
    handoffRuntime(f.store, f.state.runId, {
      runtime: "sdk",
      controlVersion: version,
      codexPath: executable,
    }),
  ).rejects.toThrow(/outside repository, state/);
  expect(f.store.get(f.state.runId)).toEqual(before);
  expect(f.store.controllerLease(f.state.runId)).toBeNull();
});
