import { setImmediate } from "node:timers/promises";
import type { ReactElement } from "react";
import { render } from "ink";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { afterEach, expect, it, vi } from "vitest";
import * as accounts from "../src/adapters/accounts.js";
import { AccountPreferencesSchema, resolveAccountDraft } from "../src/domain/accounts.js";
import type { AccountEditorProps } from "../src/tui/account-editor.js";
import { selectAccounts, selectAccountsEffect } from "../src/tui/account-editor-session.js";

vi.mock("ink", async (original) => ({
  ...(await original<typeof import("ink")>()),
  render: vi.fn(),
}));
vi.mock("../src/adapters/accounts.js", async (original) => ({
  ...(await original<typeof import("../src/adapters/accounts.js")>()),
}));

const releases: (() => void)[] = [];
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const finish of cleanup.splice(0).reverse()) await finish();
  vi.restoreAllMocks();
  vi.mocked(render).mockReset();
});
function held<A>(value: A) {
  let finish!: () => void, fail!: (cause: unknown) => void;
  const promise = new Promise<A>((resolve, reject) => {
    finish = () => resolve(value);
    fail = reject;
  });
  releases.push(finish);
  return { promise, finish, fail };
}
function fixture(autoExit = true) {
  const preferences = AccountPreferencesSchema.parse({ schemaVersion: 1 });
  const draft = resolveAccountDraft({
    preferences,
    configPath: "/fixture/accounts.json",
    cwd: "/fixture",
    operatorHome: "/fixture",
  });
  const load = vi.spyOn(accounts, "loadAccountDraft").mockResolvedValue(draft);
  const saved = vi.spyOn(accounts, "loadAccountPreferences").mockResolvedValue(preferences);
  const inventory = vi.spyOn(accounts, "discoverAccountHomes").mockResolvedValue([]);
  const validate = vi.spyOn(accounts, "validateAccountDraft").mockResolvedValue(draft);
  const save = vi.spyOn(accounts, "saveAccountPreferences").mockResolvedValue(undefined);
  const start = vi.fn(async (_draft: typeof draft, _signal: AbortSignal) => {});
  const cancellation = new AbortController();
  const listeners = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
  const exited = held(undefined);
  const unmount = vi.fn(() => {
    if (autoExit) exited.finish();
  });
  const waitUntilExit = vi.fn(() => exited.promise);
  let props!: AccountEditorProps;
  vi.mocked(render).mockImplementation((node) => {
    props = (node as ReactElement<AccountEditorProps>).props;
    return {
      unmount,
      waitUntilExit,
      rerender: vi.fn(),
      cleanup: vi.fn(),
      clear: vi.fn(),
      waitUntilRenderFlush: async () => {
        await exited.promise.catch(() => {});
      },
    };
  });
  const args = ["demo", {}, "/fixture/accounts.json", cancellation.signal, { start }] as const;
  const program = selectAccountsEffect(...args);
  const run = () => {
    const work = selectAccounts(...args);
    cleanup.push(async () => {
      cancellation.abort();
      exited.finish();
      await work.catch(() => {});
    });
    return work;
  };
  const fork = () => {
    const fiber = Effect.runFork(program);
    cleanup.push(() => Effect.runPromise(Fiber.interrupt(fiber)));
    return fiber;
  };
  const restored = () => {
    expect([process.listeners("SIGINT"), process.listeners("SIGTERM")]).toEqual(listeners);
  };
  return {
    preferences,
    draft,
    load,
    saved,
    inventory,
    validate,
    save,
    start,
    cancellation,
    exited,
    unmount,
    waitUntilExit,
    props: () => props,
    program,
    run,
    fork,
    restored,
  };
}

it("is lazy and retains the first selection until Ink has exited", async () => {
  const f = fixture(false);
  expect(f.load).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  const work = f.run();
  let settled = false;
  void work.then(() => {
    settled = true;
  });
  await expect.poll(() => f.props()).toBeDefined();
  await f.props().onStart(f.draft);
  f.props().onBack();
  f.props().onQuit();
  await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
  await setImmediate();
  expect(settled).toBe(false);
  f.exited.finish();
  expect(await work).toBe(f.draft);
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.load).toHaveBeenCalledOnce();
  expect(f.waitUntilExit).toHaveBeenCalledOnce();
  await expect(f.props().resolve(f.draft)).rejects.toThrow();
  await expect(f.props().onStart(f.draft)).rejects.toThrow();
  expect(f.validate).not.toHaveBeenCalled();
  expect(f.start).toHaveBeenCalledOnce();
  f.restored();
});

it.each(["back", "quit", "exit"] as const)(
  "returns the existing %s result after cleanup",
  async (event) => {
    const f = fixture(),
      work = f.run();
    await expect.poll(() => f.props()).toBeDefined();
    if (event === "back") f.props().onBack();
    else if (event === "quit") f.props().onQuit();
    else f.exited.finish();
    expect(await work).toBe(event === "quit" ? "quit" : null);
    expect(f.unmount).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
    f.restored();
  },
);

it.each(["SIGINT", "SIGTERM", "abort"] as const)(
  "handles %s and removes all owned listeners",
  async (event) => {
    const f = fixture(),
      work = f.run();
    const remove = vi.spyOn(f.cancellation.signal, "removeEventListener");
    await expect.poll(() => f.props()).toBeDefined();
    if (event === "abort") f.cancellation.abort();
    else process.emit(event);
    expect(await work).toBe("quit");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(f.unmount).toHaveBeenCalledOnce();
    f.restored();
  },
);

it("does not render when already cancelled", async () => {
  const f = fixture();
  f.cancellation.abort();
  expect(await f.run()).toBe("quit");
  expect(render).not.toHaveBeenCalled();
  f.restored();
});

it("releases the acquired UI after a process listener registration failure", async () => {
  const f = fixture(),
    cause = new Error("SIGTERM registration failed");
  const observer = (event: string | symbol) => {
    if (event === "SIGTERM") throw cause;
  };
  process.on("newListener", observer);
  try {
    const result = await Effect.runPromise(Effect.result(f.program));
    if (!Result.isFailure(result)) throw new Error("Expected registration failure");
    expect(result.failure).toMatchObject({ stage: "wait", cause, terminalState: "released" });
    expect(f.unmount).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
    f.restored();
  } finally {
    process.off("newListener", observer);
  }
});

it("continues teardown and drains work when a process removeListener observer throws", async () => {
  const f = fixture(),
    gate = held(undefined),
    cause = new Error("listener observer failed");
  const before = new Set([...process.listeners("SIGINT"), ...process.listeners("SIGTERM")]);
  f.start.mockReturnValueOnce(gate.promise);
  const work = Effect.runPromise(Effect.result(f.program));
  let settled = false;
  void work.then(() => {
    settled = true;
  });
  await expect.poll(() => f.props()).toBeDefined();
  const starting = f.props().onStart(f.draft);
  const observer = (event: string | symbol) => {
    if (event === "SIGINT") throw cause;
  };
  process.on("removeListener", observer);
  try {
    // External exit initiates release while start is still pending.
    f.exited.fail(new Error("renderer failed"));
    await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
    expect(f.start.mock.calls[0]![1].aborted).toBe(true);
    expect(settled).toBe(false);
    f.restored();
    gate.finish();
    await starting;
    const result = await work;
    if (!Result.isFailure(result)) throw new Error("Expected listener cleanup failure");
    expect(result.failure).toMatchObject({ stage: "cleanup", cause, terminalState: "unknown" });
  } finally {
    process.off("removeListener", observer);
    gate.finish();
    f.cancellation.abort();
    await starting;
    await work;
    // Also clean up listeners if the old implementation stopped after the first error.
    for (const event of ["SIGINT", "SIGTERM"] as const)
      for (const listener of process.listeners(event))
        if (!before.has(listener)) process.off(event, listener);
  }
});

it.each(["validation", "save", "start"] as const)(
  "drains pending %s before returning from cancellation",
  async (operation) => {
    const f = fixture(false),
      work = f.run();
    await expect.poll(() => f.props()).toBeDefined();
    const gate = held(f.draft);
    let action: Promise<unknown>;
    if (operation === "validation") {
      f.validate.mockReturnValueOnce(gate.promise);
      action = f.props().resolve(f.draft);
    } else if (operation === "save") {
      f.save.mockImplementationOnce(async () => {
        await gate.promise;
      });
      action = f.props().saveDefaults(f.preferences);
    } else {
      f.start.mockImplementationOnce(async () => {
        await gate.promise;
      });
      action = Promise.resolve(f.props().onStart(f.draft));
    }
    f.props().onQuit();
    let settled = false;
    void work.then(() => {
      settled = true;
    });
    await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
    if (operation === "start") expect(f.start.mock.calls[0]![1].aborted).toBe(true);
    f.exited.finish();
    await setImmediate();
    expect(settled).toBe(false);
    gate.finish();
    await action;
    expect(await work).toBe("quit");
    await expect(f.props().saveDefaults(f.preferences)).rejects.toThrow();
    await expect(f.props().resolve(f.draft)).rejects.toThrow();
    await expect(f.props().onStart(f.draft)).rejects.toThrow();
    expect(f.save).toHaveBeenCalledTimes(operation === "save" ? 1 : 0);
    expect(f.validate).toHaveBeenCalledTimes(operation === "validation" ? 1 : 0);
    expect(f.start).toHaveBeenCalledTimes(operation === "start" ? 1 : 0);
    f.restored();
  },
);

it("fiber interruption aborts an in-flight start and waits for both it and Ink", async () => {
  const f = fixture(false),
    gate = held(undefined);
  f.start.mockReturnValueOnce(gate.promise);
  const fiber = f.fork();
  await expect.poll(() => f.props()).toBeDefined();
  const starting = f.props().onStart(f.draft);
  let stopped = false;
  const stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
    stopped = true;
  });
  await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
  expect(f.start.mock.calls[0]![1].aborted).toBe(true);
  expect(stopped).toBe(false);
  gate.finish();
  await starting;
  await setImmediate();
  expect(stopped).toBe(false);
  f.exited.finish();
  await stopping;
  f.restored();
});

it("interruption during preparation waits for the outstanding read without rendering", async () => {
  const f = fixture(),
    gate = held(f.draft);
  f.load.mockReturnValueOnce(gate.promise);
  const fiber = f.fork();
  await expect.poll(() => f.load.mock.calls.length).toBe(1);
  let stopped = false;
  const stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
    stopped = true;
  });
  await setImmediate();
  expect(stopped).toBe(false);
  gate.finish();
  await stopping;
  expect(f.saved).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
});

it("keeps a rejected start in the form and allows an explicit retry", async () => {
  const f = fixture(),
    cause = new Error("creation failed");
  f.start.mockRejectedValueOnce(cause);
  const work = f.run();
  await expect.poll(() => f.props()).toBeDefined();
  await expect(f.props().onStart(f.draft)).rejects.toBe(cause);
  expect(f.unmount).not.toHaveBeenCalled();
  await f.props().onStart(f.draft);
  expect(await work).toBe(f.draft);
  expect(f.start).toHaveBeenCalledTimes(2);
});

it("treats failed home inventory as optional", async () => {
  const f = fixture();
  f.inventory.mockRejectedValueOnce(new Error("inventory unavailable"));
  const work = f.run();
  await expect.poll(() => f.props()).toBeDefined();
  expect(f.props().homes).toEqual([]);
  f.props().onQuit();
  await work;
});

it.each(["load_draft", "load_preferences", "render"] as const)(
  "retains typed %s failures and original Promise rejection values",
  async (stage) => {
    const f = fixture(),
      cause = { detail: "original failure" };
    const boundary =
      stage === "load_draft" ? f.load : stage === "load_preferences" ? f.saved : vi.mocked(render);
    boundary.mockImplementation(() => {
      throw cause;
    });
    const result = await Effect.runPromise(Effect.result(f.program));
    if (!Result.isFailure(result)) throw new Error("Expected preparation/render failure");
    expect(result.failure).toMatchObject({ stage, cause });
    expect(result.failure.terminalState).toBe(stage === "render" ? "unknown" : "untouched");
    expect(result.failure.message).toContain(`Account selection ${stage} failed`);
    await expect(f.run()).rejects.toBe(cause);
    expect(f.unmount).not.toHaveBeenCalled();
    f.restored();
  },
);

it("renderer failure aborts and drains an outstanding start before rejecting", async () => {
  const f = fixture(),
    gate = held(undefined),
    cause = new Error("renderer failed");
  f.start.mockReturnValueOnce(gate.promise);
  const work = f.run();
  const rejection = expect(work).rejects.toBe(cause);
  let settled = false;
  void work.catch(() => {
    settled = true;
  });
  await expect.poll(() => f.props()).toBeDefined();
  const starting = f.props().onStart(f.draft);
  f.exited.fail(cause);
  await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
  expect(f.start.mock.calls[0]![1].aborted).toBe(true);
  expect(settled).toBe(false);
  gate.finish();
  await starting;
  await rejection;
  f.restored();
});

it("keeps an unprintable original cause when constructing a typed diagnostic", async () => {
  const f = fixture(),
    cause: unknown = Object.create(null);
  f.load.mockRejectedValue(cause);
  const result = await Effect.runPromise(Effect.result(f.program));
  if (!Result.isFailure(result)) throw new Error("Expected account load failure");
  expect(result.failure.message).toBe("Account selection load_draft failed: Unknown failure");
  expect(result.failure.cause).toBe(cause);
  await expect(f.run()).rejects.toBe(cause);
});

it("cleanup failure wins over a synchronous wait failure while pending work still drains", async () => {
  const f = fixture(),
    gate = held(f.draft),
    cleanupError = new Error("unmount failed");
  f.validate.mockReturnValueOnce(gate.promise);
  f.waitUntilExit.mockImplementationOnce(() => {
    void f.props().resolve(f.draft);
    throw new Error("wait failed");
  });
  f.unmount.mockImplementationOnce(() => {
    throw cleanupError;
  });
  const work = Effect.runPromise(Effect.result(f.program));
  let settled = false;
  void work.then(() => {
    settled = true;
  });
  await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
  expect(settled).toBe(false);
  gate.finish();
  // A failed Ink unmount need not settle its exit promise.
  await expect.poll(() => settled).toBe(true);
  const result = await work;
  if (!Result.isFailure(result)) throw new Error("Expected cleanup failure");
  expect(result.failure).toMatchObject({ stage: "cleanup", cause: cleanupError });
  f.restored();
});

it.each(["before selection", "after selection", "synchronous"] as const)(
  "attributes Ink exit failure to wait (%s)",
  async (timing) => {
    const f = fixture(false),
      cause = { detail: "terminal failed" };
    if (timing === "synchronous")
      f.waitUntilExit.mockImplementationOnce(() => {
        throw cause;
      });
    const work = Effect.runPromise(Effect.result(f.program));
    await expect.poll(() => f.props()).toBeDefined();
    if (timing === "after selection") {
      f.props().onBack();
      await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
    }
    if (timing !== "synchronous") f.exited.fail(cause);
    else {
      await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
      f.exited.finish();
    }
    let settled = false;
    void work.then(() => {
      settled = true;
    });
    await expect.poll(() => settled).toBe(true);
    const result = await work;
    if (!Result.isFailure(result)) throw new Error("Expected wait failure");
    expect(result.failure.stage).toBe("wait");
    expect(result.failure.terminalState).toBe("released");
    expect(result.failure.cause).toBe(cause);
    expect(f.waitUntilExit).toHaveBeenCalledOnce();
    expect(f.unmount).toHaveBeenCalledOnce();
    f.restored();
  },
);

it.each([new Error("unmount failed"), undefined])(
  "drains work then rejects with the original unmount cause %s without an exit receipt",
  async (cause) => {
    const f = fixture(false),
      gate = held(undefined);
    f.start.mockReturnValueOnce(gate.promise);
    f.unmount.mockImplementationOnce(() => {
      throw cause;
    });
    const work = f.run();
    const rejection = expect(work).rejects.toBe(cause);
    let settled = false;
    void work.catch(() => {
      settled = true;
    });
    await expect.poll(() => f.props()).toBeDefined();
    const starting = f.props().onStart(f.draft);
    f.props().onQuit();
    await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
    expect(f.start.mock.calls[0]![1].aborted).toBe(true);
    await setImmediate();
    expect(settled).toBe(false);
    gate.finish();
    await starting;
    await expect.poll(() => settled).toBe(true);
    await rejection;
    expect(f.waitUntilExit).toHaveBeenCalledOnce();
    f.restored();
  },
);

it("interruption drains pending work despite an unmount exception and a pending exit", async () => {
  const f = fixture(false),
    gate = held(undefined);
  f.start.mockReturnValueOnce(gate.promise);
  f.unmount.mockImplementationOnce(() => {
    throw new Error("unmount failed");
  });
  const fiber = f.fork();
  await expect.poll(() => f.props()).toBeDefined();
  const starting = f.props().onStart(f.draft);
  let stopped = false;
  const stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
    stopped = true;
  });
  await expect.poll(() => f.unmount.mock.calls.length).toBe(1);
  expect(f.start.mock.calls[0]![1].aborted).toBe(true);
  await setImmediate();
  expect(stopped).toBe(false);
  gate.finish();
  await starting;
  await expect.poll(() => stopped).toBe(true);
  await stopping;
  expect(f.waitUntilExit).toHaveBeenCalledOnce();
  f.restored();
});
