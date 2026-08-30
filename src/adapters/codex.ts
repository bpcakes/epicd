import { Codex, type Thread, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import type {
  AgentRole,
  AgentRuntime,
  AgentRuntimeBaseOptions,
  AgentSession,
  RunTurnOptions,
  RuntimeAgentSettings,
  RuntimeEvent,
  SdkAgentSession,
  TurnExecution,
} from "./runtime.js";

export type CodexRuntimeOptions = AgentRuntimeBaseOptions & {
  codexPath?: string | undefined;
};

export class CodexRuntime implements AgentRuntime {
  private readonly codex: Codex;
  private readonly threads = new WeakMap<SdkAgentSession, Thread>();

  private readonly repoPath: string;
  private readonly settings: RuntimeAgentSettings;
  private readonly accessMode: CodexRuntimeOptions["accessMode"];

  constructor(options: CodexRuntimeOptions) {
    this.repoPath = options.repoPath;
    this.settings = options.settings;
    this.accessMode = options.accessMode;
    this.codex = new Codex(
      options.codexPath ? { codexPathOverride: options.codexPath } : undefined,
    );
  }

  start(role: AgentRole): SdkAgentSession {
    const session: SdkAgentSession = { runtime: "sdk", id: null, role };
    this.threads.set(session, this.codex.startThread(this.threadOptions(role)));
    return session;
  }

  resume(threadId: string, role: AgentRole): SdkAgentSession {
    const session: SdkAgentSession = { runtime: "sdk", id: threadId, role };
    this.threads.set(session, this.codex.resumeThread(threadId, this.threadOptions(role)));
    return session;
  }

  private threadOptions(role: AgentRole): ThreadOptions {
    const settings = this.settings[role];
    const common: ThreadOptions = {
      workingDirectory: this.repoPath,
      approvalPolicy: "never",
      sandboxMode:
        this.accessMode === "danger-full-access"
          ? "danger-full-access"
          : role === "orchestrator"
            ? "read-only"
            : "workspace-write",
      modelReasoningEffort: settings.reasoningEffort,
      threadSource: `epicd-${role}`,
      networkAccessEnabled: this.accessMode === "danger-full-access",
    };
    if (settings.model) common.model = settings.model;
    return common;
  }

  async run(
    session: AgentSession,
    prompt: string,
    options: RunTurnOptions = {},
  ): Promise<TurnExecution> {
    if (session.runtime !== "sdk") throw new Error("Codex runtime received a non-SDK session");
    const thread = this.threads.get(session);
    if (!thread) throw new Error("Codex runtime received a session it did not create");
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

  async release(_sessionId: string): Promise<void> {
    // SDK threads do not own visible terminal resources.
  }

  async releaseAll(): Promise<void> {
    // SDK threads do not own visible terminal resources.
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
