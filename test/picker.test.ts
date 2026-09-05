import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { canSelectPickerItem, EpicPicker } from "../src/tui/picker.js";
import { IssueSchema, RunStateSchema } from "../src/domain/types.js";

afterEach(cleanup);

describe("epic picker selection", () => {
  it("allows valid runs and blocks invalid persisted runs", () => {
    expect(canSelectPickerItem({ unavailableReason: null })).toBe(true);
    expect(canSelectPickerItem({ unavailableReason: "invalid persisted state" })).toBe(false);
  });

  it("describes a diagnostic-only completed run without claiming resources need cleanup", async () => {
    const epic = IssueSchema.parse({
      id: "epic",
      title: "Completed epic",
      issue_type: "epic",
      status: "closed",
    });
    const run = RunStateSchema.parse({
      runId: "diagnostic-run",
      agentNamespace: "0123456789abcdef0123",
      repoPath: "/repo",
      epicId: epic.id,
      epicTitle: epic.title,
      phase: "complete",
      model: null,
      epicBaseRevision: "abc123",
      currentBeadId: null,
      currentBeadTitle: null,
      baseRevision: null,
      candidateRevision: null,
      completedTasks: 1,
      totalTasks: 1,
      reviewPass: 0,
      pendingFindings: [],
      recentOutcomes: [],
      lastReviewSummary: null,
      resumePhase: null,
      lastError: "saved diagnostic",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const view = render(
      createElement(EpicPicker, {
        items: [{ epic, run, unavailableReason: null }],
        onSelect: vi.fn(),
      }),
    );
    await setImmediate();
    expect(view.lastFrame()).toContain("needs attention");
    expect(view.lastFrame()).not.toContain("cleanup pending");
    view.stdin.write("\r");
    await setImmediate();
    expect(view.lastFrame()).toContain("Clear the existing run's saved diagnostic");
    expect(view.lastFrame()).not.toContain("pending agent cleanup");
  });
});
