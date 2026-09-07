export type RuntimeEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "command.started"; sourceItemId: string; command: string }
  | {
      type: "command.completed";
      command: string;
      status: "completed" | "failed";
      exitCode?: number;
      sourceItemId?: string;
      output?: string;
      outputTruncated?: boolean;
    }
  | { type: "files.changed"; paths: string[]; sourceItemId?: string }
  | { type: "error"; message: string; sourceItemId?: string }
  | { type: "turn.completed"; usage: TurnUsage | null }
  | { type: "turn.failed"; message: string }
  | {
      type: "agent.lifecycle";
      sessionId: string;
      state: "idle" | "working" | "blocked" | "done" | "unknown";
      ready: boolean;
      sourceSequence: number | null;
    };

export type TurnUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
};
