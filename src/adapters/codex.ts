import type { ThreadEvent } from "@openai/codex-sdk";
import type { RuntimeEvent } from "./runtime.js";
import { redactDiagnosticText } from "../util/redact.js";

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
