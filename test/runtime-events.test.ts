import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { normalizeCodexEvent } from "../src/adapters/codex.js";
describe("runtime diagnostics, not approval evidence", () => {
  it("retains command identity and redacts credentials before exposing output", () => {
    expect(
      normalizeCodexEvent({
        type: "item.started",
        item: {
          type: "command_execution",
          id: "cmd",
          command: "npm test --token secret",
          status: "in_progress",
          aggregated_output: "",
        },
      }),
    ).toEqual({
      type: "command.started",
      sourceItemId: "cmd",
      command: "npm test --token [REDACTED]",
    });
    expect(
      normalizeCodexEvent({
        type: "item.completed",
        item: {
          type: "command_execution",
          id: "cmd",
          command: "npm test",
          status: "failed",
          exit_code: 1,
          aggregated_output: "password=hidden\nfailed",
        },
      }),
    ).toMatchObject({
      type: "command.completed",
      sourceItemId: "cmd",
      status: "failed",
      exitCode: 1,
      output: "password=[REDACTED]\nfailed",
    });
  });
  it("bounds multibyte diagnostics while preserving the beginning and failure tail", () => {
    const event = normalizeCodexEvent({
      type: "item.completed",
      item: {
        type: "command_execution",
        id: "cmd",
        command: "npm test",
        status: "failed",
        aggregated_output: "header\n" + "字".repeat(50_000) + "\nlast-error",
      },
    });
    if (event?.type !== "command.completed") throw new Error("Missing command event");
    expect(event.outputTruncated).toBe(true);
    expect(event.output).toContain("header");
    expect(event.output).toContain("last-error");
    expect(Buffer.byteLength(event.output!)).toBeLessThan(66_000);
  });
  it("does not convert a final agent message to a completion observation", () => {
    expect(
      normalizeCodexEvent({
        type: "item.completed",
        item: { type: "agent_message", id: "answer", text: "complete" },
      }),
    ).toBeNull();
    expect(normalizeCodexEvent({ type: "turn.completed" } as ThreadEvent)).toEqual({
      type: "turn.completed",
      usage: null,
    });
  });
  it("preserves detailed usage when reported and redacts failure messages", () => {
    expect(
      normalizeCodexEvent({
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 5,
          cache_write_input_tokens: 3,
          reasoning_output_tokens: 4,
        },
      }),
    ).toEqual({
      type: "turn.completed",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        cacheWriteInputTokens: 3,
        reasoningOutputTokens: 4,
      },
    });
    expect(
      normalizeCodexEvent({ type: "turn.failed", error: { message: "token=secret unavailable" } }),
    ).toEqual({ type: "turn.failed", message: "token=[REDACTED] unavailable" });
  });
});
