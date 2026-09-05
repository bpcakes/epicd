import type {
  AgentAccessMode,
  AgentRole,
  AgentRoleSettings,
  HerdrAgentSessionContract,
  RuntimeKind,
  SdkAgentSessionContract,
} from "../domain/types.js";

export type { AgentRole } from "../domain/types.js";

export type AgentRuntimeBaseOptions = {
  repoPath: string;
  accessMode: AgentAccessMode;
};

declare const herdrAgentIdBrand: unique symbol;
export type HerdrAgentId = string & { readonly [herdrAgentIdBrand]: "HerdrAgentId" };

export type SdkAgentSession = {
  runtime: "sdk";
  id: string | null;
  role: AgentRole;
};

export type HerdrAgentSession = {
  runtime: "herdr";
  id: HerdrAgentId | null;
  role: AgentRole;
};

export type AgentSession = SdkAgentSession | HerdrAgentSession;

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

export type AgentSessionContractFor<Kind extends RuntimeKind> = Kind extends "sdk"
  ? SdkAgentSessionContract
  : HerdrAgentSessionContract;

export type AgentSessionSpec<Kind extends RuntimeKind = RuntimeKind> =
  | { kind: "new"; settings: AgentRoleSettings; contract?: never }
  | {
      kind: "new";
      settings?: never;
      contract: AgentSessionContractFor<Kind>;
    }
  | { kind: "existing"; sessionId: string; contract: AgentSessionContractFor<Kind> };

export type OpenedAgentSession<Kind extends RuntimeKind = RuntimeKind> = Kind extends "sdk"
  ? {
      readonly runtime: "sdk";
      readonly session: SdkAgentSession;
      readonly contract: SdkAgentSessionContract;
    }
  : {
      readonly runtime: "herdr";
      readonly session: HerdrAgentSession;
      readonly contract: HerdrAgentSessionContract;
    };

// Distribute over backend kinds: a selected runtime is a union of complete, correlated APIs.
export type AgentRuntime<Kind extends RuntimeKind = RuntimeKind> = Kind extends RuntimeKind
  ? AgentRuntimeFor<Kind>
  : never;

interface AgentRuntimeFor<Kind extends RuntimeKind> {
  readonly kind: Kind;
  /** Resolves the immutable execution contract before a resource-free handle is opened. */
  prepareNewSession: (
    role: AgentRole,
    settings: AgentRoleSettings,
    previous?: AgentSessionContractFor<Kind>,
    signal?: AbortSignal,
  ) => Promise<AgentSessionContractFor<Kind>>;
  /**
   * Opens a resource-free runtime handle. New callers may supply settings as a convenience, but
   * orchestration prepares and pins the contract first so retries never create remote resources.
   */
  open: (
    role: AgentRole,
    spec: AgentSessionSpec<Kind>,
    signal?: AbortSignal,
  ) => Promise<OpenedAgentSession<Kind>>;
  run: (
    opened: OpenedAgentSession<Kind>,
    prompt: string,
    options?: RunTurnOptions,
  ) => Promise<TurnExecution>;
  release(sessionId: string): Promise<void>;
  releaseAll(): Promise<void>;
}
