import { setImmediate } from "node:timers/promises";
import type { ComponentProps, ReactElement } from "react";
import { render } from "ink";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { afterEach, expect, it, vi } from "vitest";
import type { OperatorRequest, RunOperator } from "../src/operator-controls.js";
import { operatorConsoleEffect } from "../src/tui/operator-console-session.js";
import { OperatorView } from "../src/tui/operator-view.js";

vi.mock("ink", async (original) => ({
  ...(await original<typeof import("ink")>()),
  render: vi.fn(),
}));

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const finish of cleanup.splice(0).reverse()) await finish();
  vi.restoreAllMocks();
  vi.mocked(render).mockReset();
});

function held<A>() {
  let resolve!: (value: A) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

function fixture(autoExit = true) {
  const terminal = held<void>();
  const request = held<string>();
  let pending: Promise<string> | null = null;
  let requestSignal: AbortSignal | undefined;
  const operator = {
    status: vi.fn(() => ({}) as ReturnType<RunOperator["status"]>),
    submit: vi.fn((_input: OperatorRequest, signal?: AbortSignal) => {
      requestSignal = signal;
      pending = request.promise;
      void request.promise.finally(() => {
        pending = null;
      });
      return request.promise;
    }),
    settle: vi.fn(async () => {
      try {
        await pending;
      } catch {
        // The submit caller owns request failure reporting.
      }
    }),
  };
  let props!: ComponentProps<typeof OperatorView>;
  const unmount = vi.fn(() => {
    if (autoExit) terminal.resolve();
  });
  const waitUntilExit = vi.fn(() => terminal.promise);
  const waitUntilRenderFlush = vi.fn(async () => {
    await terminal.promise.catch(() => {});
  });
  vi.mocked(render).mockImplementation((node) => {
    props = (node as ReactElement<ComponentProps<typeof OperatorView>>).props;
    return {
      unmount,
      waitUntilExit,
      waitUntilRenderFlush,
      rerender: vi.fn(),
      cleanup: vi.fn(),
      clear: vi.fn(),
    };
  });
  const program = operatorConsoleEffect(operator);
  const restored = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
  const assertRestored = () =>
    expect([process.listeners("SIGINT"), process.listeners("SIGTERM")]).toEqual(restored);
  cleanup.push(async () => {
    request.resolve("fixture result");
    terminal.resolve();
  });
  return {
    program,
    operator,
    request,
    terminal,
    props: () => props,
    unmount,
    waitUntilExit,
    waitUntilRenderFlush,
    requestSignal: () => requestSignal,
    assertRestored,
  };
}

it("is lazy and SIGINT drains an admitted request before releasing the terminal", async () => {
  const f = fixture(false);
  expect(f.operator.status).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  const work = Effect.runPromise(f.program);
  let settled = false;
  void work.then(() => {
    settled = true;
  });
  await expect.poll(() => f.props()).toBeDefined();
  const submitted = f.props().controls.submit({ kind: "pause", controlVersion: 0 });
  process.emit("SIGINT");
  await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
  expect(f.requestSignal()?.aborted).toBe(true);
  f.terminal.resolve();
  await setImmediate();
  expect(settled).toBe(false);
  f.request.resolve("Pause recorded after commit");
  await expect(submitted).resolves.toBe("Pause recorded after commit");
  await work;
  expect(f.operator.settle).toHaveBeenCalledOnce();
  expect(f.waitUntilExit).toHaveBeenCalledOnce();
  expect(f.waitUntilRenderFlush).toHaveBeenCalledOnce();
  f.assertRestored();
});

it.each(["wait", "unmount", "flush"] as const)(
  "preserves the origin and terminal state of an Ink %s failure",
  async (stage) => {
    const f = fixture(stage !== "wait"),
      cause = new Error(`${stage} failed`);
    if (stage === "wait") {
      f.waitUntilExit.mockReturnValueOnce(Promise.reject(cause));
      f.waitUntilRenderFlush.mockResolvedValueOnce(undefined);
    }
    if (stage === "unmount")
      f.unmount.mockImplementationOnce(() => {
        throw cause;
      });
    if (stage === "flush") f.waitUntilRenderFlush.mockRejectedValueOnce(cause);
    const work = Effect.runPromise(Effect.result(f.program));
    await expect.poll(() => f.props()).toBeDefined();
    if (stage !== "wait") f.props().close();
    const result = await work;
    if (!Result.isFailure(result)) throw new Error("Expected terminal failure");
    expect(result.failure).toMatchObject({
      stage: stage === "wait" ? "wait" : "cleanup",
      cause,
      terminalState: stage === "wait" ? "released" : "unknown",
    });
    expect(f.operator.settle).toHaveBeenCalledOnce();
    expect(f.unmount).toHaveBeenCalledOnce();
    f.assertRestored();
  },
);

it("continues unmount, request drain, and terminal flush when listener removal fails", async () => {
  const f = fixture(false),
    cause = new Error("listener removal failed");
  const submitted = Effect.runPromise(Effect.result(f.program));
  await expect.poll(() => f.props()).toBeDefined();
  const request = f.props().controls.submit({ kind: "pause", controlVersion: 0 });
  const observer = (event: string | symbol) => {
    if (event === "SIGINT") throw cause;
  };
  process.on("removeListener", observer);
  try {
    f.props().close();
    await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
    expect(f.requestSignal()?.aborted).toBe(true);
    f.terminal.resolve();
    f.request.resolve("committed");
    await request;
    const result = await submitted;
    if (!Result.isFailure(result)) throw new Error("Expected listener cleanup failure");
    expect(result.failure).toMatchObject({
      _tag: "OperatorConsoleFailed",
      stage: "cleanup",
      cause,
      terminalState: "unknown",
    });
  } finally {
    process.off("removeListener", observer);
  }
  expect(f.operator.settle).toHaveBeenCalledOnce();
  expect(f.waitUntilRenderFlush).toHaveBeenCalledOnce();
  f.assertRestored();
});

it("fiber interruption waits for the pending request and terminal release", async () => {
  const f = fixture(false),
    fiber = Effect.runFork(f.program);
  await expect.poll(() => f.props()).toBeDefined();
  const request = f.props().controls.submit({ kind: "pause", controlVersion: 0 });
  let interrupted = false;
  const stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
    interrupted = true;
  });
  await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
  expect(f.requestSignal()?.aborted).toBe(true);
  f.terminal.resolve();
  await setImmediate();
  expect(interrupted).toBe(false);
  f.request.resolve("committed");
  await request;
  await stopping;
  expect(interrupted).toBe(true);
  f.assertRestored();
});
