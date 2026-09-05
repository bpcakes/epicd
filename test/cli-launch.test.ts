import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EpicEngine } from "../src/engine/engine.js";
import type { DoctorCheck } from "../src/domain/types.js";
import type { PickerItem } from "../src/tui/picker.js";

vi.mock("ink", () => ({ render: vi.fn() }));
vi.mock("../src/tui/app.js", () => ({ EpicdApp: () => null }));
vi.mock("../src/tui/run-view.js", () => ({ RunView: () => null }));
vi.mock("../src/doctor.js", () => ({ runDoctor: vi.fn() }));

const tempDirs: string[] = [];
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const boundaryMessage = "test stopped at engine boundary";

beforeEach(() => {
  vi.resetModules();
  process.exitCode = undefined;
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  if (originalTty) Object.defineProperty(process.stdout, "isTTY", originalTty);
  else Reflect.deleteProperty(process.stdout, "isTTY");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

type Entry = "run" | "direct" | "picker" | "resume";

async function fixture(entry: Entry, flags: string[] = [], recovered?: "workflow" | "cleanup") {
  const [
    { GitClient },
    { BeadsClient },
    { EpicEngine },
    { StateStore },
    domain,
    { runDoctor },
    ink,
  ] = await Promise.all([
    import("../src/adapters/git.js"),
    import("../src/adapters/beads.js"),
    import("../src/engine/engine.js"),
    import("../src/adapters/store.js"),
    import("../src/domain/types.js"),
    import("../src/doctor.js"),
    import("ink"),
  ]);
  const root = mkdtempSync(join(tmpdir(), "epicd-launch-"));
  tempDirs.push(root);
  vi.stubEnv("XDG_STATE_HOME", root);
  const args = entry === "picker" ? [] : entry === "direct" ? ["epic"] : [entry, "epic"];
  process.argv = [process.execPath, "epicd", "--repo", root, ...flags, ...args];
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(GitClient.prototype, "root").mockResolvedValue(root);
  vi.spyOn(BeadsClient.prototype, "listOpenEpics").mockResolvedValue([
    domain.IssueSchema.parse({ id: "epic", title: "Epic", issue_type: "epic", status: "open" }),
  ]);
  // Stop at the engine boundary without running agents or inventing an engine implementation.
  const create = vi.spyOn(EpicEngine, "create").mockRejectedValue(new Error(boundaryMessage));
  const resume = vi.spyOn(EpicEngine, "resume").mockImplementation(() => {
    throw new Error(boundaryMessage);
  });
  const doctor = vi.mocked(runDoctor).mockReset().mockResolvedValue({ repoPath: root, checks: [] });
  vi.mocked(ink.render)
    .mockReset()
    .mockImplementation((node) => {
      const { items, loadEngine } = (
        node as ReactElement<{
          items: PickerItem[];
          loadEngine: (item: PickerItem) => Promise<EpicEngine>;
        }>
      ).props;
      return { waitUntilExit: () => loadEngine(items[0]!) } as unknown as ReturnType<
        typeof ink.render
      >;
    });
  if (recovered) {
    const store = new StateStore();
    try {
      store.create(
        domain.RunStateSchema.parse({
          runId: "existing-run",
          agentNamespace: "0123456789abcdef0123",
          repoPath: root,
          epicId: "epic",
          epicTitle: "Epic",
          runtime: "herdr",
          model: "persisted-model",
          phase: recovered === "cleanup" ? "complete" : "selecting",
          pendingAgentCleanup: recovered === "cleanup" ? [{ kind: "run", runtime: "herdr" }] : [],
          currentBeadId: null,
          currentBeadTitle: null,
          baseRevision: null,
          epicBaseRevision: "base",
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
        }),
      );
    } finally {
      store.close();
    }
  }
  return { root, create, resume, doctor, stderr };
}

const creationEntries = ["run", "direct", "picker"] as const;
const recoveryEntries = ["resume", "direct", "picker"] as const;
const warning: DoctorCheck = { name: "optional tool", status: "warn", message: "unavailable" };

it.each(creationEntries)("forwards explicit engine options through %s", async (entry) => {
  const setup = await fixture(entry, [
    "--runtime",
    "sdk",
    "--codex-path",
    "/selected/codex",
    "--model",
    "run-model",
    "--reasoning",
    "medium",
    "--orchestrator-model",
    "coordinator-model",
    "--orchestrator-reasoning",
    "low",
    "--implementation-model",
    "builder-model",
    "--implementation-reasoning",
    "high",
    "--review-model",
    "reviewer-model",
    "--review-reasoning",
    "xhigh",
    "--max-review-passes",
    "7",
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  setup.doctor.mockResolvedValue({ repoPath: setup.root, checks: [warning] });

  await import("../src/cli.js");

  expect(setup.create).toHaveBeenCalledExactlyOnceWith(
    {
      repoPath: setup.root,
      epicId: "epic",
      runtime: "sdk",
      codexPath: "/selected/codex",
      model: "run-model",
      reasoningEffort: "medium",
      agentSettings: {
        orchestrator: { model: "coordinator-model", reasoningEffort: "low" },
        implementation: { model: "builder-model", reasoningEffort: "high" },
        review: { model: "reviewer-model", reasoningEffort: "xhigh" },
      },
      maxReviewPasses: 7,
      accessMode: "danger-full-access",
    },
    expect.anything(),
  );
  expect(setup.resume).not.toHaveBeenCalled();
  expect(setup.stderr).toHaveBeenCalledExactlyOnceWith(`epicd: ${boundaryMessage}\n`);
});

it.each(creationEntries)("preserves inheritance resets through %s", async (entry) => {
  const setup = await fixture(entry, [
    "--runtime",
    "herdr",
    "--model-inherit",
    "--reasoning-inherit",
    "--review-model-inherit",
    "--review-reasoning-inherit",
  ]);

  await import("../src/cli.js");

  expect(setup.create).toHaveBeenCalledExactlyOnceWith(
    {
      repoPath: setup.root,
      epicId: "epic",
      runtime: "herdr",
      model: null,
      reasoningEffort: null,
      agentSettings: { review: { model: null, reasoningEffort: null } },
    },
    expect.anything(),
  );
});

it.each(
  recoveryEntries.flatMap((entry) =>
    (["workflow", "cleanup"] as const).map((mode) => ({ entry, mode })),
  ),
)("preserves omitted overrides and $mode preflight through $entry", async ({ entry, mode }) => {
  const setup = await fixture(entry, [], mode);
  setup.doctor.mockResolvedValue({ repoPath: setup.root, checks: [warning] });

  await import("../src/cli.js");

  expect(setup.resume).toHaveBeenCalledExactlyOnceWith("existing-run", {}, expect.anything());
  expect(setup.create).not.toHaveBeenCalled();
  expect(setup.doctor).toHaveBeenLastCalledWith(setup.root, "herdr", { mode });
  if (entry === "picker") {
    expect(setup.doctor).toHaveBeenNthCalledWith(1, setup.root, "sdk", { mode: "selection" });
  }
  expect(setup.stderr).toHaveBeenCalledExactlyOnceWith(`epicd: ${boundaryMessage}\n`);
});

it.each(["run", "direct", "picker", "resume", "selection"] as const)(
  "reports ordered failures and prevents launch at the %s gate",
  async (gate) => {
    const setup = await fixture(
      gate === "selection" ? "picker" : gate,
      [],
      gate === "resume" ? "workflow" : undefined,
    );
    const checks: DoctorCheck[] = [
      warning,
      { name: "first", status: "fail", message: "first failure" },
      { name: "working", status: "pass", message: "passed" },
      { name: "second", status: "fail", message: "second failure" },
    ];
    setup.doctor.mockResolvedValue({ repoPath: setup.root, checks });
    if (gate === "picker") setup.doctor.mockResolvedValueOnce({ repoPath: setup.root, checks: [] });

    await import("../src/cli.js");

    expect(setup.create).not.toHaveBeenCalled();
    expect(setup.resume).not.toHaveBeenCalled();
    expect(setup.stderr).toHaveBeenCalledExactlyOnceWith(
      "epicd: first: first failure\nsecond: second failure\n",
    );
    expect(process.exitCode).toBe(1);
    expect(setup.doctor).toHaveBeenCalledTimes(gate === "picker" ? 2 : 1);
  },
);
