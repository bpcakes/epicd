import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../dist/adapters/store.js";
import { ControlledSdkRuntime } from "../dist/adapters/controlled-sdk.js";
import { OrchestratorController, controlledDriver } from "../dist/controller.js";
import { ActionKernel } from "../dist/kernel/actions.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import type {
  ControllerAuthority,
  KernelAction,
  TurnIdentity,
} from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const emit = (value: unknown) => "printf '%s\\n' " + quote(JSON.stringify(value));
const question: KernelAction = {
  kind: "escalate",
  question: "This bounded test is finished; no epic delivery is claimed.",
  reason: "judgment",
  evidenceIds: [],
};
function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-controller-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "app.txt"), "unchanged\n");
  git("add", "app.txt");
  git("commit", "-qm", "baseline");
  const path = join(root, "state.sqlite3"),
    store = new StateStore(path);
  cleanup.push(() => store.close());
  mkdirSync(join(root, "bin"));
  const executable = join(root, "bin", "codex");
  copyFileSync("/bin/false", join(root, "bin", "codex-code-mode-host"));
  const state = store.create(
    {
      ...initialRun(),
      repoPath: source,
      epicBaseRevision: git("rev-parse", "HEAD"),
      runtimeConfiguration: {
        commonDirectory: {
          path: join(source, ".git"),
          device: String(statSync(join(source, ".git"), { bigint: true }).dev),
          inode: String(statSync(join(source, ".git"), { bigint: true }).ino),
        },
        executable,
        trackerExecutable: "/usr/bin/false",
        runtimeRoot: join(root, "runtime"),
        workspaceRoot: join(root, "workspaces"),
        authCachePath: null,
        turnTimeoutMs: 15_000,
        herdr: null,
      },
    },
    RepositoryPolicySchema.parse({ schemaVersion: 1 }),
  );
  const providerIds = new Map<string, string>();
  const observed: {
    ticket: Record<string, unknown>;
    context: { objective: unknown; capabilities: { kind: string; available: boolean }[] };
  }[] = [];
  function driverFactory(actions: KernelAction[], hang = false) {
    return (selectedStore: StateStore) => {
      const journal = selectedStore.orchestration;
      const driver = controlledDriver(selectedStore, state);
      expect(driver).toBeInstanceOf(ControlledSdkRuntime);
      return {
        kind: "sdk" as const,
        async run(authority: ControllerAuthority, identity: TurnIdentity, signal?: AbortSignal) {
          const key = `${identity.agentId}/${identity.agentGeneration}`;
          const providerId = providerIds.get(key) ?? randomUUID();
          providerIds.set(key, providerId);
          const prompt = journal.agents.turn(authority.runId, identity).prompt.instructions;
          const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
          observed.push(input);
          const action = actions.shift() ?? question;
          const decision = {
            explanation: "Scripted next action for bootstrap integration, not model reasoning",
            evidenceIds: [],
            request: {
              schemaVersion: 1,
              decisionId: input.ticket.decisionId,
              observationCursor: input.ticket.observationCursor,
              expectedControlVersion: input.ticket.expectedControlVersion,
              action,
            },
          };
          writeFileSync(
            executable,
            [
              "#!/bin/sh",
              "cat >/dev/null",
              emit({ type: "thread.started", thread_id: providerId }),
              emit({ type: "turn.started" }),
              ...(hang ? ["sleep 30"] : []),
              emit({
                type: "item.completed",
                item: { type: "agent_message", id: "decision", text: JSON.stringify(decision) },
              }),
              emit({
                type: "turn.completed",
                usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
              }),
              "",
            ].join("\n"),
            { mode: 0o700 },
          );
          return driver.run(authority, identity, signal);
        },
        reconcile: driver.reconcile.bind(driver),
      };
    };
  }
  return { root, source, path, store, state, git, observed, driverFactory };
}

// Real SQLite, private Git copies, SDK event parsing and supervised process stop.
// Decision content is scripted; green does not establish Astra's delivery competence.
describe.runIf(process.platform === "linux")("single orchestrator controller bootstrap", () => {
  it("invokes registered capabilities from coordinator decisions without a lifecycle dispatcher", async () => {
    const f = fixture();
    const baseline = f.git("rev-parse", "HEAD");
    const controller = new OrchestratorController(f.store, f.state.runId, {
      driver: f.driverFactory([{ kind: "inspect_run" }, question]),
    });
    const status = await controller.run();
    expect(status.control.status).toBe("awaiting_user");
    expect(status.escalation?.question).toBe(question.question);
    expect(f.observed[0]?.context.objective).toMatchObject({
      epicId: f.state.epicId,
      baselineRevision: baseline,
    });
    for (const kind of [
      "start_agent",
      "create_diagnostic_workspace",
      "inspect_fixture",
      "provision_declared_fixture",
      "reconcile_fixture_creation",
      "run_validation",
      "run_review",
      "request_commit",
      "request_publish",
      "request_beads_transition",
      "complete_run",
    ])
      expect(f.observed[0]?.context.capabilities).toContainEqual(
        expect.objectContaining({ kind, available: true }),
      );
    expect(
      f.store.orchestration.actions(f.state.runId).map((action) => action.request.action.kind),
    ).toEqual(["inspect_run", "escalate"]);
    const agents = f.store.orchestration.agents.instances(f.state.runId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.contract.effective).toEqual({
      model: "gpt-6-astra",
      reasoningEffort: "high",
    });
    const turns = f.store.orchestration.agents.turns(f.state.runId);
    expect(turns).toHaveLength(2);
    expect(
      turns.every((turn) => turn.launch?.stop?.processTreeStopped && turn.status === "completed"),
    ).toBe(true);
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
    expect(f.git("rev-parse", "HEAD")).toBe(baseline);
    expect(f.git("status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.source, "app.txt"), "utf8")).toBe("unchanged\n");
  });
  it("reopens the same coordinator conversation after a correlated operator response", async () => {
    const f = fixture();
    await new OrchestratorController(f.store, f.state.runId, {
      driver: f.driverFactory([question]),
    }).run();
    const first = f.store.orchestration.agents.instances(f.state.runId)[0]!;
    const escalation = f.store.orchestration.pendingEscalation(f.state.runId)!;
    const second = new StateStore(f.path);
    cleanup.push(() => second.close());
    second.orchestration.operatorControl(
      f.state.runId,
      second.orchestration.control(f.state.runId).controlVersion,
      {
        kind: "respond",
        escalationId: escalation.escalationId,
        message: "Perform one more bounded inspection",
      },
    );
    await new OrchestratorController(second, f.state.runId, {
      driver: f.driverFactory([{ kind: "inspect_run" }, question]),
    }).run();
    const agents = second.orchestration.agents.instances(f.state.runId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.agentId).toBe(first.agentId);
    expect(agents[0]?.provider).toEqual(first.provider);
    expect(second.orchestration.agents.turns(f.state.runId)).toHaveLength(3);
    expect(second.controllerLease(f.state.runId)).toBeNull();
  });
  it.each([
    {
      kind: "provision_declared_fixture",
      fixtureId: "never-reserved",
      operation: "create",
      expectedGeneration: 0,
    },
    { kind: "reconcile_fixture_creation", creationId: "lost-read" },
  ] satisfies KernelAction[])(
    "settles an interrupted $kind without an authorized external mutation",
    async (action) => {
      const f = fixture(),
        journal = f.store.orchestration;
      const lease = f.store.acquireLease(f.state.runId);
      const authority = {
        runId: f.state.runId,
        ownerToken: lease.ownerToken,
        leaseId: lease.leaseId,
      };
      const kernel = new ActionKernel(journal);
      kernel.registerExternal(action.kind, async () => {
        throw new Error("Lost result before any fixture intent or provider I/O");
      });
      const ticket = journal.beginDecision(
        authority,
        journal.latestObservationCursor(f.state.runId),
        journal.control(f.state.runId).controlVersion,
      );
      const pending = await kernel.execute(
        {
          explanation: "Inject a pre-I/O interruption",
          evidenceIds: [],
          request: {
            schemaVersion: 1,
            decisionId: ticket.decisionId,
            observationCursor: ticket.observationCursor,
            expectedControlVersion: ticket.expectedControlVersion,
            action,
          },
        },
        authority,
      );
      const result =
        pending.status === "running" ? await kernel.operation(pending.operationId) : pending;
      expect(result?.status).toBe("indeterminate");
      f.store.releaseLease(f.state.runId, authority.ownerToken);
      await new OrchestratorController(f.store, f.state.runId, {
        driver: f.driverFactory([question]),
      }).run();
      expect(journal.action(f.state.runId, pending.actionId)?.status).toBe("failed");
      expect(journal.fixtures.creations(f.state.runId)).toEqual([]);
    },
  );
  it("pauses a live coordinator and waits for its supervised stop before releasing ownership", async () => {
    const f = fixture();
    const controller = new OrchestratorController(f.store, f.state.runId, {
      driver: f.driverFactory([question], true),
    });
    const pending = controller.run();
    await expect
      .poll(
        () =>
          f.store.orchestration.agents
            .turns(f.state.runId)
            .some((turn) => turn.status === "running"),
        { timeout: 5000 },
      )
      .toBe(true);
    controller.pause();
    const result = await pending;
    expect(result.control.status).toBe("paused");
    const turns = f.store.orchestration.agents.turns(f.state.runId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      status: "cancelled",
      resultEligible: false,
      launch: { stop: { processTreeStopped: true } },
    });
    expect(f.store.orchestration.actions(f.state.runId)).toEqual([]);
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
  });
  it("changes coordinator effort through a journaled capability and cold-starts a new conversation without operator restart", async () => {
    const f = fixture();
    await new OrchestratorController(f.store, f.state.runId, {
      driver: f.driverFactory([
        {
          kind: "record_memory",
          entry: {
            kind: "strategy",
            content: "Inspect before delivery; preserve the user's checkout",
            scope: "run",
            taskId: null,
            confidence: "hypothesis",
            observationIds: [],
            evidenceIds: [],
            revision: null,
            environmentGeneration: null,
            supersedes: null,
          },
        },
        {
          kind: "change_agent_settings",
          role: "orchestrator",
          settings: { model: "gpt-6-astra", reasoningEffort: "xhigh" },
        },
        { kind: "inspect_run" },
        question,
      ]),
    }).run();
    const journal = f.store.orchestration;
    const agents = journal.agents.instances(f.state.runId);
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({
      status: "released",
      contract: { effective: { model: "gpt-6-astra", reasoningEffort: "high" } },
    });
    expect(agents[1]).toMatchObject({
      contract: { effective: { model: "gpt-6-astra", reasoningEffort: "xhigh" } },
    });
    expect(agents[1]?.provider).not.toEqual(agents[0]?.provider);
    expect(agents[1]?.workspaceId).not.toBe(agents[0]?.workspaceId);
    expect(journal.agents.turns(f.state.runId)).toHaveLength(4);
    expect(journal.control(f.state.runId).decisionsUsed).toBe(4);
    expect(journal.actions(f.state.runId).every((action) => action.status === "succeeded")).toBe(
      true,
    );
    expect(journal.memory(f.state.runId)[0]?.content).toContain("preserve the user's checkout");
    expect(JSON.stringify(f.observed.at(-1))).toContain("preserve the user's checkout");
    expect(f.git("status", "--porcelain")).toBe("");
  });
  it("rejects a competing controller before creating a coordinator or invoking a runtime", async () => {
    const f = fixture();
    const lease = f.store.acquireLease(f.state.runId);
    let invoked = false;
    const controller = new OrchestratorController(f.store, f.state.runId, {
      driver: () => {
        invoked = true;
        throw new Error("unexpected");
      },
    });
    await expect(controller.run()).rejects.toThrow("already controlled");
    expect(invoked).toBe(false);
    expect(f.store.controllerLease(f.state.runId)?.leaseId).toBe(lease.leaseId);
    expect(f.store.orchestration.agents.instances(f.state.runId)).toEqual([]);
  });
});
