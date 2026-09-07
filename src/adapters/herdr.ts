import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type {
  AgentRole,
  AgentRuntime,
  AgentRuntimeBaseOptions,
  AgentSessionSpec,
  HerdrAgentId,
  HerdrAgentSession,
  OpenedAgentSession,
  RunTurnOptions,
  TurnExecution,
} from "./runtime.js";
import {
  HerdrAgentSessionContractSchema,
  type AgentRoleSettings,
  type HerdrAgentSessionContract,
} from "../domain/types.js";
import { CommandError, runCommand, runJson } from "../util/command.js";
import { redactSensitiveText } from "../util/redact.js";
import { HerdrObserver, type NativeHerdrIdentity } from "./herdr-observer.js";
import { runtimeCapabilities } from "./runtime-capabilities.js";

const HerdrEnvelopeSchema = z.object({
  ok: z.boolean().optional(),
  result: z
    .object({
      root_pane: z.object({ pane_id: z.string().min(1).optional() }).optional(),
    })
    .optional(),
});

const HerdrAgentListEnvelopeSchema = z.object({
  result: z.object({
    agents: z.array(
      z.object({
        name: z.string().optional(),
        tab_id: z.string().min(1),
      }),
    ),
  }),
});

const TURN_TIMEOUT_MS = 6 * 60 * 60 * 1_000;

export type HerdrRuntimeOptions = AgentRuntimeBaseOptions & {
  runId: string;
  agentNamespace: string;
  herdrPath?: string | undefined;
  legacyAgentIds?: readonly string[] | undefined;
};

export class HerdrRuntime implements AgentRuntime<"herdr"> {
  readonly kind = "herdr";
  private readonly resultRoot: string;
  private readonly repoPath: string;
  private readonly runId: string;
  private readonly agentNamespace: string;
  private readonly herdrPath: string;
  private readonly accessMode: HerdrRuntimeOptions["accessMode"];
  private readonly legacyAgentIds: ReadonlySet<string>;
  private readonly observer: HerdrObserver;
  private readonly activeSessions = new Set<HerdrAgentSession>();
  private readonly activeAgentNames = new Set<string>();

  constructor(options: HerdrRuntimeOptions) {
    this.repoPath = options.repoPath;
    this.runId = options.runId;
    this.agentNamespace = options.agentNamespace;
    this.herdrPath = options.herdrPath ?? "herdr";
    this.observer = new HerdrObserver({ cwd: this.repoPath, herdrPath: this.herdrPath });
    this.accessMode = options.accessMode;
    this.legacyAgentIds = new Set(options.legacyAgentIds ?? []);
    const stateRoot = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    this.resultRoot = join(stateRoot, "epicd", "herdr", safeName(options.runId));
  }

  capabilities() {
    return runtimeCapabilities(this.kind);
  }

  async prepareNewSession(
    _role: AgentRole,
    settings: AgentRoleSettings,
  ): Promise<HerdrAgentSessionContract> {
    return HerdrAgentSessionContractSchema.parse({
      runtime: "herdr",
      requested: settings,
      effective: settings,
    });
  }

  async open(
    role: AgentRole,
    spec: AgentSessionSpec<"herdr">,
  ): Promise<OpenedAgentSession<"herdr">> {
    const session: HerdrAgentSession = {
      runtime: "herdr",
      id: spec.kind === "existing" ? this.ownedAgentId(spec.sessionId) : null,
      role,
    };
    const contract =
      spec.kind === "new" && "settings" in spec
        ? await this.prepareNewSession(role, spec.settings)
        : HerdrAgentSessionContractSchema.parse(spec.contract);
    return Object.freeze({ runtime: "herdr", session, contract });
  }

  async run(
    opened: OpenedAgentSession<"herdr">,
    prompt: string,
    options: RunTurnOptions = {},
  ): Promise<TurnExecution> {
    if (opened.runtime !== "herdr") {
      throw new Error("Herdr runtime received a non-Herdr session");
    }
    if (
      this.activeSessions.has(opened.session) ||
      (opened.session.id && this.activeAgentNames.has(opened.session.id))
    ) {
      throw new Error("Herdr agent already has an active turn");
    }
    this.activeSessions.add(opened.session);
    if (opened.session.id) this.activeAgentNames.add(opened.session.id);
    try {
      return await this.runOwnedTurn(opened, prompt, options);
    } finally {
      this.activeSessions.delete(opened.session);
      if (opened.session.id) this.activeAgentNames.delete(opened.session.id);
    }
  }

  private async runOwnedTurn(
    opened: OpenedAgentSession<"herdr">,
    prompt: string,
    options: RunTurnOptions,
  ): Promise<TurnExecution> {
    const session = opened.session;
    this.assertEnvironment();
    await mkdir(this.resultRoot, { recursive: true, mode: 0o700 });

    let agentName = session.id;
    if (agentName) await this.assertAgentAvailable(agentName, options.signal);
    else {
      agentName = await this.createAgent(session.role, opened.contract.effective);
      session.id = agentName;
      this.activeAgentNames.add(agentName);
      options.onEvent?.({ type: "session.started", sessionId: agentName });
    }
    const turnRoot = join(this.resultRoot, agentName, randomUUID());
    await mkdir(turnRoot, { recursive: true, mode: 0o700 });
    const resultPath = join(turnRoot, "result.json");
    await writeFile(`${resultPath}.tmp`, "", { mode: 0o600 });
    const fullPrompt = resultContract(prompt, options.outputSchema, resultPath);
    try {
      const before = await this.observer.observe(agentName, undefined, options.signal);
      if (!before.ready) throw new Error(`Herdr agent is not ready (${before.state})`);
      await runCommand(this.herdrPath, ["agent", "prompt", agentName, fullPrompt], {
        cwd: this.repoPath,
        timeoutMs: 15_000,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      await this.waitForReady(before.identity, options);
    } catch (error) {
      if (options.signal?.aborted) await this.interrupt(agentName);
      await rm(resultPath, { force: true });
      await rm(`${resultPath}.tmp`, { force: true });
      if (options.signal?.aborted) throw abortReason(options.signal);
      throw new Error(
        `Herdr turn failed for ${agentName}: ${redactSensitiveText(safeErrorDetail(error))}`,
      );
    }

    let finalResponse: string;
    try {
      finalResponse = await readFile(resultPath, "utf8");
      await chmod(resultPath, 0o600);
    } catch {
      throw new Error(
        `Herdr agent ${agentName} settled without writing its structured result artifact`,
      );
    } finally {
      await rm(resultPath, { force: true });
      await rm(`${resultPath}.tmp`, { force: true });
    }
    if (!finalResponse.trim()) throw new Error(`Herdr agent ${agentName} wrote an empty result`);
    options.onEvent?.({ type: "turn.completed", usage: null });
    return { sessionId: agentName, finalResponse, usage: null };
  }

  async release(sessionId: string): Promise<void> {
    const agentName = this.ownedAgentId(sessionId);
    const listed = await runJson(
      this.herdrPath,
      ["agent", "list"],
      { cwd: this.repoPath, timeoutMs: 10_000 },
      HerdrAgentListEnvelopeSchema,
    );
    const agent = listed.result.agents.find((candidate) => candidate.name === agentName);
    if (agent) await this.closeTab(agent.tab_id);
  }

  async releaseAll(): Promise<void> {
    const prefix = this.agentPrefix();
    const listed = await runJson(
      this.herdrPath,
      ["agent", "list"],
      { cwd: this.repoPath, timeoutMs: 10_000 },
      HerdrAgentListEnvelopeSchema,
    );
    const tabIds = new Set(
      listed.result.agents
        .filter((agent) => agent.name?.startsWith(prefix))
        .map((agent) => agent.tab_id),
    );
    const failures: string[] = [];
    for (const tabId of tabIds) {
      try {
        await this.closeTab(tabId);
      } catch {
        failures.push(tabId);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Could not close Herdr tab(s): ${failures.join(", ")}`);
    }
  }

  private assertEnvironment(): void {
    if (process.env.HERDR_ENV !== "1") {
      throw new Error("Herdr runtime requires epicd to be launched inside Herdr (HERDR_ENV=1)");
    }
  }

  private async assertAgentAvailable(agentName: string, signal?: AbortSignal): Promise<void> {
    try {
      const observed = await this.observer.observe(agentName, undefined, signal);
      if (!observed.ready) throw new Error(`Herdr agent is not ready (${observed.state})`);
    } catch (error) {
      if (signal?.aborted) {
        await this.interrupt(agentName);
        throw abortReason(signal);
      }
      throw new Error(
        `Herdr agent ${agentName} is no longer available; restore that Herdr session before resuming`,
      );
    }
  }

  private async waitForReady(
    identity: NativeHerdrIdentity,
    options: RunTurnOptions,
  ): Promise<void> {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    let observedIdentity = identity;
    while (Date.now() < deadline) {
      const observed = await this.observer.observe(identity.name, observedIdentity, options.signal);
      observedIdentity = observed.identity;
      options.onEvent?.({
        type: "agent.lifecycle",
        sessionId: identity.name,
        state: observed.state,
        ready: observed.ready,
        sourceSequence: observed.sourceSequence,
      });
      if (observed.state === "blocked")
        throw new Error("Herdr agent requires approval or user input");
      if (observed.ready) return;
      await delay(1_000, undefined, { signal: options.signal });
    }
    throw new Error("Herdr turn timed out before becoming ready");
  }

  private async createAgent(role: AgentRole, settings: AgentRoleSettings): Promise<HerdrAgentId> {
    const workspaceId = process.env.HERDR_WORKSPACE_ID;
    if (!workspaceId) throw new Error("Herdr did not provide HERDR_WORKSPACE_ID");
    const agentName = this.agentName(role);
    const agentResultRoot = join(this.resultRoot, agentName);
    await mkdir(agentResultRoot, { recursive: true, mode: 0o700 });
    let paneId: string | undefined;
    try {
      const created = await runJson(
        this.herdrPath,
        [
          "tab",
          "create",
          "--workspace",
          workspaceId,
          "--cwd",
          this.repoPath,
          "--label",
          `epicd ${role} ${this.runId.slice(0, 8)}`,
          "--no-focus",
        ],
        { cwd: this.repoPath, timeoutMs: 30_000 },
        HerdrEnvelopeSchema,
      );
      paneId = created.result?.root_pane?.pane_id;
      if (!paneId) throw new Error("tab creation returned no root pane id");

      const permissionArgs =
        this.accessMode === "danger-full-access"
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : [
              "--sandbox",
              "workspace-write",
              "--ask-for-approval",
              "never",
              "--config",
              "sandbox_workspace_write.network_access=false",
            ];
      const args = [
        "agent",
        "start",
        agentName,
        "--kind",
        "codex",
        "--pane",
        paneId,
        "--timeout",
        "120000",
        "--",
        "--cd",
        this.repoPath,
        "--add-dir",
        agentResultRoot,
        ...permissionArgs,
        "--config",
        `model_reasoning_effort="${settings.reasoningEffort}"`,
      ];
      if (settings.model) args.push("--model", settings.model);
      await runCommand(this.herdrPath, args, { cwd: this.repoPath, timeoutMs: 150_000 });
      return agentName;
    } catch (error) {
      throw new Error(
        `Could not start Herdr ${role} agent${paneId ? ` in ${paneId}` : ""}: ${redactSensitiveText(safeErrorDetail(error))}`,
      );
    }
  }

  private agentName(role: AgentRole): HerdrAgentId {
    const roleCode = role === "orchestrator" ? "o" : role === "implementation" ? "i" : "r";
    return `${this.agentPrefix()}${roleCode}-${randomUUID().slice(0, 6)}` as HerdrAgentId;
  }

  private agentPrefix(): string {
    return `ed-${this.agentNamespace}-`;
  }

  private ownedAgentId(value: string): HerdrAgentId {
    const legacyPrefix = `ed-${safeName(this.runId).slice(0, 8)}-`;
    const isPersistedLegacyAgent = value.startsWith(legacyPrefix) && this.legacyAgentIds.has(value);
    if (!value.startsWith(this.agentPrefix()) && !isPersistedLegacyAgent) {
      throw new Error(`Refusing to close Herdr agent ${value}: it is not owned by this run`);
    }
    return value as HerdrAgentId;
  }

  private async closeTab(tabId: string): Promise<void> {
    await runCommand(this.herdrPath, ["tab", "close", tabId], {
      cwd: this.repoPath,
      timeoutMs: 10_000,
    });
  }

  private async interrupt(agentName: string): Promise<void> {
    try {
      await runCommand(this.herdrPath, ["agent", "send-keys", agentName, "ctrl+c"], {
        cwd: this.repoPath,
        timeoutMs: 10_000,
      });
    } catch {
      // Preserve the original abort reason; the agent may already have settled.
    }
  }
}

function resultContract(prompt: string, outputSchema: unknown, resultPath: string): string {
  const schema = JSON.stringify(outputSchema ?? { type: "object" });
  return `${prompt}

EPICD HERDR RESULT CONTRACT
You are running in a visible Herdr agent session. Complete the work normally, but do not rely on your terminal response as the machine-readable handoff.
Before ending this turn, write only the final JSON object to ${JSON.stringify(resultPath)}. It must conform exactly to this JSON Schema:
${schema}
Write it atomically: overwrite the pre-created mode-0600 file ${JSON.stringify(`${resultPath}.tmp`)}, then rename it to ${JSON.stringify(resultPath)}. The result directory is an epicd control directory outside the repository and is explicitly writable. Do not omit this file even when blocked.`;
}

function safeErrorDetail(error: unknown): string {
  if (error instanceof CommandError) return `command exited ${error.result.exitCode}`;
  return error instanceof Error ? error.name : "unknown error";
}

function safeName(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, "_") || "run";
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Herdr turn interrupted");
}
