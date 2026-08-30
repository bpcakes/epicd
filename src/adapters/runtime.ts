import type { AgentSettings } from "../domain/types.js";

export type AgentRole = "orchestrator" | "implementation" | "review";

export type RuntimeAgentSettings = AgentSettings;

export type AgentSession = {
  id: string | null;
  role: AgentRole;
  handle: unknown;
};

export type RuntimeEvent =
  | { type: "session.started"; sessionId: string }
  | {
      type: "command.completed";
      command: string;
      status: "completed" | "failed";
      exitCode?: number;
    }
  | { type: "files.changed"; paths: string[] }
  | { type: "error"; message: string };

export type TurnExecution = {
  sessionId: string;
  finalResponse: string;
};

export type RunTurnOptions = {
  outputSchema?: unknown;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: RuntimeEvent) => void) | undefined;
};

export interface AgentRuntime {
  start(role: AgentRole): AgentSession;
  resume(sessionId: string, role: AgentRole): AgentSession;
  run(session: AgentSession, prompt: string, options?: RunTurnOptions): Promise<TurnExecution>;
}
