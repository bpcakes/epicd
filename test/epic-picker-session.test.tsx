import { setImmediate } from "node:timers/promises";
import type { ComponentProps, ReactElement } from "react";
import { render } from "ink";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { afterEach, expect, it, vi } from "vitest";
import type { EpicBrowserItem } from "../src/epic-browser.js";
import { EpicPicker } from "../src/tui/epic-picker.js";
import { pickEpicEffect } from "../src/tui/epic-picker-session.js";

vi.mock("ink", async (original) => ({
  ...(await original<typeof import("ink")>()),
  render: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(render).mockReset();
});
const item: EpicBrowserItem = {
  epic: { id: "demo", title: "Demo", priority: 1, status: "open" },
  parentIds: [],
  notice: null,
  action: { kind: "start" },
};
function fixture(autoExit = true) {
  const cancellation = new AbortController();
  let props!: ComponentProps<typeof EpicPicker>;
  let close!: () => void, fail!: (error: unknown) => void;
  const exited = new Promise<void>((resolve, reject) => {
    close = resolve;
    fail = reject;
  });
  const unmount = vi.fn(() => {
    if (autoExit) close();
  });
  const waitUntilExit = vi.fn(() => exited);
  vi.mocked(render).mockImplementation((node) => {
    props = (node as ReactElement<ComponentProps<typeof EpicPicker>>).props;
    return {
      unmount,
      waitUntilExit,
      rerender: vi.fn(),
      cleanup: vi.fn(),
      clear: vi.fn(),
      waitUntilRenderFlush: async () => {
        await exited.catch(() => {});
      },
    };
  });
  const program = pickEpicEffect(
    {
      items: [item],
      runtime: "sdk",
      query: { page: 1, search: "", showNested: false },
      hasNextPage: true,
    },
    cancellation.signal,
  );
  return { program, cancellation, unmount, waitUntilExit, close, fail, props: () => props };
}

it.each(["select", "browse", "quit"] as const)(
  "returns a %s event after unmount and exit",
  async (kind) => {
    const f = fixture(false);
    const work = Effect.runPromise(f.program);
    let settled = false;
    void work.then(() => {
      settled = true;
    });
    try {
      await expect.poll(() => f.props()).toBeDefined();
      const query = { page: 2, search: "needle", showNested: true };
      if (kind === "select") f.props().onSelect(item);
      else if (kind === "browse") f.props().onBrowse(query);
      else f.props().onQuit();
      await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
      await setImmediate();
      expect(settled).toBe(false);
      f.close();
      expect(await work).toEqual(
        kind === "select" ? { kind, item } : kind === "browse" ? { kind, query } : { kind },
      );
      expect(f.waitUntilExit).toHaveBeenCalledOnce();
      expect(f.unmount).toHaveBeenCalledOnce();
    } finally {
      f.cancellation.abort();
      f.close();
      await work.catch(() => {});
    }
  },
);

it("accepts only the first event when callbacks compete", async () => {
  const f = fixture(),
    work = Effect.runPromise(f.program);
  await expect.poll(() => f.props()).toBeDefined();
  f.props().onSelect(item);
  f.props().onBrowse({ page: 2, search: "", showNested: false });
  f.props().onQuit();
  expect(await work).toEqual({ kind: "select", item });
  expect(f.unmount).toHaveBeenCalledOnce();
});

it("does not render an already-cancelled picker", async () => {
  const f = fixture();
  f.cancellation.abort();
  expect(await Effect.runPromise(f.program)).toEqual({ kind: "quit" });
  expect(render).not.toHaveBeenCalled();
  f.close();
});

it("external cancellation removes its listener and returns quit after cleanup", async () => {
  const f = fixture();
  const remove = vi.spyOn(f.cancellation.signal, "removeEventListener");
  const work = Effect.runPromise(f.program);
  await expect.poll(() => f.props()).toBeDefined();
  f.cancellation.abort();
  expect(await work).toEqual({ kind: "quit" });
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(f.unmount).toHaveBeenCalledOnce();
});

it("fiber interruption waits for the UI's exit before completing", async () => {
  const f = fixture(false),
    fiber = Effect.runFork(f.program);
  let settled = false;
  let stopping: Promise<void> | undefined;
  try {
    await expect.poll(() => f.props()).toBeDefined();
    stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      settled = true;
    });
    await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
    expect(settled).toBe(false);
    f.close();
    await stopping;
    expect(settled).toBe(true);
    expect(f.waitUntilExit).toHaveBeenCalledOnce();
  } finally {
    f.close();
    await Effect.runPromise(Fiber.interrupt(fiber));
    await stopping;
  }
});

it("reports render failure without leaving an abort listener", async () => {
  const f = fixture(),
    cause = new Error("renderer unavailable");
  const add = vi.spyOn(f.cancellation.signal, "addEventListener");
  vi.mocked(render).mockImplementationOnce(() => {
    throw cause;
  });
  const result = await Effect.runPromise(Effect.result(f.program));
  if (!Result.isFailure(result)) throw new Error("Expected render failure");
  expect(result.failure).toMatchObject({ stage: "render", cause });
  expect(add).not.toHaveBeenCalled();
  expect(f.unmount).not.toHaveBeenCalled();
  f.close();
});

it("releases the picker after abort listener registration fails", async () => {
  const f = fixture(),
    cause = new Error("abort registration failed");
  vi.spyOn(f.cancellation.signal, "addEventListener").mockImplementation(() => {
    throw cause;
  });
  const result = await Effect.runPromise(Effect.result(f.program));
  if (!Result.isFailure(result)) throw new Error("Expected registration failure");
  expect(result.failure).toMatchObject({ stage: "wait", cause, terminalState: "released" });
  expect(f.unmount).toHaveBeenCalledOnce();
});

it("unmounts and removes listeners when waiting for Ink fails", async () => {
  const f = fixture(),
    cause = new Error("terminal disconnected");
  const remove = vi.spyOn(f.cancellation.signal, "removeEventListener");
  const work = Effect.runPromise(Effect.result(f.program));
  await expect.poll(() => f.props()).toBeDefined();
  f.fail(cause);
  const result = await work;
  if (!Result.isFailure(result)) throw new Error("Expected terminal failure");
  expect(result.failure.stage).toBe("wait");
  expect(result.failure.terminalState).toBe("released");
  expect(result.failure.cause).toBe(cause);
  expect(f.unmount).toHaveBeenCalledOnce();
  expect(f.waitUntilExit).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

it.each(["after selection", "synchronous", "unmount"] as const)(
  "preserves the origin and cause of %s failures",
  async (timing) => {
    const f = fixture(false),
      cause = new Error("terminal failed");
    const remove = vi.spyOn(f.cancellation.signal, "removeEventListener");
    if (timing === "synchronous")
      f.waitUntilExit.mockImplementationOnce(() => {
        throw cause;
      });
    if (timing === "unmount")
      f.unmount.mockImplementationOnce(() => {
        throw cause;
      });
    const work = Effect.runPromise(Effect.result(f.program));
    let settled = false;
    void work.then(() => {
      settled = true;
    });
    try {
      await expect.poll(() => f.props()).toBeDefined();
      if (timing !== "synchronous") f.props().onSelect(item);
      await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
      if (timing === "after selection") f.fail(cause);
      if (timing === "synchronous") f.close();
      // Failed unmount does not settle exited; a wait failure still needs flush evidence.
      await expect.poll(() => settled).toBe(true);
      const result = await work;
      if (!Result.isFailure(result)) throw new Error("Expected terminal failure");
      expect(result.failure.stage).toBe(timing === "unmount" ? "cleanup" : "wait");
      expect(result.failure.terminalState).toBe(timing === "unmount" ? "unknown" : "released");
      expect(result.failure.cause).toBe(cause);
      expect(f.waitUntilExit).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      f.cancellation.abort();
      f.close();
      await work;
    }
  },
);

it("reports cleanup failure when both exit and unmount fail", async () => {
  const f = fixture(false),
    cause = new Error("unmount failed");
  f.unmount.mockImplementationOnce(() => {
    throw cause;
  });
  const work = Effect.runPromise(Effect.result(f.program));
  await expect.poll(() => f.props()).toBeDefined();
  f.fail(new Error("renderer failed first"));
  const result = await work;
  if (!Result.isFailure(result)) throw new Error("Expected cleanup failure");
  expect(result.failure.stage).toBe("cleanup");
  expect(result.failure.terminalState).toBe("unknown");
  expect(result.failure.cause).toBe(cause);
  expect(f.unmount).toHaveBeenCalledOnce();
});

it("still unmounts and awaits exit when abort listener removal fails", async () => {
  const f = fixture(false),
    cause = new Error("abort listener cleanup failed");
  const remove = f.cancellation.signal.removeEventListener.bind(f.cancellation.signal);
  vi.spyOn(f.cancellation.signal, "removeEventListener").mockImplementation((...args) => {
    remove(...args);
    throw cause;
  });
  const work = Effect.runPromise(Effect.result(f.program));
  let settled = false;
  void work.then(() => {
    settled = true;
  });
  try {
    await expect.poll(() => f.props()).toBeDefined();
    f.props().onQuit();
    await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
    expect(settled).toBe(false);
    f.close();
    const result = await work;
    if (!Result.isFailure(result)) throw new Error("Expected cleanup failure");
    expect(result.failure).toMatchObject({ stage: "cleanup", cause, terminalState: "unknown" });
  } finally {
    f.close();
    await work;
  }
});
