import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ComponentProps, ReactElement } from "react";
import { render } from "ink";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import { StateStore } from "../src/adapters/store.js";
import * as bootstrap from "../src/bootstrap.js";
import {
  loadEpicBrowserEffect,
  EpicBrowserLoadFailed,
  epicBrowserItems,
} from "../src/epic-browser.js";
import { OrchestratorController } from "../src/controller.js";
import { AccountEditor } from "../src/tui/account-editor.js";
import { EpicPicker } from "../src/tui/epic-picker.js";
import { OperatorView } from "../src/tui/operator-view.js";
import { RunView } from "../src/tui/run-view.js";
import type { DiscoveredEpic } from "../src/domain/epic-discovery.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { initialRun } from "./fixtures/orchestration/state.js";

vi.mock("ink", async (original) => ({
  ...(await original<typeof import("ink")>()),
  render: vi.fn(),
}));
vi.mock("../src/epic-browser.js", async (original) => ({
  ...(await original<typeof import("../src/epic-browser.js")>()),
  loadEpicBrowserEffect: vi.fn(),
}));
const cleanup: (() => void)[] = [];
beforeEach(() => {
  const exitCode = process.exitCode;
  cleanup.push(() => {
    process.exitCode = exitCode;
  });
  for (const stream of [process.stdin, process.stdout]) {
    const original = Object.getOwnPropertyDescriptor(stream, "isTTY");
    Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
    cleanup.push(() => {
      if (original) Object.defineProperty(stream, "isTTY", original);
      else Reflect.deleteProperty(stream, "isTTY");
    });
  }
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(render).mockReset();
  vi.mocked(loadEpicBrowserEffect).mockReset();
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-cli-browser-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".codex"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("XDG_CONFIG_HOME", join(root, ".config"));
  vi.stubEnv("CODEX_HOME", join(root, ".codex"));
  const path = join(root, "state.db"),
    store = new StateStore(path);
  cleanup.push(() => store.close());
  const repoPath = join(root, "repo"),
    commonDirectory = { path: join(repoPath, ".git"), device: "1", inode: "2" };
  const epics: DiscoveredEpic[] = [
    {
      id: "demo",
      title: "Selected epic",
      priority: 2,
      status: "open",
      details: "available",
      parentIds: [],
    },
  ];
  vi.mocked(loadEpicBrowserEffect).mockImplementation((_store, options) =>
    Effect.succeed({
      offset: options.offset ?? 0,
      nextOffset: null,
      repoPath,
      commonDirectory,
      epics,
      items: epicBrowserItems(store, repoPath, commonDirectory, epics),
    }),
  );
  const create = () =>
    store.create({ ...initialRun(), repoPath }, RepositoryPolicySchema.parse({ schemaVersion: 1 }));
  const parse = (...args: string[]) =>
    createProgram().parseAsync([...args, "--state", path], { from: "user" });
  return { path, store, repoPath, epics, create, parse };
}
function pickerResponse(
  response: (props: ComponentProps<typeof EpicPicker>) => void,
  control?: () => void,
  accounts?: (props: ComponentProps<typeof AccountEditor>) => void | Promise<void>,
) {
  vi.mocked(render).mockImplementation((node) => ({
    rerender: vi.fn(),
    unmount: vi.fn(),
    cleanup: vi.fn(),
    clear: vi.fn(),
    waitUntilRenderFlush: async () => {},
    waitUntilExit: async () => {
      const element = node as ReactElement;
      if (element.type === EpicPicker)
        response((node as ReactElement<ComponentProps<typeof EpicPicker>>).props);
      else if (element.type === AccountEditor) {
        const props = (node as ReactElement<ComponentProps<typeof AccountEditor>>).props;
        if (accounts) await accounts(props);
        else await props.onStart(props.initialDraft);
      } else if (element.type === OperatorView) {
        control?.();
        (node as ReactElement<ComponentProps<typeof OperatorView>>).props.close();
      }
    },
  }));
}

it("opens the default browser with CLI overrides and quits without creating or controlling a run", async () => {
  const f = fixture(),
    create = vi.spyOn(bootstrap, "createRun"),
    run = vi.spyOn(OrchestratorController.prototype, "run");
  pickerResponse((props) => {
    expect(props.runtime).toBe("herdr");
    props.onQuit();
  });
  await f.parse("--repo", f.repoPath, "--runtime", "herdr", "--tracker-path", "/chosen/br");
  expect(loadEpicBrowserEffect).toHaveBeenCalledWith(
    expect.any(StateStore),
    expect.objectContaining({ repo: f.repoPath, trackerPath: "/chosen/br" }),
    expect.any(AbortSignal),
  );
  expect(render).toHaveBeenCalledWith(expect.anything(), { exitOnCtrlC: false, interactive: true });
  expect(create).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(f.store.list()).toEqual([]);
});

it("starts the selected epic through shared bootstrap with every explicit launch option", async () => {
  const f = fixture();
  const create = vi.spyOn(bootstrap, "createRun").mockImplementation(async (_store, options) => {
    return f.store.create(
      { ...initialRun(), repoPath: f.repoPath, epicId: options.epicId },
      RepositoryPolicySchema.parse({ schemaVersion: 1 }),
    );
  });
  const run = vi.spyOn(OrchestratorController.prototype, "run").mockImplementation(async function (
    this: OrchestratorController,
  ) {
    return this.status();
  });
  pickerResponse((props) => props.onSelect(props.items[0]!));
  await f.parse(
    "browse",
    "--repo",
    f.repoPath,
    "--runtime",
    "sdk",
    "--codex-path",
    "/chosen/codex",
    "--tracker-path",
    "/chosen/br",
    "--worker-model",
    "gpt-5.5",
    "--codex-home",
    "/chosen/home",
  );
  expect(create).toHaveBeenCalledExactlyOnceWith(
    expect.any(StateStore),
    {
      repoPath: f.repoPath,
      epicId: "demo",
      runtime: "sdk",
      codexPath: "/chosen/codex",
      trackerPath: "/chosen/br",
      model: "gpt-5.5",
      accountDraft: expect.objectContaining({
        mode: "homes",
        defaultAccount: expect.objectContaining({ codexHome: "/chosen/home" }),
      }),
    },
    expect.any(AbortSignal),
  );
  expect(run).toHaveBeenCalledOnce();
});

it.each(["available", "too_large", "budget_exhausted", "absent"])(
  "resumes the confirmed paused run with %s tracker details without replacing its settings",
  async (details) => {
    const f = fixture(),
      state = f.create();
    if (details === "too_large" || details === "budget_exhausted")
      f.epics[0] = { ...f.epics[0]!, title: null, details, parentIds: null };
    if (details === "absent") f.epics.splice(0);
    f.store.orchestration.operatorControl(state.runId, 0, { kind: "pause" });
    const create = vi.spyOn(bootstrap, "createRun");
    const run = vi
      .spyOn(OrchestratorController.prototype, "run")
      .mockImplementation(async function (this: OrchestratorController) {
        return this.status();
      });
    pickerResponse((props) => props.onSelect(props.items[0]!));
    await f.parse("--runtime", "herdr");
    expect(create).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(f.store.orchestration.control(state.runId).status).toBe("active");
    expect(f.store.get(state.runId)?.runtime).toBe("sdk");
    const runViews = vi
      .mocked(render)
      .mock.calls.filter(([node]) => (node as ReactElement).type === RunView);
    expect(runViews).toHaveLength(1);
    expect(runViews[0]![1]).toEqual({ exitOnCtrlC: false, interactive: true });
  },
);

it.each(["run", "resume"])(
  "leaves Ink's CI detection enabled for explicit %s commands",
  async (command) => {
    const f = fixture();
    vi.spyOn(bootstrap, "createRun").mockImplementation(async () => f.create());
    vi.spyOn(OrchestratorController.prototype, "run").mockImplementation(async function (
      this: OrchestratorController,
    ) {
      return this.status();
    });
    pickerResponse(() => {
      throw new Error("Explicit commands must not open the browser");
    });
    await f.parse(command, command === "run" ? "demo" : f.create().runId);
    const runViews = vi
      .mocked(render)
      .mock.calls.filter(([node]) => (node as ReactElement).type === RunView);
    expect(runViews).toHaveLength(1);
    expect(runViews[0]![1]).toEqual({ exitOnCtrlC: false });
  },
);

it("opens the operator console for a live run without starting a second controller", async () => {
  const f = fixture(),
    state = f.create(),
    lease = f.store.acquireLease(state.runId);
  const create = vi.spyOn(bootstrap, "createRun"),
    run = vi.spyOn(OrchestratorController.prototype, "run"),
    control = vi.fn();
  pickerResponse((props) => props.onSelect(props.items[0]!), control);
  await f.parse();
  expect(control).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(f.store.controllerLease(state.runId)?.leaseId).toBe(lease.leaseId);
});

it("refreshes a stale confirmation and requires a new choice without starting work", async () => {
  const f = fixture(),
    create = vi.spyOn(bootstrap, "createRun"),
    run = vi.spyOn(OrchestratorController.prototype, "run");
  let visits = 0;
  pickerResponse((props) => {
    if (visits++ === 0) {
      f.create();
      props.onSelect(props.items[0]!);
    } else {
      expect(props.error).toContain("Run status changed");
      expect(props.items[0]!.action.kind).toBe("resume");
      props.onQuit();
    }
  });
  await f.parse();
  expect(visits).toBe(2);
  expect(create).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("keeps a failing exit status when a launched controller fails and the user quits", async () => {
  const f = fixture(),
    state = f.create();
  vi.spyOn(OrchestratorController.prototype, "run").mockRejectedValue(
    new Error("controller failed"),
  );
  let visits = 0;
  pickerResponse((props) => {
    if (visits++ === 0) props.onSelect(props.items[0]!);
    else {
      expect(props.error).toContain("controller failed");
      props.onQuit();
    }
  });
  await f.parse();
  expect(visits).toBe(2);
  expect(process.exitCode).toBe(1);
  expect(f.store.get(state.runId)).not.toBeNull();
});

it("shows both the launch failure and a subsequent reload failure", async () => {
  const f = fixture();
  f.create();
  const run = vi
    .spyOn(OrchestratorController.prototype, "run")
    .mockRejectedValue(new Error("controller failed before completion"));
  const load = vi.mocked(loadEpicBrowserEffect).getMockImplementation()!;
  let loads = 0;
  vi.mocked(loadEpicBrowserEffect).mockImplementation((...args) => {
    if (++loads === 2)
      return Effect.fail(
        new EpicBrowserLoadFailed({ stage: "read_tracker", cause: new Error("tracker offline") }),
      );
    return load(...args);
  });
  let visits = 0;
  pickerResponse((props) => {
    if (visits++ === 0) props.onSelect(props.items[0]!);
    else if (visits === 2) {
      expect(props.error).toContain("controller failed before completion");
      expect(props.error).toContain("tracker offline");
      expect(props.error).toContain("press r to reload");
      props.onBrowse(props.query);
    } else {
      expect(props.error).toBeUndefined();
      props.onQuit();
    }
  });
  await f.parse();
  expect(visits).toBe(3);
  expect(loads).toBe(3);
  expect(run).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(1);
});

it.each(["active", "blocked", "awaiting_user"] as const)(
  "reports the later controller outcome (%s) after a failed launch",
  async (status) => {
    const f = fixture();
    f.create();
    const run = vi
      .spyOn(OrchestratorController.prototype, "run")
      .mockRejectedValueOnce(new Error("controller failed"))
      .mockImplementation(async function (this: OrchestratorController) {
        return this.status();
      });
    const original = OrchestratorController.prototype.status;
    vi.spyOn(OrchestratorController.prototype, "status").mockImplementation(function (
      this: OrchestratorController,
    ) {
      const current = original.call(this);
      return { ...current, control: { ...current.control, status } };
    });
    let visits = 0;
    pickerResponse((props) => {
      if (visits++ > 0) expect(process.exitCode).toBe(1);
      props.onSelect(props.items[0]!);
    });
    await f.parse();
    expect(visits).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(status === "active" ? 0 : 2);
  },
);

it.each([
  { page: 2, search: "", showNested: true },
  { page: 1, search: "needle", showNested: true },
])(
  "keeps the previous page after a failed navigation to $page/$search and allows retry",
  async (next) => {
    const f = fixture();
    const load = vi.mocked(loadEpicBrowserEffect).getMockImplementation()!;
    let calls = 0;
    vi.mocked(loadEpicBrowserEffect).mockImplementation((...args) => {
      if (++calls === 2)
        return Effect.fail(
          new EpicBrowserLoadFailed({
            stage: "read_tracker",
            cause: new Error("temporary tracker fault"),
          }),
        );
      return load(...args);
    });
    let visits = 0;
    let previous: ComponentProps<typeof EpicPicker>["items"];
    pickerResponse((props) => {
      if (visits++ === 0) {
        previous = props.items;
        props.onBrowse(next);
      } else if (visits === 2) {
        expect(props.items).toBe(previous);
        expect(props.query).toEqual({ page: 1, search: "", showNested: false });
        expect(props.error).toContain("temporary tracker fault");
        expect(props.error).toContain("press r to reload");
        expect(calls).toBe(2);
        props.onBrowse(next);
      } else {
        expect(props.query).toEqual(next);
        expect(props.error).toBeUndefined();
        props.onQuit();
      }
    });
    await f.parse();
    expect(visits).toBe(3);
    expect(f.store.list()).toEqual([]);
  },
);

it("requires a successful reload and a new confirmation before acting on a retained page", async () => {
  const f = fixture();
  f.create();
  const run = vi.spyOn(OrchestratorController.prototype, "run");
  const load = vi.mocked(loadEpicBrowserEffect).getMockImplementation()!;
  let calls = 0;
  vi.mocked(loadEpicBrowserEffect).mockImplementation((...args) => {
    if (++calls === 2)
      return Effect.fail(
        new EpicBrowserLoadFailed({ stage: "read_tracker", cause: new Error("offline") }),
      );
    return load(...args);
  });
  let visits = 0;
  pickerResponse((props) => {
    if (visits++ === 0) props.onBrowse({ ...props.query, page: 2 });
    else if (visits === 2) props.onSelect(props.items[0]!);
    else {
      expect(props.error).toContain("confirming again");
      props.onQuit();
    }
  });
  await f.parse();
  expect(visits).toBe(3);
  expect(run).not.toHaveBeenCalled();
});

it("reports the initial browser failure's stage and advice while retaining its cause", async () => {
  const f = fixture();
  const listeners = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
  const cause = new Error("tracker unavailable");
  vi.mocked(loadEpicBrowserEffect).mockReturnValue(
    Effect.fail(new EpicBrowserLoadFailed({ stage: "read_tracker", cause })),
  );
  await expect(f.parse()).rejects.toMatchObject({
    _tag: "EpicBrowserLoadFailed",
    stage: "read_tracker",
    cause,
    message: expect.stringContaining("reading Beads"),
  });
  expect(render).not.toHaveBeenCalled();
  expect([process.listeners("SIGINT"), process.listeners("SIGTERM")]).toEqual(listeners);
});

it.each(["SIGINT", "SIGTERM"] as const)(
  "cleans up the browser after %s without launching",
  async (signal) => {
    const f = fixture();
    const listeners = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
    const create = vi.spyOn(bootstrap, "createRun");
    pickerResponse(() => {
      process.emit(signal);
    });
    await f.parse();
    expect(create).not.toHaveBeenCalled();
    const ui = vi.mocked(render).mock.results[0]!.value as ReturnType<typeof render>;
    expect(ui.unmount).toHaveBeenCalledOnce();
    expect([process.listeners("SIGINT"), process.listeners("SIGTERM")]).toEqual(listeners);
  },
);

it.each([false, true])("prints discovery timings only when requested (%s)", async (enabled) => {
  const f = fixture();
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const load = vi.mocked(loadEpicBrowserEffect).getMockImplementation()!;
  vi.mocked(loadEpicBrowserEffect).mockImplementation((...args) =>
    load(...args).pipe(Effect.withSpan("epic.browser.load")),
  );
  pickerResponse((props) => props.onQuit());
  await f.parse(...(enabled ? ["--trace-discovery"] : []));
  if (enabled)
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/^\[epicd\] epic\.browser\.load \d+\.\dms ok\n$/),
    );
  else expect(stderr).not.toHaveBeenCalled();
});

it("keeps a rejected creation inside setup and lets Ctrl+C quit without re-opening the browser", async () => {
  const f = fixture();
  const create = vi
    .spyOn(bootstrap, "createRun")
    .mockRejectedValue(new Error("invalid repository policy"));
  const run = vi.spyOn(OrchestratorController.prototype, "run");
  const before = process.exitCode;
  let visits = 0;
  pickerResponse(
    (props) => {
      visits++;
      props.onSelect(props.items[0]!);
    },
    undefined,
    async (props) => {
      await expect(props.onStart(props.initialDraft)).rejects.toThrow("invalid repository policy");
      expect(create).toHaveBeenCalledOnce();
      expect(props.repoPath).toBe(f.repoPath);
      expect(props.runtime).toBe("sdk");
      props.onQuit();
    },
  );
  await f.parse();
  expect(visits).toBe(1);
  expect(run).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(before);
  expect(f.store.list()).toEqual([]);
});

it("loads the requested page and resets to the first page for a global search", async () => {
  const f = fixture(),
    run = vi.spyOn(OrchestratorController.prototype, "run");
  let visits = 0;
  pickerResponse((props) => {
    if (visits++ === 0) props.onBrowse({ page: 2, search: "", showNested: true });
    else if (visits === 2) {
      expect(props.query.page).toBe(2);
      props.onBrowse({ page: 1, search: "needle", showNested: true });
    } else {
      expect(props.query).toEqual({ page: 1, search: "needle", showNested: true });
      props.onQuit();
    }
  });
  await f.parse();
  expect(
    vi
      .mocked(loadEpicBrowserEffect)
      .mock.calls.map((call) => ({ offset: call[1].offset, search: call[1].search })),
  ).toEqual([
    { offset: 0, search: "" },
    { offset: 50, search: "" },
    { offset: 0, search: "needle" },
  ]);
  expect(run).not.toHaveBeenCalled();
});

it("opens account setup for an explicit run in a terminal and allows leaving before creation", async () => {
  const f = fixture();
  const create = vi.spyOn(bootstrap, "createRun");
  const accounts = vi.fn((props: ComponentProps<typeof AccountEditor>) => {
    expect(props.epicId).toBe("demo");
    expect(props.runtime).toBe("sdk");
    props.onBack();
  });
  pickerResponse(
    () => {
      throw new Error("Explicit run must not open the epic browser");
    },
    undefined,
    accounts,
  );
  await f.parse("run", "demo", "--repo", f.repoPath);
  expect(accounts).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
  expect(f.store.list()).toEqual([]);
});

it("passes headless default and per-class home selectors through the shared draft without opening Ink", async () => {
  const f = fixture();
  const review = join(f.repoPath, "review-home");
  mkdirSync(review, { recursive: true });
  const create = vi.spyOn(bootstrap, "createRun").mockImplementation(async () => f.create());
  vi.spyOn(OrchestratorController.prototype, "run").mockImplementation(async function (
    this: OrchestratorController,
  ) {
    return this.status();
  });
  await f.parse(
    "run",
    "demo",
    "--headless",
    "--codex-home",
    process.env.CODEX_HOME!,
    "--agent-codex-home",
    `review=${review}`,
  );
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0]![1].accountDraft).toMatchObject({
    mode: "homes",
    classes: {
      implementation: { codexHome: process.env.CODEX_HOME },
      review: { codexHome: review },
      verification: { codexHome: review },
    },
  });
  expect(render).not.toHaveBeenCalled();
});
it.each([
  ["--agent-codex-home", "review=/a", "--agent-codex-home", "review=/b"],
  ["--agent-codex-home", "unknown=/a"],
  ["--auth-cache", "/a", "--codex-home", "/b"],
  ["--auth-cache", "/a", "--accounts-config", "/missing-explicit-config"],
  ["--accounts-config", "/missing-explicit-config"],
])("rejects invalid explicit account selection before creating a run (%j)", async (...flags) => {
  const f = fixture(),
    create = vi.spyOn(bootstrap, "createRun");
  await expect(f.parse("run", "demo", "--headless", ...flags)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  expect(f.store.list()).toEqual([]);
});
