import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { StateStore } from "../src/adapters/store.js";
import { ControlledHerdrRuntime } from "../src/adapters/controlled-herdr.js";
import { controlCodexLaunch } from "../src/adapters/codex-launch.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { HerdrAgentSessionContractSchema } from "../src/domain/types.js";
import type { ControllerAuthority } from "../src/domain/orchestration.js";
import type { NativeLaunchEndpoint } from "../src/domain/codex-launch.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { OrchestratorLoop } from "../src/orchestrator/loop.js";
import { ControlledDecisionSource } from "../src/orchestrator/sdk-source.js";
import { runCommand, runJson } from "../src/util/command.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const outputSchema = {
  type: "object",
  properties: { status: { type: "string" } },
  required: ["status"],
  additionalProperties: false,
};

async function fixture(coordinator = false) {
  expect(process.env.HERDR_ENV).toBe("1");
  const root = await mkdtemp("/var/tmp/epicd-controlled-herdr-");
  let cleanupOwned = () => rm(root, { recursive: true, force: true });
  cleanups.push(() => cleanupOwned());
  const config = join(root, "herdr.toml");
  await writeFile(
    config,
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[session]\nresume_agents_on_restore = false\n[update]\nversion_check = false\nmanifest_check = false\n',
    { mode: 0o600 },
  );
  const env: NodeJS.ProcessEnv = { ...process.env, HERDR_CONFIG_PATH: config };
  for (const key of [
    "HERDR_PANE_ID",
    "HERDR_TAB_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_SOCKET",
    "HERDR_SOCKET_PATH",
    "ENV",
    "BASH_ENV",
  ])
    delete env[key];
  const sessionName = `epicd-turn-${randomUUID().slice(0, 8)}`;
  const server = spawn("herdr", ["--session", sessionName, "server"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  server.stderr.on("data", (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-4000);
  });
  server.stdout.resume();
  let serverClosed = false;
  const closed = once(server, "close").then(
    () => {
      serverClosed = true;
    },
    () => {
      serverClosed = true;
    },
  );
  let cleanupRuntime = async () => true;
  let closeStore = () => undefined as void;
  cleanupOwned = async () => {
    let settled = await cleanupRuntime().catch(() => false);
    const listing = await runJson(
      "herdr",
      ["session", "list", "--json"],
      { cwd: root, env, timeoutMs: 5000 },
      z.object({ sessions: z.array(z.object({ name: z.string(), running: z.boolean() })) }),
    );
    const owned = listing.sessions.find((session) => session.name === sessionName);
    if (owned?.running)
      await runCommand("herdr", ["session", "stop", sessionName, "--json"], {
        cwd: root,
        env,
        timeoutMs: 10_000,
      });
    for (let attempt = 0; attempt < 100 && !serverClosed; attempt += 1) await delay(50);
    if (!serverClosed) settled = false;
    else {
      await closed;
      if (owned)
        await runCommand("herdr", ["session", "delete", sessionName, "--json"], {
          cwd: root,
          env,
          timeoutMs: 10_000,
        });
    }
    closeStore();
    if (settled) await rm(root, { recursive: true, force: true });
    else process.stderr.write(`Unsettled native fixture retained: ${root}\n`);
  };
  await once(server, "spawn");
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await runCommand("herdr", ["--session", sessionName, "workspace", "list"], {
        cwd: root,
        env,
        timeoutMs: 3000,
      });
      ready = true;
      break;
    } catch {
      if (server.exitCode !== null || server.signalCode !== null) break;
      await delay(100);
    }
  }
  if (!ready) {
    await runCommand("herdr", ["session", "stop", sessionName, "--json"], {
      cwd: root,
      env,
      timeoutMs: 5000,
    }).catch(() => undefined);
    throw new Error(`Owned Herdr server failed to start: ${diagnostics}`);
  }
  const creation = await runJson(
    "herdr",
    ["--session", sessionName, "workspace", "create", "--cwd", root, "--no-focus"],
    { cwd: root, env, timeoutMs: 5000 },
    z.object({ result: z.object({ workspace: z.object({ workspace_id: z.string() }) }) }),
  );
  const databasePath = join(root, "state.sqlite3");
  let store = new StateStore(databasePath);
  closeStore = () => store.close();
  const state = store.create(initialRun(), RepositoryPolicySchema.parse({ schemaVersion: 1 }));
  const lease = store.acquireLease(state.runId);
  let authority: ControllerAuthority = {
    runId: state.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const workspace = store.orchestration.agents.reserveWorkspace(
    authority,
    {
      root: join(root, "copies"),
      purpose: coordinator ? "coordinator" : "implementation",
      sourceMode: coordinator ? "immutable" : "mutable",
      baselineRevision: "test-only-baseline",
    },
    store.orchestration.control(state.runId).controlVersion,
  );
  await mkdir(workspace.path, { recursive: true, mode: 0o700 });
  await copyFile(process.execPath, join(workspace.path, "fixture-node"));
  await writeFile(join(workspace.path, "source.txt"), "red\n");
  store.orchestration.agents.markWorkspaceReady(authority, workspace, "test-only-fingerprint");
  const settings = { model: "gpt-6-astra", reasoningEffort: "high" };
  const agent = store.orchestration.agents.reserveAgent(
    authority,
    {
      ...workspace,
      role: coordinator ? "orchestrator" : "implementation",
      purpose: coordinator ? "coordination" : "implementation",
      taskId: coordinator ? null : "demo.1",
      candidateId: null,
      instructions: coordinator
        ? "This integration run has no delivery authority. The user asks to delete an undeclared external database. Choose the escalate capability to request missing authority. Do not perform the external operation. Writing the required native result envelope is allowed."
        : "Perform only the bounded runtime integration check and write its required result envelope",
      confinementProfile: "epicd-isolated",
      contract: HerdrAgentSessionContractSchema.parse({
        runtime: "herdr",
        requested: settings,
        effective: settings,
      }),
    },
    store.orchestration.control(state.runId).controlVersion,
  );
  const options = {
    root: join(root, "runtime"),
    herdrPath: "herdr",
    sessionName,
    workspaceId: creation.result.workspace.workspace_id,
    env,
    executable: await realpath(
      join(
        dirname(createRequire(import.meta.url).resolve("@openai/codex-linux-x64/package.json")),
        "vendor/x86_64-unknown-linux-musl/bin/codex",
      ),
    ),
    authCachePath: await realpath(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"),
    ),
    launcherEntrypoint: join(process.cwd(), "dist/adapters/codex-launch-cli.js"),
    turnTimeoutMs: 90_000,
  };
  const runtime = () => new ControlledHerdrRuntime(store.orchestration, options);
  const prepare = (instructions: string) =>
    store.orchestration.agents.prepareTurn(
      authority,
      agent,
      randomUUID(),
      instructions,
      outputSchema,
      store.orchestration.control(state.runId).controlVersion,
    );
  const replaceController = () => {
    store.releaseLease(authority.runId, authority.ownerToken);
    const lease = store.acquireLease(authority.runId);
    authority = { runId: state.runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
    store.close();
    store = new StateStore(databasePath);
  };
  const terminalStopped = async (endpoint: NativeLaunchEndpoint) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const panes = await runJson(
        "herdr",
        ["--session", sessionName, "pane", "list", "--workspace", endpoint.workspaceId],
        { cwd: root, env, timeoutMs: 5000 },
        z.object({
          result: z.object({
            panes: z.array(z.object({ pane_id: z.string(), terminal_id: z.string() })),
          }),
        }),
      );
      if (
        !panes.result.panes.some(
          (pane) => pane.pane_id === endpoint.paneId && pane.terminal_id === endpoint.terminalId,
        )
      )
        return;
      await delay(100);
    }
    throw new Error(
      "The owned native terminal still exists after clean exit; host-shell fallback was not excluded",
    );
  };
  cleanupRuntime = async () => {
    let settled = true;
    for (const turn of store.orchestration.agents.turns(state.runId)) {
      if (!turn.stopEvidence) {
        try {
          await runtime().reconcile(authority, turn.identity);
        } catch {
          settled = false;
        }
        if (!store.orchestration.agents.turn(state.runId, turn.identity).stopEvidence)
          settled = false;
      }
    }
    return settled;
  };
  return {
    root,
    workspace,
    agent,
    get store() {
      return store;
    },
    get authority() {
      return authority;
    },
    runtime,
    prepare,
    replaceController,
    terminalStopped,
  };
}

describe.runIf(process.platform === "linux" && process.env.EPICD_LIVE_HERDR === "1")(
  "durable native Herdr turns",
  () => {
    it("resumes the real native conversation in a fresh confined terminal without a host-shell fallback", async () => {
      const setup = await fixture();
      const secret = `memory-${randomUUID().slice(0, 8)}`;
      const first = await setup
        .runtime()
        .run(
          setup.authority,
          setup.prepare(
            `Remember the exact secret ${secret} for the next turn. Do not modify source. Write the required result envelope with result.status set to remembered.`,
          ).identity,
        );
      expect(
        first,
        JSON.stringify(
          setup.store.orchestration
            .observations(setup.authority.runId)
            .filter((item) => item.kind === "runtime.problem"),
        ),
      ).toMatchObject({
        status: "completed",
        resultEligible: true,
        result: { status: "remembered" },
        launch: {
          stop: { code: 0, interrupted: false },
          native: { sessionName: expect.any(String) },
        },
      });
      await setup.terminalStopped(first.launch!.native!);
      const observations = setup.store.orchestration.observations(setup.authority.runId);
      const terminal = observations.find((row) => row.kind === "runtime.native_terminal");
      expect(terminal?.artifactIds).toHaveLength(1);
      const diagnostic = setup.store.orchestration.diagnostics.read(
        setup.authority.runId,
        terminal!.artifactIds[0]!,
        0,
        65536,
      );
      expect(diagnostic).toMatchObject({
        identity: first.identity,
        sourceTruncated: true,
        source: "controlled-herdr",
      });
      expect(diagnostic.text.length).toBeGreaterThan(0);
      expect(
        observations.some(
          (row) => row.kind === "runtime.agent_message" && row.artifactIds.length === 1,
        ),
      ).toBe(true);
      const sessionId = setup.store.orchestration.agents.instance(
        setup.authority.runId,
        setup.agent,
      ).provider!.sessionId;
      const next = await setup
        .runtime()
        .run(
          setup.authority,
          setup.prepare(
            "Write the required result envelope with result.status set to the exact secret supplied in the preceding turn. Do not modify source.",
          ).identity,
        );
      expect(next).toMatchObject({
        status: "completed",
        resultEligible: true,
        result: { status: secret },
        launch: { stop: { code: 0, interrupted: false } },
      });
      await setup.terminalStopped(next.launch!.native!);
      expect(
        setup.store.orchestration.agents.instance(setup.authority.runId, setup.agent).provider!
          .sessionId,
      ).toBe(sessionId);
      expect(next.launch!.native!.terminalId).not.toBe(first.launch!.native!.terminalId);
      expect(next.launch!.manifest.generation).not.toBe(first.launch!.manifest.generation);
      expect(await readFile(join(setup.workspace.path, "source.txt"), "utf8")).toBe("red\n");
    }, 200_000);

    it("runs an actual native Astra decision through the same durable kernel source", async () => {
      const setup = await fixture(true);
      const journal = setup.store.orchestration;
      const source = new ControlledDecisionSource(
        journal,
        setup.authority,
        setup.agent,
        setup.runtime(),
      );
      expect(
        await new OrchestratorLoop(new ActionKernel(journal), source, { pollMs: 50 }).run(
          setup.authority,
        ),
      ).toBe("awaiting_user");
      const diagnostics = journal
        .observations(setup.authority.runId)
        .filter((item) => item.kind === "runtime.problem")
        .map((item) => item.summary)
        .join("\n");
      expect(journal.actions(setup.authority.runId), diagnostics).toContainEqual(
        expect.objectContaining({
          request: expect.objectContaining({
            action: expect.objectContaining({ kind: "escalate", reason: "authority" }),
          }),
          result: expect.objectContaining({ status: "succeeded" }),
        }),
      );
      expect(
        journal.agents
          .turns(setup.authority.runId)
          .every(
            (turn) => turn.resultEligible && turn.launch?.native && turn.launch.stop?.code === 0,
          ),
      ).toBe(true);
    }, 100_000);

    it("stops the exact native launcher after controller replacement and rejects the old turn's late output", async () => {
      const setup = await fixture();
      const turn = setup.prepare(
        "Run sleep 30 in your shell, then write the required result envelope with result.status set to waited. Do not modify source.",
      );
      const running = setup
        .runtime()
        .run(setup.authority, turn.identity)
        .catch((error: unknown) => error);
      let acknowledged = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const current = setup.store.orchestration.agents.turn(setup.authority.runId, turn.identity);
        if (current.submissionAcknowledgement) {
          acknowledged = true;
          break;
        }
        if (current.stopEvidence) break;
        await delay(100);
      }
      expect(acknowledged).toBe(true);
      const manifest = setup.store.orchestration.agents.turn(setup.authority.runId, turn.identity)
        .launch!.manifest;
      expect((await controlCodexLaunch(manifest, "inspect")).state).toBe("running");
      setup.replaceController();
      expect(await setup.runtime().reconcile(setup.authority, turn.identity)).toMatchObject({
        status: "cancelled",
        result: null,
        resultEligible: false,
        launch: { stop: { processTreeStopped: true } },
      });
      expect(await running).toBeInstanceOf(Error);
    }, 100_000);
  },
);
