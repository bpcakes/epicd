import { once } from "node:events";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  NamespaceStopUnprovenError,
  startNamespaceProcess,
} from "../src/adapters/pid-namespace.js";

const active = new Set<ReturnType<typeof startNamespaceProcess>>();
afterEach(async () => {
  for (const namespace of active) {
    namespace.interrupt();
    if (namespace.child.exitCode === null && namespace.child.signalCode === null)
      await once(namespace.child, "close");
  }
  active.clear();
});

function start(command: string, args: string[], timeoutMs?: number) {
  const namespace = startNamespaceProcess(command, args, {
    cwd: process.cwd(),
    env: { PATH: "/usr/bin:/bin" },
    stdio: "pipe",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  active.add(namespace);
  return namespace;
}

describe.skipIf(process.platform !== "linux")("private namespace completion", () => {
  it("keeps a nonzero target exit distinct from timeout and cancellation", async () => {
    const namespace = start("/bin/sh", ["-c", "exit 7"], 5000);
    expect((await once(namespace.child, "close"))[0]).toBe(7);
    expect(namespace.failure()).toBeUndefined();
    expect(namespace.completion()).toEqual({ code: 7, reason: null });
  });

  it("does not let the repository command inherit the private completion descriptor", async () => {
    const namespace = start("/bin/sh", [
      "-c",
      "if (printf forged >&6) 2>/dev/null; then exit 71; fi; printf safe",
    ]);
    let output = "";
    namespace.child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    expect((await once(namespace.child, "close"))[0]).toBe(0);
    expect(output).toBe("safe");
    expect(namespace.failure()).toBeUndefined();
    expect(namespace.completion()).toEqual({ code: 0, reason: null });
  });

  it("retains an exact cancellation cause independently of target output", async () => {
    const namespace = start("/bin/sh", ["-c", "printf ready; exec /bin/sleep 30"]);
    const closed = once(namespace.child, "close");
    await once(namespace.child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
    namespace.interrupt();
    expect((await closed)[0]).toBe(130);
    expect(namespace.completion()).toEqual({ code: 130, reason: "cancelled" });
  });

  it("rejects a missing completion channel even when its monitor exits normally", async () => {
    const namespace = start("/bin/sh", ["-c", "printf ready; /bin/sleep 0.5; exit 0"]);
    const closed = once(namespace.child, "close");
    await once(namespace.child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
    const completion = namespace.child.stdio.at(6) as Readable;
    // Drop only this test's received diagnostic bytes. A normal monitor exit alone
    // must not synthesize a missing command result.
    completion.removeAllListeners("data");
    completion.resume();
    expect((await closed)[0]).toBe(0);
    expect(() => namespace.completion()).toThrow(NamespaceStopUnprovenError);
  });

  it("does not accept a completion after an externally killed monitor", async () => {
    const namespace = start("/bin/sh", ["-c", "printf ready; exec /bin/sleep 30"]);
    const closed = once(namespace.child, "close");
    await once(namespace.child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
    namespace.child.kill("SIGKILL");
    await closed;
    expect(namespace.failure()).toBeInstanceOf(NamespaceStopUnprovenError);
    expect(() => namespace.completion()).toThrow(NamespaceStopUnprovenError);
  });

  it("rejects invalid deadline values before launching a process", () => {
    for (const timeoutMs of [0, -1, 0.5, Number.NaN, 2_147_483_648]) {
      expect(() => start("/bin/true", [], timeoutMs)).toThrow("positive bounded integer");
    }
  });
});
