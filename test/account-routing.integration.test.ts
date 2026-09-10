import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { freezeAccountDraft } from "../src/adapters/accounts.js";
import { prepareCodexAccessToken } from "../src/adapters/codex-launch.js";
import { AccountPreferencesSchema, resolveAccountDraft } from "../src/domain/accounts.js";
import { RepositoryPolicySchema, digestJson } from "../src/domain/repository-policy.js";
import {
  AgentSessionContractSchema,
  type AgentRole,
  type RuntimeKind,
} from "../src/domain/types.js";
import type { AgentAssignment, AgentInstance } from "../src/domain/agents.js";
import { ControlledSdkRuntime } from "../src/adapters/controlled-sdk.js";
import { ControlledHerdrRuntime } from "../src/adapters/controlled-herdr.js";
import { KernelBeads } from "../src/adapters/kernel-beads.js";
import { registerTrackerCapabilities } from "../src/kernel/tracker.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
});
function cache(account: string, access = "fake-access") {
  return JSON.stringify({
    auth_mode: "chatgpt",
    last_refresh: "2026-09-01T00:00:00Z",
    tokens: {
      access_token: access,
      id_token: `e30.${Buffer.from(JSON.stringify({ sub: "member" })).toString("base64url")}.c2ln`,
      account_id: account,
      refresh_token: "never-copy-refresh",
    },
  });
}
async function fixture(runtime: RuntimeKind = "sdk", advanced = false) {
  const root = await mkdtemp("/var/tmp/epicd-account-routing-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const homes = Object.fromEntries(
    await Promise.all(
      ["orchestrator", "implementation", "review"].map(async (role) => {
        const path = join(root, role);
        await mkdir(path, { mode: 0o700 });
        await writeFile(join(path, "auth.json"), cache(role), { mode: 0o600 });
        return [role, path];
      }),
    ),
  ) as Record<AgentRole, string>;
  const accounts = await freezeAccountDraft(
    resolveAccountDraft({
      preferences: AccountPreferencesSchema.parse({ schemaVersion: 1 }),
      configPath: join(root, "accounts.json"),
      cwd: root,
      operatorHome: root,
      overrides: {
        codexHome: homes.orchestrator,
        agentCodexHome: [
          `implementation=${homes.implementation}`,
          `review=${homes.review}`,
          ...(advanced
            ? [
                `verification=${homes.orchestrator}`,
                `final_review=${homes.implementation}`,
                `specialist=${homes.orchestrator}`,
              ]
            : []),
        ],
      },
    }),
  );
  const bin = join(root, "bin"),
    executable = join(bin, "codex");
  await mkdir(bin, { mode: 0o700 });
  await copyFile("/bin/false", join(bin, "codex-code-mode-host"));
  await writeFile(
    executable,
    `#!/usr/bin/python3
import json, os, sys, uuid
from pathlib import Path
prompt = sys.stdin.read()
home = Path(os.environ['CODEX_HOME'])
auth = json.loads((home/'auth.json').read_text())
assert auth['tokens']['refresh_token'] == ''
assert not Path(${JSON.stringify(homes.orchestrator)}).exists()
assert not Path(${JSON.stringify(homes.implementation)}).exists()
assert not Path(${JSON.stringify(homes.review)}).exists()
session = home/'fixture-session'
if not session.exists(): session.write_text(str(uuid.uuid4()))
for event in [
 {'type':'thread.started','thread_id':session.read_text()},
 {'type':'turn.started'},
 {'type':'item.completed','item':{'id':'answer','type':'agent_message','text':json.dumps({'account':auth['tokens']['account_id'],'privateHome':str(home)})}},
 {'type':'turn.completed','usage':{'input_tokens':1,'cached_input_tokens':0,'output_tokens':1}}
]: print(json.dumps(event), flush=True)
`,
    { mode: 0o700 },
  );
  const repo = join(root, "repo"),
    tracker = join(root, "br");
  await mkdir(join(repo, ".beads"), { recursive: true, mode: 0o700 });
  await writeFile(join(repo, ".beads", "beads.db"), "fixture transport only");
  await writeFile(
    tracker,
    `#!/usr/bin/python3
import json, sys
from pathlib import Path
args = sys.argv[1:]
claim = Path('/workspace/.beads/claimed')
epic = {'id':'demo','title':'Fixture epic','issue_type':'epic','status':'open','dependencies':[],'dependents':[{'id':'demo.1','dependency_type':'parent-child','status':'in_progress' if claim.exists() else 'open'}]}
task = {'id':'demo.1','title':'Report fixture account','description':'Report fixture account','acceptance_criteria':'Selected account is used','issue_type':'task','status':'in_progress' if claim.exists() else 'open','assignee':claim.read_text() if claim.exists() else None,'dependencies':[{'id':'demo','dependency_type':'parent-child','status':'open'}],'dependents':[]}
if args[0] == 'show': print(json.dumps([epic if id == 'demo' else task for id in args[1:args.index('--db')]]))
elif args[0] == 'ready': print(json.dumps([] if claim.exists() else [task]))
elif args[0] == 'update':
    assert args[1] == 'demo.1' and '--claim' in args
    claim.write_text(args[args.index('--actor')+1])
    print('[]')
else: sys.exit('Unexpected fixture tracker command')
`,
    { mode: 0o700 },
  );
  const path = join(root, "state.sqlite3");
  let store = new StateStore(path);
  cleanup.push(() => store.close());
  const state = store.create(
    {
      ...initialRun(),
      stateSchemaVersion: 4,
      repoPath: repo,
      runtime,
      runtimeConfiguration: {
        commonDirectory: { path: join(root, "repo", ".git"), device: "1", inode: "1" },
        executable,
        trackerExecutable: tracker,
        workspaceRoot: join(root, "workspaces"),
        runtimeRoot: join(root, "runtime"),
        accounts,
        turnTimeoutMs: 15000,
        herdr:
          runtime === "herdr"
            ? { executable: "/usr/bin/false", sessionName: "fixture", workspaceId: "fixture" }
            : null,
      },
    },
    RepositoryPolicySchema.parse({ schemaVersion: 1 }),
  );
  let lease = store.acquireLease(state.runId);
  const authority = () => ({
    runId: state.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  });
  const version = () => store.orchestration.control(state.runId).controlVersion;
  const kernel = new ActionKernel(store.orchestration);
  registerTrackerCapabilities(kernel, new KernelBeads(tracker));
  const ticket = store.orchestration.beginDecision(authority(), 0, version());
  const claiming = await kernel.execute(
    {
      explanation: "Claim the fixture task",
      evidenceIds: [],
      request: {
        schemaVersion: 1,
        decisionId: ticket.decisionId,
        observationCursor: ticket.observationCursor,
        expectedControlVersion: ticket.expectedControlVersion,
        action: {
          kind: "request_beads_transition",
          taskId: "demo.1",
          transition: "claim",
          revision: null,
        },
      },
    },
    authority(),
  );
  const claimed =
    claiming.status === "running" ? await kernel.operation(claiming.operationId) : claiming;
  expect(
    claimed?.status,
    JSON.stringify({
      claimed,
      operations: store.orchestration.tracker.operations(state.runId),
      observations: store.orchestration.observations(state.runId),
    }),
  ).toBe("succeeded");

  const reserve = async (
    role: AgentRole,
    purpose: AgentAssignment["purpose"] = role === "orchestrator" ? "coordination" : role,
    replaces?: AgentInstance,
  ) => {
    const workspace = store.orchestration.agents.reserveWorkspace(
      authority(),
      {
        root: join(root, "workspaces"),
        purpose:
          purpose === "specialist"
            ? "diagnostic"
            : role === "orchestrator"
              ? "coordinator"
              : role === "review"
                ? "review"
                : "implementation",
        sourceMode: role === "implementation" ? "mutable" : "immutable",
        baselineRevision: "fixture",
      },
      version(),
    );
    await mkdir(workspace.path, { recursive: true, mode: 0o700 });
    store.orchestration.agents.markWorkspaceReady(authority(), workspace, "fixture");
    const settings = {
      model: role === "orchestrator" ? "gpt-6-astra" : "worker",
      reasoningEffort: "high",
    };
    return store.orchestration.agents.reserveAgent(
      authority(),
      {
        ...workspace,
        role,
        purpose,
        taskId: role === "orchestrator" ? null : "demo.1",
        candidateId: role === "review" && purpose !== "specialist" ? "candidate" : null,
        instructions: "Report the fixture account",
        contract: AgentSessionContractSchema.parse({
          runtime,
          requested: settings,
          effective: settings,
        }),
        confinementProfile: "epicd-isolated",
        ...(replaces ? { replaces } : {}),
      },
      version(),
    );
  };
  const prepare = (agent: AgentInstance) =>
    store.orchestration.agents.prepareTurn(
      authority(),
      agent,
      randomUUID(),
      "Report the fixture account",
      {
        type: "object",
        properties: { account: { type: "string" }, privateHome: { type: "string" } },
        required: ["account", "privateHome"],
        additionalProperties: false,
      },
      version(),
    );
  const run = async (agent: AgentInstance, cancel = false) => {
    const turn = prepare(agent);
    const config = store.get(state.runId)!.runtimeConfiguration!;
    const options = {
      root: config.runtimeRoot,
      executable: config.executable,
      authCachePath: null,
      launcherEntrypoint: join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
      turnTimeoutMs: config.turnTimeoutMs,
    };
    const driver =
      runtime === "sdk"
        ? new ControlledSdkRuntime(store.orchestration, options)
        : new ControlledHerdrRuntime(store.orchestration, {
            ...options,
            herdrPath: "/usr/bin/false",
            sessionName: "fixture",
            workspaceId: "fixture",
          });
    return driver.run(authority(), turn.identity, cancel ? AbortSignal.abort() : undefined);
  };
  const reopen = () => {
    store.releaseLease(state.runId, lease.ownerToken);
    store.close();
    store = new StateStore(path);
    lease = store.acquireLease(state.runId);
  };
  return {
    root,
    homes,
    accounts,
    state,
    path,
    authority,
    version,
    reserve,
    prepare,
    run,
    reopen,
    get store() {
      return store;
    },
  };
}
describe.runIf(process.platform === "linux")("persisted account routing", () => {
  it("runs three SDK agents with their selected credentials and private homes", async () => {
    const f = await fixture();
    for (const role of ["orchestrator", "implementation", "review"] as const) {
      const agent = await f.reserve(role),
        result = await f.run(agent);
      expect(result.status, JSON.stringify(f.store.orchestration.observations(f.state.runId))).toBe(
        "completed",
      );
      expect(result.result).toMatchObject({ account: role });
      expect(result.launch?.manifest.authCachePath).toBe(join(f.homes[role], "auth.json"));
      expect(result.launch?.manifest.confinement.providerHome).not.toBe(f.homes[role]);
      expect(result.launch?.stop?.processTreeStopped).toBe(true);
      expect(JSON.stringify(result.prompt)).not.toContain(f.homes[role]);
      const projected = await readFile(
        join(result.launch!.manifest.confinement.providerHome, "auth.json"),
        "utf8",
      );
      expect(projected).not.toContain("never-copy-refresh");
    }
  });
  it("uses the same frozen account bindings in native launch manifests before cancelled dispatch", async () => {
    vi.stubEnv("HERDR_ENV", "1");
    const f = await fixture("herdr");
    for (const role of ["orchestrator", "implementation", "review"] as const) {
      const agent = await f.reserve(role),
        result = await f.run(agent, true);
      expect(result.status).toBe("cancelled");
      const manifest = result.launch!.manifest;
      expect(manifest.accountBinding?.source.authCachePath).toBe(join(f.homes[role], "auth.json"));
      expect(manifest.authCachePath).toBe(manifest.accountBinding?.source.authCachePath);
      await prepareCodexAccessToken(manifest);
      expect(
        JSON.parse(await readFile(join(manifest.confinement.providerHome, "auth.json"), "utf8"))
          .tokens.account_id,
      ).toBe(role);
    }
  });
  it.each([false, true])(
    "routes advanced purposes and specialists through actual manifests (overrides=%s)",
    async (advanced) => {
      const f = await fixture("sdk", advanced);
      const cases = [
        ["review", "verification", advanced ? "orchestrator" : "review"],
        ["review", "final_review", advanced ? "implementation" : "review"],
        ["implementation", "specialist", advanced ? "orchestrator" : "implementation"],
        ["review", "specialist", advanced ? "orchestrator" : "review"],
      ] as const;
      for (const [role, purpose, expected] of cases) {
        const agent = await f.reserve(role, purpose);
        const turn = await f.run(agent, true);
        expect(turn.status).toBe("cancelled");
        expect(turn.launch!.manifest.accountBinding?.accountClass).toBe(purpose);
        expect(turn.launch!.manifest.authCachePath).toBe(join(f.homes[expected], "auth.json"));
        await prepareCodexAccessToken(turn.launch!.manifest);
        const projected = JSON.parse(
          await readFile(join(turn.launch!.manifest.confinement.providerHome, "auth.json"), "utf8"),
        );
        expect(projected.tokens.account_id).toBe(expected);
        expect(projected.tokens.refresh_token).toBe("");
      }
    },
  );
  it("retains a conversation and its binding across reopen, environment changes, rotation and replacement", async () => {
    const f = await fixture(),
      agent = await f.reserve("implementation");
    const first = await f.run(agent),
      binding = agent.accountBinding,
      provider = f.store.orchestration.agents.instance(f.state.runId, agent).provider;
    expect(first.status).toBe("completed");
    f.reopen();
    vi.stubEnv("CODEX_HOME", f.homes.review);
    await writeFile(
      join(f.homes.implementation, "next.json"),
      cache("implementation", "rotated-access"),
      { mode: 0o600 },
    );
    await rename(
      join(f.homes.implementation, "next.json"),
      join(f.homes.implementation, "auth.json"),
    );
    const second = await f.run(f.store.orchestration.agents.instance(f.state.runId, agent));
    expect(second.status).toBe("completed");
    expect(second.result).toMatchObject({ account: "implementation" });
    expect(f.store.orchestration.agents.instance(f.state.runId, agent).provider).toEqual(provider);
    expect(second.launch!.manifest.accountBinding).toEqual(binding);
    f.store.orchestration.agents.revokeAgent(f.authority(), agent, "Replace the stopped fixture");
    f.store.orchestration.agents.releaseAgent(f.authority(), agent);
    const replacement = await f.reserve("implementation", "implementation", agent);
    expect(replacement.accountBinding).toEqual(binding);
    expect((await f.run(replacement)).result).toMatchObject({ account: "implementation" });
  });
  it("pins an unused reviewer before creation and rejects a changed account on reservation", async () => {
    const f = await fixture();
    f.reopen();
    await writeFile(join(f.homes.review, "auth.json"), cache("different-reviewer"), {
      mode: 0o600,
    });
    await expect(f.reserve("review")).rejects.toThrow(/account changed/);
    expect(f.store.orchestration.agents.instances(f.state.runId)).toEqual([]);
  });
  it("rejects a replaced home directory even when its credentials have the same principal", async () => {
    const f = await fixture(),
      agent = await f.reserve("implementation");
    await rename(f.homes.implementation, f.homes.implementation + "-old");
    await mkdir(f.homes.implementation, { mode: 0o700 });
    await writeFile(join(f.homes.implementation, "auth.json"), cache("implementation"), {
      mode: 0o600,
    });
    const result = await f.run(agent);
    expect(result.status).toBe("failed");
    expect(result.result).toBeNull();
    expect(result.launch?.stop?.kind).toBe("not_started");
    expect(f.store.orchestration.agents.instance(f.state.runId, agent).provider).toBeNull();
  });
  it("keeps credential sources and principal digests out of model-facing inspection", async () => {
    const f = await fixture(),
      agent = await f.reserve("implementation"),
      journal = f.store.orchestration;
    const ticket = journal.beginDecision(
      f.authority(),
      journal.latestObservationCursor(f.state.runId),
      f.version(),
    );
    const result = await new ActionKernel(journal).execute(
      {
        explanation: "Inspect the fixture",
        evidenceIds: [],
        request: {
          schemaVersion: 1,
          decisionId: ticket.decisionId,
          observationCursor: ticket.observationCursor,
          expectedControlVersion: ticket.expectedControlVersion,
          action: {
            kind: "inspect_agent",
            agentId: agent.agentId,
            agentGeneration: agent.agentGeneration,
          },
        },
      },
      f.authority(),
    );
    expect(result).toMatchObject({ status: "succeeded", result: { kind: "inspection" } });
    const output = JSON.stringify(result);
    expect(output).toContain("implementation");
    expect(output).not.toContain(f.homes.implementation);
    expect(output).not.toContain(agent.accountBinding!.source.principalDigest);
    expect(output).not.toContain("auth.json");
  });
});
