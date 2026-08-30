import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
  AgentRole,
  AgentRuntime,
  AgentSession,
  HerdrAgentSession,
  RunTurnOptions,
  RuntimeAgentSettings,
  TurnExecution,
} from "./runtime.js";
import { CommandError, runCommand, runJson } from "../util/command.js";
import { redactSensitiveText } from "../util/redact.js";

const HerdrEnvelopeSchema = z.object({
  ok: z.boolean().optional(),
  result: z
    .object({
      root_pane: z.object({ pane_id: z.string().min(1).optional() }).optional(),
    })
    .optional(),
});

const TURN_TIMEOUT_MS = 6 * 60 * 60 * 1_000;

export class HerdrRuntime implements AgentRuntime {
  private readonly resultRoot: string;

  constructor(
    private readonly repoPath: string,
    private readonly runId: string,
    private readonly settings: RuntimeAgentSettings,
    private readonly herdrPath = "herdr",
  ) {
    const stateRoot = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    this.resultRoot = join(stateRoot, "epicd", "herdr", safeName(runId));
  }

  start(role: AgentRole): HerdrAgentSession {
    return { runtime: "herdr", id: null, role };
  }

  resume(sessionId: string, role: AgentRole): HerdrAgentSession {
    return {
      runtime: "herdr",
      id: sessionId,
      role,
    };
  }

  async run(
    session: AgentSession,
    prompt: string,
    options: RunTurnOptions = {},
  ): Promise<TurnExecution> {
    if (session.runtime !== "herdr") throw new Error("Herdr runtime received a non-Herdr session");
    this.assertEnvironment();
    await mkdir(this.resultRoot, { recursive: true, mode: 0o700 });

    let agentName = session.id;
    if (agentName) await this.assertAgentAvailable(agentName, options.signal);
    else {
      agentName = await this.createAgent(session.role);
      session.id = agentName;
      options.onEvent?.({ type: "session.started", sessionId: agentName });
    }
    await this.cleanOrphanedArtifacts();

    const resultPath = join(this.resultRoot, `${randomUUID()}.json`);
    await writeFile(`${resultPath}.tmp`, "", { mode: 0o600 });
    const fullPrompt = resultContract(prompt, options.outputSchema, resultPath);
    try {
      await runCommand(
        this.herdrPath,
        ["agent", "prompt", agentName, fullPrompt, "--wait", "--timeout", String(TURN_TIMEOUT_MS)],
        {
          cwd: this.repoPath,
          timeoutMs: TURN_TIMEOUT_MS + 30_000,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
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
    return { sessionId: agentName, finalResponse };
  }

  private assertEnvironment(): void {
    if (process.env.HERDR_ENV !== "1") {
      throw new Error("Herdr runtime requires epicd to be launched inside Herdr (HERDR_ENV=1)");
    }
  }

  private async assertAgentAvailable(agentName: string, signal?: AbortSignal): Promise<void> {
    try {
      await runCommand(this.herdrPath, ["agent", "get", agentName], {
        cwd: this.repoPath,
        timeoutMs: 10_000,
      });
      await runCommand(
        this.herdrPath,
        ["agent", "wait", agentName, "--timeout", String(TURN_TIMEOUT_MS)],
        {
          cwd: this.repoPath,
          timeoutMs: TURN_TIMEOUT_MS + 30_000,
          ...(signal ? { signal } : {}),
        },
      );
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

  private async cleanOrphanedArtifacts(): Promise<void> {
    for (const entry of await readdir(this.resultRoot)) {
      if (entry.endsWith(".json") || entry.endsWith(".json.tmp")) {
        await rm(join(this.resultRoot, entry), { force: true });
      }
    }
  }

  private async createAgent(role: AgentRole): Promise<string> {
    const workspaceId = process.env.HERDR_WORKSPACE_ID;
    if (!workspaceId) throw new Error("Herdr did not provide HERDR_WORKSPACE_ID");
    const agentName = this.agentName(role);
    const settings = this.settings[role];
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
        this.resultRoot,
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
        "--config",
        `model_reasoning_effort="${settings.reasoningEffort}"`,
        "--config",
        "sandbox_workspace_write.network_access=false",
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

  private agentName(role: AgentRole): string {
    const roleCode = role === "orchestrator" ? "o" : role === "implementation" ? "i" : "r";
    return `ed-${safeName(this.runId).slice(0, 8)}-${roleCode}-${randomUUID().slice(0, 6)}`;
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
