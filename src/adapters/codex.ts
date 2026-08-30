import { Codex, type Thread, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import type {
  AgentRole,
  AgentRuntime,
  AgentSession,
  RunTurnOptions,
  RuntimeAgentSettings,
  RuntimeEvent,
  TurnExecution,
} from "./runtime.js";

export class CodexRuntime implements AgentRuntime {
  private readonly codex: Codex;

  constructor(
    private readonly repoPath: string,
    private readonly settings: RuntimeAgentSettings,
    codexPath?: string,
  ) {
    this.codex = new Codex(codexPath ? { codexPathOverride: codexPath } : undefined);
  }

  start(role: AgentRole): AgentSession {
    return { id: null, role, handle: this.codex.startThread(this.threadOptions(role)) };
  }

  resume(threadId: string, role: AgentRole): AgentSession {
    return {
      id: threadId,
      role,
      handle: this.codex.resumeThread(threadId, this.threadOptions(role)),
    };
  }

  private threadOptions(role: AgentRole): ThreadOptions {
    const settings = this.settings[role];
    const common: ThreadOptions = {
      workingDirectory: this.repoPath,
      approvalPolicy: "never",
      sandboxMode: role === "orchestrator" ? "read-only" : "workspace-write",
      modelReasoningEffort: settings.reasoningEffort,
      threadSource: `epicd-${role}`,
      networkAccessEnabled: false,
    };
    if (settings.model) common.model = settings.model;
    return common;
  }

  async run(
    session: AgentSession,
    prompt: string,
    options: RunTurnOptions = {},
  ): Promise<TurnExecution> {
    const thread = session.handle as Thread;
    const turnOptions: { outputSchema?: unknown; signal?: AbortSignal } = {};
    if (options.outputSchema !== undefined) turnOptions.outputSchema = options.outputSchema;
    if (options.signal !== undefined) turnOptions.signal = options.signal;

    const streamed = await thread.runStreamed(prompt, turnOptions);
    let finalResponse = "";
    for await (const event of streamed.events) {
      const normalized = normalizeEvent(event);
      if (normalized) options.onEvent?.(normalized);
      if (event.type === "item.completed" && event.item.type === "agent_message") {
        finalResponse = event.item.text;
      }
      if (event.type === "turn.failed") throw new Error(event.error.message);
      if (event.type === "error") throw new Error(event.message);
    }

    if (!thread.id) throw new Error("Codex turn completed without a persistent thread id");
    if (!finalResponse.trim()) throw new Error("Codex turn completed without a final response");
    return { sessionId: thread.id, finalResponse };
  }
}

function normalizeEvent(event: ThreadEvent): RuntimeEvent | null {
  if (event.type === "thread.started") {
    return { type: "session.started", sessionId: event.thread_id };
  }
  if (event.type !== "item.completed") return null;
  const item = event.item;
  if (item.type === "command_execution") {
    return {
      type: "command.completed",
      command: item.command,
      status: item.status === "failed" ? "failed" : "completed",
      ...(item.exit_code === undefined ? {} : { exitCode: item.exit_code }),
    };
  }
  if (item.type === "file_change") {
    return { type: "files.changed", paths: item.changes.map((change) => change.path) };
  }
  if (item.type === "error") return { type: "error", message: item.message };
  return null;
}
