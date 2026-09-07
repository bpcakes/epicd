import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { RuntimeEvent } from "../src/adapters/runtime.js";

const fake = vi.hoisted(() => ({
  stream: null as (() => AsyncGenerator<ThreadEvent>) | null,
  options: [] as unknown[],
}));
vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    startThread(options: unknown) {
      fake.options.push(options);
      return { id: "thread", runStreamed: async () => ({ events: fake.stream!() }) };
    }
    resumeThread(_id: string, options: unknown) {
      return this.startThread(options);
    }
  },
}));
import { CodexRuntime } from "../src/adapters/codex.js";
import {
  requireAdaptiveRuntimeCapabilities,
  runtimeCapabilities,
} from "../src/adapters/runtime-capabilities.js";
import {
  ADAPTIVE_ORCHESTRATOR_MODEL,
  DEFAULT_AGENT_PREFERENCES,
  resolveAdaptiveAgentRoleSettings,
} from "../src/domain/types.js";

const final: ThreadEvent = {
  type: "item.completed",
  item: { type: "agent_message", id: "answer", text: '{"action":"inspect_run"}' },
};
const completed: ThreadEvent = {
  type: "turn.completed",
  usage: {
    input_tokens: 10,
    cached_input_tokens: 2,
    cache_write_input_tokens: 3,
    output_tokens: 4,
    reasoning_output_tokens: 1,
  },
};

beforeEach(() => {
  fake.options.length = 0;
  fake.stream = null;
});

async function session() {
  const runtime = new CodexRuntime({ repoPath: "/repo", accessMode: "sandboxed" });
  const settings = resolveAdaptiveAgentRoleSettings(
    {
      model: "worker-model",
      reasoningEffort: null,
      agentSettings: structuredClone(DEFAULT_AGENT_PREFERENCES),
    },
    "orchestrator",
  );
  const opened = await runtime.open("orchestrator", { kind: "new", settings });
  return { runtime, opened };
}

describe("SDK turn observations and control", () => {
  it.each(["sdk", "herdr"] as const)(
    "does not admit %s until the agent isolation/recovery contract is wired",
    (runtime) => {
      const capabilities = runtimeCapabilities(runtime);
      expect(capabilities.confirmedInterruption.status).toBe("unavailable");
      expect(() => requireAdaptiveRuntimeCapabilities(capabilities)).toThrow(
        "not ready for adaptive admission",
      );
    },
  );
  it("delivers a command-start observation while the turn remains active", async () => {
    let continueTurn!: () => void;
    const barrier = new Promise<void>((resolve) => {
      continueTurn = resolve;
    });
    fake.stream = async function* () {
      yield { type: "thread.started", thread_id: "thread" };
      yield {
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test --token secret",
          aggregated_output: "",
          status: "in_progress",
        },
      };
      await barrier;
      yield {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test --token secret",
          aggregated_output: "password=hidden\nfailed test",
          status: "failed",
          exit_code: 1,
        },
      };
      yield final;
      yield completed;
    };
    const { runtime, opened } = await session();
    const events: RuntimeEvent[] = [];
    let finished = false;
    const pending = runtime
      .run(opened, "Inspect the failure", {
        onEvent: (event) => {
          events.push(event);
        },
      })
      .then((value) => {
        finished = true;
        return value;
      });
    await expect.poll(() => events.some((event) => event.type === "command.started")).toBe(true);
    expect(finished).toBe(false);
    await expect(runtime.run(opened, "Concurrent turn")).rejects.toThrow("active turn");
    const duplicate = await runtime.open("orchestrator", {
      kind: "existing",
      sessionId: "thread",
      contract: opened.contract,
    });
    await expect(runtime.run(duplicate, "Same provider session")).rejects.toThrow("active turn");
    continueTurn();
    const result = await pending;
    expect(events).toContainEqual({
      type: "command.started",
      sourceItemId: "cmd-1",
      command: "npm test --token [REDACTED]",
    });
    expect(events).toContainEqual({
      type: "command.completed",
      sourceItemId: "cmd-1",
      command: "npm test --token [REDACTED]",
      status: "failed",
      exitCode: 1,
      output: "password=[REDACTED]\nfailed test",
      outputTruncated: false,
    });
    expect(result.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 3,
      outputTokens: 4,
      reasoningOutputTokens: 1,
    });
    expect(fake.options[0]).toMatchObject({
      model: ADAPTIVE_ORCHESTRATOR_MODEL,
      modelReasoningEffort: "high",
    });
  });

  it("does not mistake a final message for a completed turn", async () => {
    fake.stream = async function* () {
      yield final;
    };
    const { runtime, opened } = await session();
    await expect(runtime.run(opened, "Inspect")).rejects.toThrow("without turn completion");
  });

  it("bounds multibyte diagnostics and retains both the failure header and tail", async () => {
    fake.stream = async function* () {
      yield {
        type: "item.completed",
        item: {
          id: "large-command",
          type: "command_execution",
          command: "npm test",
          aggregated_output: `header\n${"字".repeat(50_000)}\nlast-error`,
          status: "failed",
          exit_code: 1,
        },
      };
      yield final;
      yield completed;
    };
    const { runtime, opened } = await session();
    const events: RuntimeEvent[] = [];
    await runtime.run(opened, "Inspect", {
      onEvent: (event) => {
        events.push(event);
      },
    });
    const command = events.find((event) => event.type === "command.completed");
    expect(command?.outputTruncated).toBe(true);
    expect(command?.output).toContain("header");
    expect(command?.output).toContain("last-error");
    expect(Buffer.byteLength(command?.output ?? "")).toBeLessThan(66_000);
  });

  it("publishes a redacted failure before rejecting, without accepting the preceding message", async () => {
    fake.stream = async function* () {
      yield final;
      yield { type: "turn.failed", error: { message: "token=secret service unavailable" } };
    };
    const { runtime, opened } = await session();
    const events: RuntimeEvent[] = [];
    await expect(
      runtime.run(opened, "Inspect", {
        onEvent: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toThrow("token=[REDACTED] service unavailable");
    expect(events).toContainEqual({
      type: "turn.failed",
      message: "token=[REDACTED] service unavailable",
    });
  });

  it("rejects a late completion after cancellation", async () => {
    const controller = new AbortController();
    fake.stream = async function* () {
      controller.abort(new Error("cancelled"));
      yield final;
      yield completed;
    };
    const { runtime, opened } = await session();
    await expect(runtime.run(opened, "Inspect", { signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
  });

  it("represents absent usage as unknown, not zero", async () => {
    // Exercise the untyped protocol boundary used by older native executables.
    fake.stream = async function* () {
      yield final;
      yield { type: "turn.completed" } as ThreadEvent;
    };
    const { runtime, opened } = await session();
    expect((await runtime.run(opened, "Inspect")).usage).toBeNull();
  });
});

describe("adaptive coordinator settings", () => {
  it("keeps worker inheritance independent and resolves a coordinator reset to Astra", () => {
    const source = {
      model: "worker-model",
      reasoningEffort: null,
      agentSettings: structuredClone(DEFAULT_AGENT_PREFERENCES),
    };
    expect(resolveAdaptiveAgentRoleSettings(source, "orchestrator")).toEqual({
      model: "gpt-6-astra",
      reasoningEffort: "high",
    });
    expect(resolveAdaptiveAgentRoleSettings(source, "implementation")).toEqual({
      model: "worker-model",
      reasoningEffort: "high",
    });
  });

  it.each(["minimal", "ultra", "persistent"] as const)(
    "rejects unsupported coordinator effort %s without changing worker settings",
    (effort) => {
      const source = {
        model: "worker-model",
        reasoningEffort: effort,
        agentSettings: structuredClone(DEFAULT_AGENT_PREFERENCES),
      };
      expect(() => resolveAdaptiveAgentRoleSettings(source, "orchestrator")).toThrow(
        "supports reasoning efforts",
      );
      expect(resolveAdaptiveAgentRoleSettings(source, "review").reasoningEffort).toBe(effort);
    },
  );

  it("rejects an explicit different coordinator model", () => {
    const source = {
      model: null,
      reasoningEffort: null,
      agentSettings: {
        ...structuredClone(DEFAULT_AGENT_PREFERENCES),
        orchestrator: { model: "other-model", reasoningEffort: null },
      },
    };
    expect(() => resolveAdaptiveAgentRoleSettings(source, "orchestrator")).toThrow(
      "requires gpt-6-astra",
    );
  });
});
