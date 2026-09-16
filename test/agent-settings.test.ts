import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { ControlledAgentDispatcher } from "../src/adapters/agent-dispatch.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { registerSettingsCapabilities } from "../src/kernel/settings.js";
import { registerAgentCapabilities } from "../src/kernel/agents.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import {
  AgentSessionContractSchema,
  resolveAgentRoleSettings,
  type RuntimeKind,
} from "../src/domain/types.js";
import type { KernelAction } from "../src/domain/orchestration.js";
import { initialRun } from "./fixtures/orchestration/state.js";
import { fixtureAccounts } from "./fixtures/accounts.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture(allow = true, runtime: RuntimeKind = "sdk") {
  const root = mkdtempSync("/var/tmp/epicd-settings-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite3");
  const store = new StateStore(path);
  cleanup.push(() => store.close());
  const run = store.create(
    {
      ...initialRun(),
      runtime,
      runtimeConfiguration: {
        commonDirectory: { path: join(root, "repo", ".git"), device: "1", inode: "1" },
        executable: process.execPath,
        trackerExecutable: process.execPath,
        runtimeRoot: join(root, "runtime"),
        workspaceRoot: join(root, "workspaces"),
        accounts: fixtureAccounts(root),
        turnTimeoutMs: 30 * 60_000,
        herdr:
          runtime === "herdr"
            ? { executable: process.execPath, sessionName: "owned", workspaceId: "w1" }
            : null,
      },
    },
    RepositoryPolicySchema.parse({
      schemaVersion: 1,
      autonomousWorkerSettings: allow
        ? [{ model: "permitted-worker", reasoningEffort: "medium" }]
        : [],
      coordinator: { reasoningEfforts: ["high", "xhigh"] },
    }),
  );
  const fixtureDb = new Database(path);
  fixtureDb.prepare("DELETE FROM tracker_roots WHERE run_id = ?").run(run.runId);
  fixtureDb.close();
  const lease = store.acquireLease(run.runId);
  const authority = { runId: run.runId, leaseId: lease.leaseId, ownerToken: lease.ownerToken };
  const journal = store.orchestration;
  const kernel = new ActionKernel(journal);
  const noProvider = (kind: RuntimeKind) => ({
    backend: "codex" as const,
    kind,
    run: async () => {
      throw new Error("Reservation must not start a provider");
    },
    reconcile: async () => {
      throw new Error("Reservation must not control a provider");
    },
  });
  const dispatcher = new ControlledAgentDispatcher(
    journal,
    runtime === "sdk"
      ? { "codex:sdk": () => noProvider("sdk") }
      : { "codex:herdr": () => noProvider("herdr") },
  );
  registerSettingsCapabilities(kernel, store);
  const decision = (action: KernelAction) => {
    const ticket = journal.beginDecision(
      authority,
      journal.latestObservationCursor(run.runId),
      journal.control(run.runId).controlVersion,
    );
    return {
      explanation: "Change tactics within policy",
      evidenceIds: [],
      request: {
        schemaVersion: 1 as const,
        decisionId: ticket.decisionId,
        observationCursor: ticket.observationCursor,
        expectedControlVersion: ticket.expectedControlVersion,
        action,
      },
    };
  };
  return { root, path, store, run, authority, journal, kernel, dispatcher, decision };
}
const change: KernelAction = {
  kind: "change_agent_settings",
  role: "implementation",
  settings: { model: "permitted-worker", reasoningEffort: "medium" },
};
describe("policy-bound autonomous agent settings", () => {
  it("commits settings, control version, action result and audit atomically and replays without another update", async () => {
    const f = fixture();
    const request = f.decision(change);
    const first = await f.kernel.execute(request, f.authority);
    expect(first.status).toBe("succeeded");
    expect(resolveAgentRoleSettings(f.store.get(f.run.runId)!, "implementation")).toEqual(
      change.settings,
    );
    expect(f.journal.control(f.run.runId)).toMatchObject({ controlVersion: 1, decisionsUsed: 1 });
    expect(await f.kernel.execute(request, f.authority)).toEqual(first);
    expect(f.journal.control(f.run.runId)).toMatchObject({ controlVersion: 1, decisionsUsed: 1 });
    const reopened = new StateStore(f.path);
    cleanup.push(() => reopened.close());
    expect(resolveAgentRoleSettings(reopened.get(f.run.runId)!, "implementation")).toEqual(
      change.settings,
    );
    expect(
      reopened.events(f.run.runId).filter((event) => event.kind === "agent.settings_updated"),
    ).toHaveLength(1);
    expect(reopened.orchestration.policy(f.run.runId).autonomousWorkerSettings).toEqual([
      change.settings,
    ]);
  });
  it.each([
    { role: "implementation", settings: { model: "unlisted", reasoningEffort: "medium" } },
    { role: "review", settings: { model: "permitted-worker", reasoningEffort: "max" } },
    { role: "orchestrator", settings: { model: "permitted-worker", reasoningEffort: "high" } },
    { role: "orchestrator", settings: { model: "gpt-6-astra", reasoningEffort: "low" } },
  ] as const)("rejects an unauthorized $role selection without changing state", async (input) => {
    const f = fixture();
    const before = f.store.get(f.run.runId);
    const result = await f.kernel.execute(
      f.decision({ kind: "change_agent_settings", ...input }),
      f.authority,
    );
    expect(result.status).toBe("rejected");
    expect(f.store.get(f.run.runId)).toEqual(before);
    expect(f.journal.control(f.run.runId).controlVersion).toBe(0);
  });
  it("does not interpret an absent allowlist as unrestricted choice", async () => {
    const f = fixture(false);
    expect((await f.kernel.execute(f.decision(change), f.authority)).status).toBe("rejected");
  });
  it("retains an unchanged setting without generating another settings version", async () => {
    const f = fixture(false);
    const request = f.decision({
      kind: "change_agent_settings",
      role: "implementation",
      settings: resolveAgentRoleSettings(f.run, "implementation"),
    });
    expect((await f.kernel.execute(request, f.authority)).status).toBe("succeeded");
    expect(f.journal.control(f.run.runId).controlVersion).toBe(0);
  });
  it("rolls back the nested settings transaction when recording the action result fails", async () => {
    const f = fixture();
    const db = new Database(f.path);
    cleanup.push(() => db.close());
    const before = f.store.get(f.run.runId);
    db.exec(
      "CREATE TRIGGER fail_action_result BEFORE UPDATE OF result_json ON actions WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'result unavailable'); END",
    );
    await expect(f.kernel.execute(f.decision(change), f.authority)).rejects.toThrow(
      "result unavailable",
    );
    expect(f.store.get(f.run.runId)).toEqual(before);
    expect(f.journal.control(f.run.runId).controlVersion).toBe(0);
    expect(
      f.store.events(f.run.runId).some((event) => event.kind === "agent.settings_updated"),
    ).toBe(false);
  });
  it("rejects a stale decision after an operator changes future settings", async () => {
    const f = fixture();
    const request = f.decision(change);
    const settings = structuredClone(f.run.agentSettings);
    settings.review.model = "operator-selected";
    f.store.updateAgentSettingsWithLease(f.run.runId, f.authority.ownerToken, settings);
    expect((await f.kernel.execute(request, f.authority)).status).toBe("rejected");
    expect(f.store.get(f.run.runId)?.agentSettings.review.model).toBe("operator-selected");
    expect(resolveAgentRoleSettings(f.store.get(f.run.runId)!, "implementation").model).toBe(
      "worker-model",
    );
  });
  it.each(["sdk", "herdr"] as const)(
    "keeps a %s assignment pinned and uses changed settings only for its fresh replacement",
    async (runtime) => {
      const f = fixture(true, runtime);
      const contractFor = () => {
        const settings = resolveAgentRoleSettings(f.store.get(f.run.runId)!, "implementation");
        return AgentSessionContractSchema.parse({
          backend: "codex",
          runtime,
          requested: settings,
          effective: settings,
        });
      };
      registerAgentCapabilities(f.kernel, f.dispatcher, contractFor);
      const workspace = () => {
        const record = f.journal.agents.reserveWorkspace(
          f.authority,
          {
            root: join(f.root, "workspaces"),
            purpose: "implementation",
            sourceMode: "mutable",
            baselineRevision: "test-only-base",
          },
          f.journal.control(f.run.runId).controlVersion,
        );
        mkdirSync(record.path, { recursive: true });
        return f.journal.agents.markWorkspaceReady(f.authority, record, "test-only-fingerprint");
      };
      const ws = workspace();
      const old = f.journal.agents.reserveAgent(
        f.authority,
        {
          ...ws,
          role: "implementation",
          purpose: "implementation",
          taskId: "demo.1",
          candidateId: null,
          instructions: "Implement",
          confinementProfile: "epicd-isolated",
          contract: contractFor(),
        },
        f.journal.control(f.run.runId).controlVersion,
      );
      expect((await f.kernel.execute(f.decision(change), f.authority)).status).toBe("succeeded");
      expect(f.journal.agents.instance(f.run.runId, old).contract).toEqual(old.contract);
      const nextWorkspace = workspace();
      const result = await f.kernel.execute(
        f.decision({
          kind: "replace_agent",
          agentId: old.agentId,
          agentGeneration: old.agentGeneration,
          workspaceId: nextWorkspace.workspaceId,
          workspaceGeneration: nextWorkspace.workspaceGeneration,
          reason: "Use the approved alternative",
          instructions: "Continue with retained task context",
        }),
        f.authority,
      );
      expect(result.status).toBe("succeeded");
      const next = f.journal.agents.instance(f.run.runId, {
        agentId: old.agentId,
        agentGeneration: 2,
      });
      expect(next.contract).toMatchObject({
        runtime,
        effective: change.settings,
        requested: change.settings,
      });
      expect(next.provider).toBeNull();
      expect(f.journal.agents.turns(f.run.runId)).toEqual([]);
      expect(f.journal.control(f.run.runId).decisionsUsed).toBe(2);
    },
  );
});
