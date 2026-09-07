import { Codex, type Thread, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import type {
  AgentRole,
  AgentRuntime,
  AgentRuntimeBaseOptions,
  AgentSessionSpec,
  OpenedAgentSession,
  RunTurnOptions,
  RuntimeEvent,
  SdkAgentSession,
  TurnExecution,
  TurnUsage,
} from "./runtime.js";
import { redactSensitiveText, redactDiagnosticText } from "../util/redact.js";
import { runtimeCapabilities } from "./runtime-capabilities.js";
import {
  AgentRoleSettingsSchema,
  SdkAgentSessionContractSchema,
  type AgentRoleSettings,
  type ResolvedAgentRoleSettings,
  type SdkAgentSessionContract,
} from "../domain/types.js";
import {
  codexProcessEnvironment,
  resolveCodexExecutable,
  resolveCodexModel,
} from "./codex-settings.js";

export type CodexRuntimeOptions = AgentRuntimeBaseOptions & {
  codexPath?: string | undefined;
};

export class CodexRuntime implements AgentRuntime<"sdk"> {
  readonly kind = "sdk";
  private readonly threads = new WeakMap<SdkAgentSession, Thread>();
  private readonly activeThreads = new WeakSet<Thread>();
  private readonly activeSessionIds = new Set<string>();

  private readonly repoPath: string;
  private readonly codexPath: string | undefined;
  private readonly accessMode: CodexRuntimeOptions["accessMode"];

  constructor(options: CodexRuntimeOptions) {
    this.repoPath = options.repoPath;
    this.codexPath = options.codexPath;
    this.accessMode = options.accessMode;
  }

  capabilities() {
    return runtimeCapabilities(this.kind);
  }

  private createClient(): Codex {
    if (this.codexPath === undefined) return new Codex();
    const executable = resolveCodexExecutable(this.codexPath);
    return new Codex({
      codexPathOverride: executable.executablePath,
      env: codexProcessEnvironment(),
    });
  }

  private async resolveDefaultModel(signal?: AbortSignal): Promise<string> {
    return await resolveCodexModel(this.repoPath, {
      executable: resolveCodexExecutable(this.codexPath),
      ...(signal ? { signal } : {}),
    });
  }

  async prepareNewSession(
    _role: AgentRole,
    settings: AgentRoleSettings,
    previous?: SdkAgentSessionContract,
    signal?: AbortSignal,
  ): Promise<SdkAgentSessionContract> {
    // Own the requested values before model discovery yields to caller code.
    const requested = AgentRoleSettingsSchema.parse(settings);
    const cachedDefault =
      requested.model === null && previous?.requested.model === null
        ? previous.effective.model
        : null;
    const model = requested.model ?? cachedDefault ?? (await this.resolveDefaultModel(signal));
    return SdkAgentSessionContractSchema.parse({
      runtime: "sdk",
      requested,
      effective: { ...requested, model },
    });
  }

  async open(
    role: AgentRole,
    spec: AgentSessionSpec<"sdk">,
    signal?: AbortSignal,
  ): Promise<OpenedAgentSession<"sdk">> {
    const session: SdkAgentSession = {
      runtime: "sdk",
      id: spec.kind === "existing" ? spec.sessionId : null,
      role,
    };
    const contract =
      spec.kind === "new" && "settings" in spec
        ? await this.prepareNewSession(role, spec.settings, undefined, signal)
        : SdkAgentSessionContractSchema.parse(spec.contract);
    const options = this.threadOptions(role, contract.effective);
    const codex = this.createClient();
    const thread =
      spec.kind === "existing"
        ? codex.resumeThread(spec.sessionId, options)
        : codex.startThread(options);
    this.threads.set(session, thread);
    return Object.freeze({
      runtime: "sdk",
      session,
      contract,
    });
  }

  private threadOptions(role: AgentRole, settings: ResolvedAgentRoleSettings): ThreadOptions {
    return {
      model: settings.model,
      modelReasoningEffort: settings.reasoningEffort,
      workingDirectory: this.repoPath,
      approvalPolicy: "never",
      sandboxMode:
        this.accessMode === "danger-full-access"
          ? "danger-full-access"
          : role === "orchestrator"
            ? "read-only"
            : "workspace-write",
      threadSource: `epicd-${role}`,
      networkAccessEnabled: this.accessMode === "danger-full-access",
    };
  }

  async run(
    opened: OpenedAgentSession<"sdk">,
    prompt: string,
    options: RunTurnOptions = {},
  ): Promise<TurnExecution> {
    if (opened.runtime !== "sdk") {
      throw new Error("Codex runtime received a non-SDK session");
    }
    const thread = this.threads.get(opened.session);
    if (!thread) throw new Error("Codex runtime received a session it did not create");
    if (this.activeThreads.has(thread) || (thread.id && this.activeSessionIds.has(thread.id))) {
      throw new Error("Codex session already has an active turn");
    }
    options.signal?.throwIfAborted();
    this.activeThreads.add(thread);
    let activeSessionId = thread.id;
    if (activeSessionId) this.activeSessionIds.add(activeSessionId);
    try {
      return await this.runThread(thread, prompt, options, (sessionId) => {
        if (sessionId !== activeSessionId && this.activeSessionIds.has(sessionId)) {
          throw new Error("Codex provider returned an already-active session");
        }
        if (activeSessionId) this.activeSessionIds.delete(activeSessionId);
        activeSessionId = sessionId;
        this.activeSessionIds.add(sessionId);
        opened.session.id = sessionId;
      });
    } finally {
      this.activeThreads.delete(thread);
      if (activeSessionId) this.activeSessionIds.delete(activeSessionId);
    }
  }

  private async runThread(
    thread: Thread,
    prompt: string,
    options: RunTurnOptions,
    onSession: (sessionId: string) => void,
  ): Promise<TurnExecution> {
    const turnOptions: { outputSchema?: unknown; signal?: AbortSignal } = {};
    if (options.outputSchema !== undefined) turnOptions.outputSchema = options.outputSchema;
    if (options.signal !== undefined) turnOptions.signal = options.signal;

    const streamed = await thread.runStreamed(prompt, turnOptions);
    let finalResponse = "";
    let usage: TurnUsage | null = null;
    let completed = false;
    for await (const event of streamed.events) {
      if (event.type === "thread.started") onSession(event.thread_id);
      const normalized = normalizeCodexEvent(event);
      if (normalized) options.onEvent?.(normalized);
      if (normalized?.type === "turn.completed") {
        usage = normalized.usage;
        completed = true;
      }
      if (event.type === "item.completed" && event.item.type === "agent_message") {
        finalResponse = event.item.text;
      }
      if (event.type === "turn.failed") throw new Error(redactSensitiveText(event.error.message));
      if (event.type === "error") throw new Error(redactSensitiveText(event.message));
    }

    options.signal?.throwIfAborted();
    if (!completed) throw new Error("Codex event stream ended without turn completion");
    if (!thread.id) throw new Error("Codex turn completed without a persistent thread id");
    if (!finalResponse.trim()) throw new Error("Codex turn completed without a final response");
    return { sessionId: thread.id, finalResponse, usage };
  }

  async release(_sessionId: string): Promise<void> {
    // SDK threads do not own visible terminal resources.
  }

  async releaseAll(): Promise<void> {
    // SDK threads do not own visible terminal resources.
  }
}

export function normalizeCodexEvent(event: ThreadEvent): RuntimeEvent | null {
  if (event.type === "thread.started") {
    return { type: "session.started", sessionId: event.thread_id };
  }
  if (event.type === "turn.completed") {
    return {
      type: "turn.completed",
      usage: event.usage
        ? {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            outputTokens: event.usage.output_tokens,
            ...(event.usage.cache_write_input_tokens === undefined
              ? {}
              : { cacheWriteInputTokens: event.usage.cache_write_input_tokens }),
            ...(event.usage.reasoning_output_tokens === undefined
              ? {}
              : { reasoningOutputTokens: event.usage.reasoning_output_tokens }),
          }
        : null,
    };
  }
  if (event.type === "turn.failed") {
    return { type: "turn.failed", message: redactDiagnosticText(event.error.message) };
  }
  if (event.type === "error") {
    return { type: "error", message: redactDiagnosticText(event.message) };
  }
  if (event.type === "item.started" && event.item.type === "command_execution") {
    return {
      type: "command.started",
      sourceItemId: event.item.id,
      command: redactDiagnosticText(event.item.command),
    };
  }
  if (event.type !== "item.completed") return null;
  const item = event.item;
  if (item.type === "command_execution") {
    const output = Buffer.from(redactDiagnosticText(item.aggregated_output), "utf8");
    const outputLimit = 64 * 1024;
    const outputTruncated = output.length > outputLimit;
    return {
      type: "command.completed",
      command: redactDiagnosticText(item.command),
      status: item.status === "failed" ? "failed" : "completed",
      sourceItemId: item.id,
      output: outputTruncated
        ? `${output.subarray(0, outputLimit / 2).toString("utf8")}\n[output omitted]\n${output.subarray(-outputLimit / 2).toString("utf8")}`
        : output.toString("utf8"),
      outputTruncated,
      ...(item.exit_code === undefined ? {} : { exitCode: item.exit_code }),
    };
  }
  if (item.type === "file_change") {
    return {
      type: "files.changed",
      paths: item.changes.map((change) => change.path),
      sourceItemId: item.id,
    };
  }
  if (item.type === "error") {
    return { type: "error", message: redactDiagnosticText(item.message), sourceItemId: item.id };
  }
  return null;
}
