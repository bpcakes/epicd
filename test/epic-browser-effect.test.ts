import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Tracer from "effect/Tracer";
import { afterEach, expect, it, vi } from "vitest";
import { KernelGit } from "../src/adapters/kernel-git.js";
import { KernelBeads } from "../src/adapters/kernel-beads.js";
import { PublicationGit } from "../src/adapters/publication-git.js";
import * as discovery from "../src/adapters/runtime-discovery.js";
import { StateStore } from "../src/adapters/store.js";
import {
  browserTimingTracer,
  EpicBrowserLoadFailed,
  loadEpicBrowser,
  loadEpicBrowserEffect,
} from "../src/epic-browser.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});

it("records completed stage spans and page counts without query text in attributes", async () => {
  const f = fixture(),
    spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const query = "token=private-search-value";
  f.page.mockResolvedValue({ epics: [], offset: 50, nextOffset: null });
  const result = await Effect.runPromise(
    loadEpicBrowserEffect(
      f.store,
      { ...f.options, search: query, offset: 50 },
      new AbortController().signal,
    ).pipe(Effect.withTracer(tracer)),
  );
  expect(result.offset).toBe(50);
  const root = spans.find((span) => span.name === "epic.browser.load")!;
  expect(root.attributes.get("page.offset")).toBe(50);
  expect(root.attributes.get("search.active")).toBe(true);
  expect(root.attributes.get("page.epics")).toBe(0);
  expect(root.attributes.get("page.details_unavailable")).toBe(0);
  for (const stage of [
    "resolve_repository",
    "bind_repository",
    "resolve_tracker",
    "read_tracker",
    "project_runs",
  ]) {
    expect(spans.some((span) => span.name === `epic.browser.${stage}`)).toBe(true);
  }
  for (const span of spans) {
    expect(span.status._tag).toBe("Ended");
    if (span.status._tag !== "Ended") throw new Error("Unclosed discovery span");
    expect(span.status.endTime).toBeGreaterThanOrEqual(span.status.startTime);
    expect(JSON.stringify([...span.attributes])).not.toContain("private-search-value");
    expect(span.traceId).toBe(root.traceId);
  }
});

it("reports failed stage timings and actionable redacted diagnostics", async () => {
  const f = fixture(),
    lines: string[] = [];
  const cause = new Error("tracker rejected token=private-search-value");
  f.page.mockRejectedValue(cause);
  const result = await Effect.runPromise(
    Effect.result(
      loadEpicBrowserEffect(
        f.store,
        { ...f.options, search: "private-search-value" },
        new AbortController().signal,
      ).pipe(Effect.withTracer(browserTimingTracer((line) => lines.push(line)))),
    ),
  );
  if (!Result.isFailure(result)) throw new Error("Expected tracker failure");
  expect(result.failure.cause).toBe(cause);
  expect(result.failure.message).toContain("reading Beads");
  expect(result.failure.message).toContain("[REDACTED]");
  expect(result.failure.message).not.toContain("private-search-value");
  expect(lines).toContainEqual(
    expect.stringMatching(/epic\.browser\.read_tracker \d+\.\dms failed$/),
  );
  expect(lines).toContainEqual(expect.stringMatching(/epic\.browser\.load \d+\.\dms failed$/));
  expect(lines.join("\n")).not.toContain("private-search-value");
  expect(lines.some((line) => line.includes("project_runs"))).toBe(false);
  expect(new EpicBrowserLoadFailed({ stage: "resolve_tracker", cause }).message).toContain(
    "--tracker-path",
  );
});

it("a broken diagnostic sink cannot change the discovery result", async () => {
  const f = fixture();
  const result = await Effect.runPromise(
    loadEpicBrowserEffect(f.store, f.options, new AbortController().signal).pipe(
      Effect.withTracer(
        browserTimingTracer(() => {
          throw new Error("stderr closed");
        }),
      ),
    ),
  );
  expect(result.epics).toEqual([]);
});

it("fiber interruption waits for tracker settlement and prevents projection", async () => {
  const f = fixture();
  const project = vi.spyOn(f.store, "inspectWorkflowOwner");
  let complete = () => {};
  f.page.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = () => resolve({ epics: [], offset: 0, nextOffset: null });
      }),
  );
  const fiber = Effect.runFork(
    loadEpicBrowserEffect(f.store, f.options, new AbortController().signal),
  );
  let stopped = false;
  let stopping: Promise<void> | undefined;
  try {
    await expect.poll(() => f.page.mock.calls.length).toBe(1);
    stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      stopped = true;
    });
    await setImmediate();
    expect(stopped).toBe(false);
    expect(project).not.toHaveBeenCalled();
    complete();
    await stopping;
    expect(project).not.toHaveBeenCalled();
  } finally {
    complete();
    await Effect.runPromise(Fiber.interrupt(fiber));
    await stopping;
  }
});
function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-browser-effect-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-qm",
    "Fixture",
  ]);
  mkdirSync(join(repo, ".beads"));
  // No tracker process is executed in these fault-injection tests.
  copyFileSync("/usr/bin/true", join(repo, ".beads/beads.db"));
  const trackerPath = join(root, "br");
  copyFileSync("/usr/bin/true", trackerPath);
  const store = new StateStore(join(root, "state.db"));
  cleanup.push(() => store.close());
  const page = vi
    .spyOn(KernelBeads.prototype, "listOpenEpics")
    .mockResolvedValue({ epics: [], offset: 0, nextOffset: null });
  return { store, options: { repo, trackerPath }, page };
}

it.each([
  "resolve_repository",
  "bind_repository",
  "resolve_tracker",
  "read_tracker",
  "project_runs",
] as const)(
  "is lazy, short-circuits at %s, and preserves the original cause at the Promise boundary",
  async (stage) => {
    const f = fixture(),
      cause = new Error("injected browser read failure"),
      signal = new AbortController().signal;
    const bind = vi.spyOn(KernelBeads.prototype, "bind");
    const project = vi.spyOn(f.store, "inspectWorkflowOwner");
    if (stage === "resolve_repository")
      vi.spyOn(KernelGit.prototype, "text").mockRejectedValue(cause);
    if (stage === "bind_repository")
      vi.spyOn(PublicationGit.prototype, "bind").mockRejectedValue(cause);
    if (stage === "resolve_tracker")
      vi.spyOn(discovery, "resolveExecutableEffect").mockReturnValue(
        Effect.fail(
          new discovery.RuntimeDiscoveryError({ operation: "resolve_executable", cause }),
        ),
      );
    if (stage === "read_tracker") f.page.mockRejectedValue(cause);
    if (stage === "project_runs")
      project.mockImplementation(() => {
        throw cause;
      });
    const program = loadEpicBrowserEffect(f.store, f.options, signal);
    expect(bind).not.toHaveBeenCalled();
    expect(f.page).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    const result = await Effect.runPromise(Effect.result(program));
    if (!Result.isFailure(result)) throw new Error("Expected typed load failure");
    expect(result.failure).toMatchObject({ _tag: "EpicBrowserLoadFailed", stage });
    expect(result.failure.cause).toBe(cause);
    if (stage !== "read_tracker" && stage !== "project_runs") expect(f.page).not.toHaveBeenCalled();
    if (stage !== "project_runs") expect(project).not.toHaveBeenCalled();
    await expect(loadEpicBrowser(f.store, f.options, signal)).rejects.toBe(cause);
  },
);

it.each([null, "raw rejection", { detail: "raw rejection" }])(
  "preserves non-Error page failures: %s",
  async (cause) => {
    const f = fixture();
    f.page.mockRejectedValue(cause);
    await expect(loadEpicBrowser(f.store, f.options, new AbortController().signal)).rejects.toBe(
      cause,
    );
  },
);

it("short-circuits an already-cancelled load and waits for in-flight adapter settlement after cancellation", async () => {
  const f = fixture(),
    cancel = new AbortController(),
    cause = new Error("cancelled");
  cancel.abort(cause);
  await expect(loadEpicBrowser(f.store, f.options, cancel.signal)).rejects.toBe(cause);
  expect(f.page).not.toHaveBeenCalled();
  const active = new AbortController();
  let reject!: (cause: unknown) => void;
  f.page.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const work = loadEpicBrowser(f.store, f.options, active.signal);
  let settled = false;
  void work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await expect.poll(() => f.page.mock.calls.length).toBe(1);
    active.abort(cause);
    await setImmediate();
    expect(settled).toBe(false);
    reject(cause);
    await expect(work).rejects.toBe(cause);
  } finally {
    reject?.(cause);
    await work.catch(() => {});
  }
});
