import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanupAccountModelDiscovery,
  startAccountModelDiscovery,
} from "../src/adapters/account-model-discovery.js";
import * as lifetime from "../src/adapters/command-lifetime.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "epicd-discovery-cleanup-")));
  roots.push(path);
  return path;
}

it.each(["pending", "confirmed", "mismatched", "active"])(
  "reclaims only exact stop evidence for relinquished probes (%s)",
  async (mode) => {
    const parent = await root();
    const directory = await mkdtemp(join(parent, "model-"));
    await mkdir(join(directory, "workspace"), { mode: 0o700 });
    await mkdir(join(directory, "home"), { mode: 0o700 });
    await writeFile(join(directory, "home", "auth.json"), "credential-sentinel", { mode: 0o600 });
    const launch = {
      command: "/usr/bin/false",
      args: [],
      cwd: join(directory, "workspace"),
      env: {},
      extraInput: null,
    };
    const intent = await lifetime.prepareCommandLifetime(
      {
        runId: "account-discovery-test",
        operationId: randomUUID(),
        controllerLeaseId: randomUUID(),
        scopeDigest: "a".repeat(64),
        timeoutMs: 1000,
      },
      launch,
    );
    if (mode !== "pending") await lifetime.recoverCommandStop(intent);
    const saved = mode === "mismatched" ? { ...intent, ioId: randomUUID() } : intent;
    await writeFile(
      join(intent.directory.path, "intent.json"),
      JSON.stringify({ intent: saved, launch }),
      { mode: 0o600 },
    );
    if (mode !== "active")
      await writeFile(join(directory, "cleanup-pending"), "pending\n", { mode: 0o600 });
    await cleanupAccountModelDiscovery(parent);
    if (mode === "confirmed") expect(await readdir(parent)).toEqual([]);
    else
      expect(await readFile(join(directory, "home", "auth.json"), "utf8")).toBe(
        "credential-sentinel",
      );
  },
);

it("retains a timed-out probe and removes it when the delayed supervisor result proves stop", async () => {
  const parent = await root();
  let finish!: () => Promise<void>;
  const interrupt = vi.fn();
  vi.spyOn(lifetime, "startDurableCommand").mockImplementation((intent) => {
    const child = new ChildProcess() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const result = new Promise<Awaited<ReturnType<typeof lifetime.startDurableCommand>["result"]>>(
      (resolve) => {
        finish = async () => {
          const receipt = await lifetime.recoverCommandStop(intent);
          if (!receipt) throw new Error("Fixture stop was not proven");
          resolve({ receipt, code: null, signal: null });
        };
      },
    );
    return { child, result, input: new PassThrough(), interrupt };
  });
  const probe = await startAccountModelDiscovery(
    await realpath("/usr/bin/false"),
    { root: parent, source: null },
    10000,
  );
  const directory = join(parent, (await readdir(parent))[0]!);
  const cache = join(directory, "home", "auth.json");
  await writeFile(cache, "credential-sentinel", { mode: 0o600 });
  const stopped = await new Promise<Error | undefined>((resolve) => probe.stop(resolve));
  expect(stopped?.message).toContain("cleanup is pending");
  expect(interrupt).toHaveBeenCalledOnce();
  expect(await readFile(cache, "utf8")).toBe("credential-sentinel");
  await finish();
  await expect.poll(() => readdir(parent)).toEqual([]);
});
