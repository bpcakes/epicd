import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("does not treat Ink's async listener-registration rejection as a release receipt", async () => {
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    import { PassThrough } from "node:stream";
    import { setImmediate } from "node:timers/promises";
    import { createElement } from "react";
    import { render, Text } from "ink";
    import * as Effect from "effect/Effect";
    import * as Result from "effect/Result";
    import { inkLifecycle } from "./src/tui/ink-lifecycle.ts";
    const terminal = new PassThrough(); terminal.resume();
    const ui = render(createElement(Text, null, "fixture"), {
      stdout: terminal, stderr: terminal, stdin: new PassThrough(),
      interactive: false, patchConsole: false, debug: true, exitOnCtrlC: false,
    });
    await ui.waitUntilRenderFlush();
    const cause = new Error("beforeExit registration failed");
    const observer = (event) => { if (event === "beforeExit") throw cause; };
    process.on("newListener", observer);
    const session = inkLifecycle(ui);
    process.off("newListener", observer);
    const early = await session.exited;
    assert.equal(early.failure.cause, cause);
    assert.equal(early.failure.terminalState, "unknown");
    const write = terminal.write.bind(terminal);
    let flush;
    terminal.write = (chunk, ...args) => {
      if (chunk === "") { flush = args.find((value) => typeof value === "function"); return true; }
      return write(chunk, ...args);
    };
    let settled = false, drained = false;
    const releasing = Effect.runPromise(Effect.result(session.release(
      Effect.sync(() => { drained = true; }),
    ))).then((value) => { settled = true; return value; });
    await setImmediate();
    assert.equal(drained, true);
    assert.equal(typeof flush, "function");
    assert.equal(settled, false);
    flush();
    const final = await releasing;
    assert.equal(final.failure.cause, cause);
    assert.equal(final.failure.stage, "wait");
    assert.equal(final.failure.terminalState, "released");
    process.stdout.write("independent release receipt verified\\n");
  `,
    ],
    { timeout: 20_000 },
  );
  expect(result.stdout).toBe("independent release receipt verified\n");
});

it.each(["AccountSelectionFailed", "EpicPickerFailed"] as const)(
  "terminates after %s even when stderr is a pipe that nobody drains",
  async (failureClass) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
      import assert from "node:assert/strict";
      import { AccountSelectionFailed } from "./src/tui/account-editor-session.tsx";
      import { EpicPickerFailed } from "./src/tui/epic-picker-session.tsx";
      import { reportCliFailure } from "./src/cli.tsx";
      process.send("ready");
      await new Promise((resolve) => process.once("message", resolve));
      process.disconnect();
      // A cold tsx/esbuild load changes the inherited stderr descriptor to
      // blocking mode. Restore the asynchronous pipe this test is exercising;
      // the packaged executable does not run a TypeScript compiler at startup.
      process.stderr._handle.setBlocking(false);
      // Fill the real asynchronous pipe beyond its capacity. The parent leaves
      // stderr unread, so the diagnostic's write callback cannot complete.
      assert.equal(process.stderr.write("x".repeat(4 * 1024 * 1024)), false);
      process.stdout.write("pipe blocked\\n");
      setInterval(() => {}, 1000);
      reportCliFailure(new ${failureClass}({
        stage: "cleanup", cause: new Error("terminal teardown failed"), terminalState: "unknown",
      }));
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    if (!child.stdout || !child.stderr) {
      child.kill("SIGKILL");
      throw new Error("Expected piped child output");
    }
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    let startup = "";
    const readStartup = (chunk: Buffer) => {
      startup += chunk.toString();
    };
    child.stderr.on("data", readStartup);
    const completed = once(child, "exit");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const [ready] = await Promise.race([
        once(child, "message"),
        completed.then(() => {
          throw new Error(`Child failed before pipe test: ${startup}`);
        }),
      ]);
      expect(ready).toBe("ready");
      child.stderr.pause();
      child.stderr.off("data", readStartup);
      child.send("fill pipe");
      const [code, signal] = await completed;
      expect(stdout).toBe("pipe blocked\n");
      expect(signal).toBeNull();
      expect(code).toBe(1);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    }
  },
);

it("drains owned work then reports unknown state when real Ink cannot flush stdout", async () => {
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    import { PassThrough } from "node:stream";
    import { createElement } from "react";
    import { render, Text } from "ink";
    import * as Effect from "effect/Effect";
    import * as Result from "effect/Result";
    import { inkLifecycle } from "./src/tui/ink-lifecycle.ts";
    import { AccountSelectionFailed } from "./src/tui/account-editor-session.tsx";
    import { reportCliFailure } from "./src/cli.tsx";
    const terminal = new PassThrough(); terminal.resume();
    const ui = render(createElement(Text, null, "fixture"), {
      stdout: terminal, stderr: terminal, stdin: new PassThrough(),
      interactive: false, patchConsole: false, debug: true, exitOnCtrlC: false,
    });
    await ui.waitUntilRenderFlush();
    const session = inkLifecycle(ui);
    terminal.pause();
    assert.equal(terminal.write("x".repeat(4 * 1024 * 1024)), false);
    let drained = false, exited = false;
    void session.exited.then(() => { exited = true; });
    const result = await Effect.runPromise(Effect.result(session.release(Effect.promise(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      drained = true;
    }))));
    assert.equal(drained, true);
    assert.equal(exited, false);
    assert.equal(result.failure.stage, "cleanup");
    assert.equal(result.failure.terminalState, "unknown");
    assert.match(result.failure.cause.message, /terminal output did not finish/);
    process.stdout.write("owned work drained before failed flush was reported\\n");
    setInterval(() => {}, 1000);
    reportCliFailure(new AccountSelectionFailed({
      stage: result.failure.stage, cause: result.failure.cause, terminalState: result.failure.terminalState,
    }));
  `,
    ],
    { timeout: 20_000 },
  ).then(
    (output) => ({ ...output, code: 0, signal: null }),
    (error: { stdout: string; stderr: string; code: unknown; signal: unknown }) => error,
  );
  expect(result.stdout).toBe("owned work drained before failed flush was reported\n");
  expect(result.code).toBe(1);
  expect(result.signal).toBeNull();
  expect(result.stderr).toContain("terminal output did not finish");
});

it("reports an actual Ink teardown exception and terminates through the CLI boundary", async () => {
  // A failed unmount can leave Ink's process-global state partially torn down.
  // Keep this dependency-contract check in a disposable child process.
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
        import assert from "node:assert/strict";
        import { PassThrough } from "node:stream";
        import { setImmediate } from "node:timers/promises";
        import { createElement } from "react";
        import { render, Text } from "ink";
        import * as Effect from "effect/Effect";
        import * as Result from "effect/Result";
        import { inkLifecycle } from "./src/tui/ink-lifecycle.ts";
        import { AccountSelectionFailed } from "./src/tui/account-editor-session.tsx";
        import { reportCliFailure } from "./src/cli.tsx";

        const terminal = new PassThrough();
        terminal.resume();
        const ui = render(createElement(Text, null, "fixture"), {
          stdout: terminal, stderr: terminal, stdin: new PassThrough(),
          interactive: false, debug: true, patchConsole: false, exitOnCtrlC: false,
        });
        const session = inkLifecycle(ui);
        await ui.waitUntilRenderFlush();
        const cause = new Error("terminal write failed during unmount token=fixture-secret");
        terminal.write = () => { throw cause; };
        let exited = false, drained = false;
        void session.exited.then(() => { exited = true; });
        const result = await Effect.runPromise(Effect.result(session.release(
          Effect.sync(() => { drained = true; }),
        )));
        assert.equal(Result.isFailure(result), true);
        assert.equal(result.failure.stage, "cleanup");
        assert.equal(result.failure.cause, cause);
        assert.equal(result.failure.terminalState, "unknown");
        assert.equal(drained, true);
        await setImmediate();
        assert.equal(exited, false);
        process.stdout.write("verified\\n");
        // Partial teardown can retain handles. The production failure handler
        // must end the executable even when the event loop cannot drain itself.
        setInterval(() => {}, 1000);
        reportCliFailure(new AccountSelectionFailed({
          stage: result.failure.stage, cause: result.failure.cause,
          terminalState: result.failure.terminalState,
        }));
      `,
    ],
    { timeout: 20_000 },
  ).then(
    (output) => ({ ...output, code: 0, signal: null }),
    (error: { stdout: string; stderr: string; code: unknown; signal: unknown }) => error,
  );
  expect(result.code).toBe(1);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("verified\n");
  expect(result.stderr).toContain("Account selection cleanup failed");
  expect(result.stderr).toContain("token=[REDACTED]");
  expect(result.stderr).not.toContain("fixture-secret");
});

it("reuses a real Ink terminal after an error exit and reports without forcing process exit", async () => {
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
      import assert from "node:assert/strict";
      import { PassThrough } from "node:stream";
      import { setImmediate } from "node:timers/promises";
      import { createElement, useEffect } from "react";
      import { render, Text, useApp } from "ink";
      import * as Effect from "effect/Effect";
      import * as Result from "effect/Result";
      import { inkLifecycle } from "./src/tui/ink-lifecycle.ts";
      import { AccountSelectionFailed } from "./src/tui/account-editor-session.tsx";
      import { reportCliFailure } from "./src/cli.tsx";
      const terminal = new PassThrough();
      let output = "";
      terminal.on("data", (chunk) => { output += chunk.toString(); });
      const options = { stdout: terminal, stderr: terminal, stdin: new PassThrough(),
        interactive: false, debug: true, patchConsole: false, exitOnCtrlC: false };
      const cause = new Error("component failed");
      function FailedApp() {
        const { exit } = useApp();
        useEffect(() => { exit(cause); }, [exit]);
        return createElement(Text, null, "first renderer");
      }
      const first = inkLifecycle(render(createElement(FailedApp), options));
      await first.exited;
      const result = await Effect.runPromise(Effect.result(first.release()));
      assert.equal(Result.isFailure(result), true);
      assert.equal(result.failure.stage, "wait");
      assert.equal(result.failure.terminalState, "released");
      assert.equal(result.failure.cause, cause);
      const next = render(createElement(Text, null, "second renderer"), options);
      const second = inkLifecycle(next);
      await next.waitUntilRenderFlush();
      await Effect.runPromise(second.release());
      assert.ok(output.includes("second renderer"));
      reportCliFailure(new AccountSelectionFailed({
        stage: result.failure.stage, cause, terminalState: result.failure.terminalState,
      }));
      await setImmediate();
      process.stdout.write("continued after reporting\\n");
    `,
    ],
    { timeout: 20_000 },
  ).then(
    (output) => ({ ...output, code: 0, signal: null }),
    (error: { stdout: string; stderr: string; code: unknown; signal: unknown }) => error,
  );
  expect(result.code).toBe(1);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("continued after reporting\n");
  expect(result.stderr).toContain("Account selection wait failed: component failed");
  expect(result.stderr).not.toContain("Reusing stdout");
});

it("treats an exception inside the real Ink constructor as unknown terminal state", async () => {
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
      import assert from "node:assert/strict";
      import { PassThrough } from "node:stream";
      import { createElement } from "react";
      import { render, Text } from "ink";
      import { AccountSelectionFailed } from "./src/tui/account-editor-session.tsx";
      import { reportCliFailure } from "./src/cli.tsx";
      const terminal = new PassThrough();
      terminal.resume();
      const cause = new Error("resize registration failed during construction");
      const on = terminal.on.bind(terminal);
      terminal.on = (event, listener) => {
        if (event === "resize") throw cause;
        return on(event, listener);
      };
      let caught;
      try {
        render(createElement(Text, null, "never rendered"), {
          stdout: terminal, stderr: terminal, stdin: new PassThrough(),
          interactive: true, patchConsole: false, exitOnCtrlC: false,
        });
      } catch (error) { caught = error; }
      assert.equal(caught, cause);
      process.stdout.write("constructor failed before returning a handle\\n");
      setInterval(() => {}, 1000);
      reportCliFailure(new AccountSelectionFailed({
        stage: "render", cause, terminalState: "unknown",
      }));
    `,
    ],
    { timeout: 20_000 },
  ).then(
    (output) => ({ ...output, code: 0, signal: null }),
    (error: { stdout: string; stderr: string; code: unknown; signal: unknown }) => error,
  );
  expect(result.code).toBe(1);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("constructor failed before returning a handle\n");
  expect(result.stderr).toContain("Account selection render failed: resize registration failed");
});
