import { describe, expect, it, vi } from "vitest";
import { RunAlreadyControlledError } from "../src/adapters/store.js";
import { RunStateSchema } from "../src/domain/types.js";
import {
  AgentCleanupRequiredError,
  WorkflowCompletionReportingError,
} from "../src/engine/errors.js";
import {
  canRequestPause,
  ControllerOperationGate,
  controllerFailureMessage,
  epicRunConflictMessage,
  isControllerIdlePhase,
  launchHeadlessController,
  observeControllerOperation,
  performControllerCommand,
  shouldExitAfterController,
} from "../src/controller.js";

const state = RunStateSchema.parse({
  runId: "controller-test",
  agentNamespace: "0123456789abcdef0123",
  repoPath: "/repo",
  epicId: "epic",
  epicTitle: "Epic",
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

describe("TUI controller operation observation", () => {
  it("publishes a completed controller state without reporting an error", async () => {
    const onState = vi.fn();
    const onError = vi.fn();

    await observeControllerOperation(Promise.resolve(state), onState, onError);

    expect(onState).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledWith(state);
    expect(onError).not.toHaveBeenCalled();
  });

  it("runs only one controller operation at a time", async () => {
    const gate = new ControllerOperationGate();
    const onState = vi.fn();
    const onError = vi.fn();
    const onBusyChange = vi.fn();
    let finish: ((value: typeof state) => void) | undefined;
    const first = new Promise<typeof state>((resolve) => {
      finish = resolve;
    });
    const second = vi.fn(() => Promise.resolve(state));

    expect(gate.start(() => first, onState, onError, onBusyChange)).toBe(true);
    expect(gate.busy).toBe(true);
    expect(gate.start(second, onState, onError, onBusyChange)).toBe(false);
    expect(second).not.toHaveBeenCalled();

    finish?.(state);
    await first;
    await vi.waitFor(() => expect(gate.busy).toBe(false));
    expect(onBusyChange).toHaveBeenNthCalledWith(1, true);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(onState).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("normalizes rejection into the persisted-phase recovery message", async () => {
    const onState = vi.fn();
    const onError = vi.fn();

    await observeControllerOperation(
      Promise.reject(new Error("transport failed")),
      onState,
      onError,
    );

    expect(onState).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(controllerFailureMessage(new Error("transport failed")));
  });

  it("does not misreport a state observer failure as a controller failure", async () => {
    const observerFailure = new Error("render callback failed");
    const onError = vi.fn();

    await expect(
      observeControllerOperation(
        Promise.resolve(state),
        () => {
          throw observerFailure;
        },
        onError,
      ),
    ).rejects.toBe(observerFailure);
    expect(onError).not.toHaveBeenCalled();
  });

  it("gives lease contention recovery guidance without claiming the controller crashed", () => {
    const message = controllerFailureMessage(
      new RunAlreadyControlledError("run-locked", 12_345, "lease-current"),
    );

    expect(message).toContain("already controlled by process 12345");
    expect(message).toContain(
      "epicd unlock run-locked --owner-pid 12345 --lease-id lease-current --force",
    );
    expect(message).not.toContain("Restart epicd");
  });

  it("gives cleanup failures retry and explicit abandonment guidance", () => {
    const message = controllerFailureMessage(
      new AgentCleanupRequiredError(
        "run-cleanup",
        "epic-cleanup",
        "cleanup warning could not be recorded",
      ),
    );

    expect(message).toContain("epicd resume epic-cleanup");
    expect(message).toContain("epicd cleanup run-cleanup --abandon");
    expect(message).toContain("External agent resources may remain open");
    expect(message).not.toContain("Restart epicd");
  });

  it("reports post-completion event failures without offering cleanup recovery", () => {
    const message = controllerFailureMessage(
      new WorkflowCompletionReportingError(
        "run-complete",
        "epic-complete",
        "completion event write failed",
      ),
    );

    expect(message).toContain("Workflow for epic epic-complete completed");
    expect(message).toContain("epicd status epic-complete");
    expect(message).not.toContain("epicd cleanup");
    expect(message).not.toContain("Restart epicd");
  });

  it("turns synchronous controller command failures into UI errors", () => {
    const onError = vi.fn();

    expect(
      performControllerCommand(() => {
        throw new Error("lease changed");
      }, onError),
    ).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("lease changed"));
  });

  it("describes an epic-scoped conflict without claiming repository ownership", () => {
    const message = epicRunConflictMessage(
      { ...state, epicId: "epic-one", phase: "blocked" },
      "/repo",
    );

    expect(message).toContain("run for epic epic-one has a blocked workflow");
    expect(message).toContain("epicd resume epic-one --repo /repo");
    expect(message).not.toContain("owns this repository");
  });

  it("offers diagnostic recovery without implying resource cleanup remains", () => {
    const message = epicRunConflictMessage(
      { ...state, phase: "complete", lastError: "saved diagnostic" },
      "/repo",
    );
    expect(message).toContain("has a saved diagnostic");
    expect(message).toContain(`epicd resume ${state.epicId} --repo /repo`);
    expect(message).toContain(`epicd cleanup ${state.runId} --abandon`);
    expect(message).not.toContain("pending agent cleanup");
  });

  it("treats completion as idle for pause-then-exit", () => {
    expect(isControllerIdlePhase("complete")).toBe(true);
    expect(isControllerIdlePhase("selecting")).toBe(false);
  });

  it("offers pause only while an active workflow can honor it", () => {
    expect(canRequestPause(true, "selecting")).toBe(true);
    expect(canRequestPause(true, "complete")).toBe(false);
    expect(canRequestPause(false, "selecting")).toBe(false);
  });

  it("marks headless controller failures as unsuccessful", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await expect(
        launchHeadlessController({
          onEvent: () => () => undefined,
          run: async () => {
            throw new Error("cleanup warning could not be recorded");
          },
        }),
      ).rejects.toThrow("cleanup warning could not be recorded");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("finishes a deferred quit when a rejected controller becomes idle", () => {
    expect(shouldExitAfterController(true, false)).toBe(true);
    expect(shouldExitAfterController(true, true)).toBe(false);
    expect(shouldExitAfterController(false, false)).toBe(false);
  });
});
