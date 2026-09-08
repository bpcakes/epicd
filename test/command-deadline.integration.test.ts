import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { startConfinedCommand, type ConfinedCommandHandle } from "../src/adapters/sandbox.js";

const roots: string[] = [];
const active = new Set<ConfinedCommandHandle>();
afterEach(async () => {
  for (const handle of active) handle.interrupt();
  const stopped = await Promise.allSettled([...active].map((handle) => handle.result));
  active.clear();
  if (stopped.some((result) => result.status === "rejected")) {
    const retained = roots.splice(0);
    throw new Error(`Command stop is uncertain; preserve test workspaces: ${retained.join(", ")}`);
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(durable: boolean) {
  const root = await mkdtemp(join(tmpdir(), "epicd-command-deadline-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  return {
    workspace,
    options: durable
      ? {
          durableStop: {
            runId: randomUUID(),
            operationId: randomUUID(),
            controllerLeaseId: randomUUID(),
            scopeDigest: "c".repeat(64),
            admit: () => {},
          },
        }
      : {},
  };
}

function stallCaller(ms: number) {
  // Only this test's controller stalls; the actual namespace and command keep running.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function commandStarted(workspace: string) {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      if ((await readFile(join(workspace, "started.txt"), "utf8")) === "started") return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline)
      throw new Error("Command did not establish the stall-test precondition");
    await delay(5);
  }
}

describe.skipIf(process.platform !== "linux")("independent confined-command deadline", () => {
  for (const durable of [false, true]) {
    const mode = durable ? "durable receipt" : "ordinary namespace";
    it(`${mode}: does not classify a finished command from a delayed caller timer`, async () => {
      const { workspace, options } = await fixture(durable);
      const handle = await startConfinedCommand(
        {
          workspace,
          sourceMode: "workspace-write",
          command: "/bin/sh",
          args: ["-c", "printf started > started.txt; /bin/sleep 0.5; /bin/date +%s.%N; exit 0"],
          timeoutMs: 2000,
        },
        options,
      );
      active.add(handle);
      await commandStarted(workspace);
      stallCaller(4000);
      const result = await handle.result;
      const printedAt = Number(result.stdout.trim()) * 1000;
      // The command itself reports when it ran, independent of callback delivery.
      expect(Number.isFinite(printedAt)).toBe(true);
      expect(printedAt - Date.parse(result.startedAt)).toBeGreaterThanOrEqual(0);
      expect(printedAt - Date.parse(result.startedAt)).toBeLessThan(2000);
      expect(Date.parse(result.endedAt) - Date.parse(result.startedAt)).toBeGreaterThanOrEqual(
        3900,
      );
      expect(result).toMatchObject({ status: "succeeded", exitCode: 0, processTreeStopped: true });
    });

    it(`${mode}: enforces the actual deadline while the caller is blocked`, async () => {
      const { workspace, options } = await fixture(durable);
      const handle = await startConfinedCommand(
        {
          workspace,
          sourceMode: "workspace-write",
          command: "/bin/sh",
          args: [
            "-c",
            "printf started; printf started > started.txt; /bin/sleep 2; printf late > expired.txt",
          ],
          timeoutMs: 1000,
        },
        options,
      );
      active.add(handle);
      await commandStarted(workspace);
      stallCaller(4000);
      const result = await handle.result;
      expect(result).toMatchObject({
        status: "timed_out",
        stdout: "started",
        processTreeStopped: true,
      });
      await expect(readFile(join(workspace, "expired.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  }
});
