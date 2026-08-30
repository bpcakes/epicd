import type { EventLevel, RunPhase } from "../domain/types.js";

export const phaseLabels: Record<RunPhase, string> = {
  preparing: "Preparing",
  selecting: "Selecting",
  claiming: "Claiming",
  implementing: "Implementing",
  reviewing: "Reviewing",
  fixing: "Fixing",
  committing: "Committing",
  verifying: "Verifying",
  closing: "Closing",
  final_review: "Epic review",
  paused: "Paused",
  blocked: "Needs attention",
  complete: "Complete",
};

export const phaseColors: Record<RunPhase, string> = {
  preparing: "gray",
  selecting: "cyan",
  claiming: "blue",
  implementing: "magenta",
  reviewing: "yellow",
  fixing: "yellow",
  committing: "blue",
  verifying: "cyan",
  closing: "blue",
  final_review: "cyan",
  paused: "gray",
  blocked: "red",
  complete: "green",
};

export const eventSymbols: Record<EventLevel, string> = {
  debug: "·",
  info: "◆",
  success: "✓",
  warning: "!",
  error: "×",
};

export const eventColors: Record<EventLevel, string> = {
  debug: "gray",
  info: "cyan",
  success: "green",
  warning: "yellow",
  error: "red",
};

export function shortId(value: string | null, length = 12): string {
  return value ? value.slice(0, length) : "—";
}

export function progressBar(done: number, total: number, width: number): string {
  if (total <= 0) return "░".repeat(width);
  const filled = Math.min(width, Math.round((done / total) * width));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
