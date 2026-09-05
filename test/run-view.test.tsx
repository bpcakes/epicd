import { setImmediate } from "node:timers/promises";
import { cleanup, render } from "ink-testing-library";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInactiveAgentSessions,
  DEFAULT_AGENT_PREFERENCES,
  RunStateSchema,
  type AgentPreferences,
  type RunState,
} from "../src/domain/types.js";
import type { EpicEngine } from "../src/engine/engine.js";
import { AgentConfig, RunView } from "../src/tui/run-view.js";

afterEach(cleanup);

function props(onApply = vi.fn()): ComponentProps<typeof AgentConfig> {
  return {
    initialSettings: structuredClone(DEFAULT_AGENT_PREFERENCES),
    agentSessions: createInactiveAgentSessions(),
    fallbackModel: null,
    fallbackReasoningEffort: "high" as const,
    onApply,
    onCancel: vi.fn(),
    onInterrupt: vi.fn(),
    onPause: vi.fn(),
    onQuit: vi.fn(),
    error: null,
  };
}

async function input(view: ReturnType<typeof render>, value: string): Promise<void> {
  view.stdin.write(value);
  await setImmediate();
}

function runViewEngine(
  requestPause: () => void,
  configureFutureAgentSettings: (settings: AgentPreferences) => void = () => undefined,
): EpicEngine {
  const current = RunStateSchema.parse({
    runId: "run-view-test",
    agentNamespace: "0123456789abcdef0123",
    repoPath: "/repo",
    epicId: "epic-run-view",
    epicTitle: "Run view test",
    model: null,
    phase: "selecting",
    currentBeadId: null,
    currentBeadTitle: null,
    baseRevision: null,
    epicBaseRevision: "abc123",
    candidateRevision: null,
    completedTasks: 0,
    totalTasks: 1,
    reviewPass: 0,
    pendingFindings: [],
    recentOutcomes: [],
    lastReviewSummary: null,
    resumePhase: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const running = new Promise<RunState>(() => undefined);
  return {
    snapshot: () => current,
    recentEvents: () => [],
    onEvent: () => () => undefined,
    onState: () => () => undefined,
    run: () => running,
    resumeRun: () => running,
    requestPause,
    configureFutureAgentSettings,
  } as unknown as EpicEngine;
}

describe("AgentConfig", () => {
  it("handles role selection, effort changes, model editing, and save", async () => {
    const onApply = vi.fn<(settings: AgentPreferences) => void>();
    const view = render(<AgentConfig {...props(onApply)} />);
    await setImmediate();

    await input(view, "j");
    await input(view, "\u001B[C");
    await input(view, "m");
    await input(view, "gpt-implementation");
    await input(view, "\r");
    await input(view, "s");

    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply.mock.calls[0]?.[0].implementation).toEqual({
      model: "gpt-implementation",
      reasoningEffort: "xhigh",
    });
  });

  it("preserves a draft across equivalent state updates and resets on a real settings change", async () => {
    const initial = props();
    const view = render(<AgentConfig {...initial} />);
    await setImmediate();
    await input(view, "m");
    await input(view, "draft-model");

    view.rerender(
      <AgentConfig {...initial} initialSettings={structuredClone(initial.initialSettings)} />,
    );
    await setImmediate();
    expect(view.lastFrame()).toContain("draft-model▌");

    const changed = structuredClone(initial.initialSettings);
    changed.orchestrator.model = "externally-updated";
    view.rerender(<AgentConfig {...initial} initialSettings={changed} />);
    await setImmediate();

    expect(view.lastFrame()).toContain("externally-updated");
    expect(view.lastFrame()).not.toContain("draft-model");
    expect(view.lastFrame()).not.toContain("Editing model:");
  });
});

describe("RunView controller commands", () => {
  it("keeps the configuration editor dismissible if the run completes while it is open", async () => {
    const configure = vi.fn(() => {
      throw new Error("A completed run cannot create new agent threads");
    });
    const engine = runViewEngine(() => undefined, configure);
    let complete!: (state: RunState) => void;
    vi.spyOn(engine, "run").mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const view = render(<RunView engine={engine} />);
    await setImmediate();
    await input(view, "c");
    expect(view.lastFrame()).toContain("AGENT CONFIGURATION");
    complete({ ...engine.snapshot(), phase: "complete" });
    await setImmediate();
    await input(view, "s");
    expect(view.lastFrame()).toContain("A completed run cannot create new agent threads");
    await input(view, "\u001b");
    // Ink waits briefly to distinguish Escape from the start of a longer key sequence.
    await expect.poll(() => view.lastFrame()).not.toContain("AGENT CONFIGURATION");
    expect(view.lastFrame()).toContain("COMPLETE");
  });

  it("hands input to the configuration editor and saves its draft", async () => {
    const configureFutureAgentSettings = vi.fn<(settings: AgentPreferences) => void>();
    const view = render(
      <RunView engine={runViewEngine(() => undefined, configureFutureAgentSettings)} />,
    );
    await setImmediate();

    await input(view, "c");
    expect(view.lastFrame()).toContain("AGENT CONFIGURATION");

    await input(view, "x");
    await input(view, "r");
    await input(view, "s");

    expect(configureFutureAgentSettings).toHaveBeenCalledOnce();
    expect(configureFutureAgentSettings.mock.calls[0]?.[0].orchestrator).toEqual({
      model: null,
      reasoningEffort: null,
    });
    expect(view.lastFrame()).not.toContain("AGENT CONFIGURATION");
  });

  it.each(["p", "q"])("keeps the TUI active when %s cannot request a pause", async (key) => {
    const requestPause = vi.fn(() => {
      throw new Error("controller lease changed");
    });
    const view = render(<RunView engine={runViewEngine(requestPause)} />);
    await setImmediate();

    await input(view, key);

    expect(requestPause).toHaveBeenCalledOnce();
    expect(view.lastFrame()).toContain("controller lease changed");
    expect(view.lastFrame()).toContain("Inspect persisted status before retrying");
  });
});
