import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { afterEach, expect, it, vi } from "vitest";
import { loadRepositoryPolicyEffect } from "../src/adapters/repository-policy.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync("/var/tmp/epicd-policy-effect-");
  roots.push(root);
  return { root, directory: join(root, ".epicd"), path: join(root, ".epicd", "policy.json") };
}
const run = (root: string) => Effect.runPromise(Effect.result(loadRepositoryPolicyEffect(root)));

it.each([true, false])(
  "rejects a symlinked policy directory without writing outside the repository (target exists: %s)",
  async (targetExists) => {
    const f = fixture(),
      outside = fixture(),
      target = join(outside.root, "policy-directory");
    if (targetExists) {
      mkdirSync(target);
      writeFileSync(join(target, "keep.txt"), "user-owned\n");
    }
    symlinkSync(target, f.directory);
    const result = await run(f.root);
    if (!Result.isFailure(result)) throw new Error("Expected aliased directory rejection");
    expect(result.failure).toMatchObject({ stage: "initialize", path: f.path });
    expect(result.failure.message).toContain("Policy directory must be a real directory");
    if (targetExists) {
      expect(readdirSync(target)).toEqual(["keep.txt"]);
      expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("user-owned\n");
    } else expect(existsSync(target)).toBe(false);
    expect(existsSync(f.path)).toBe(false);
  },
);

it("is lazy and concurrent first starts read one complete default declaration", async () => {
  const f = fixture();
  const program = loadRepositoryPolicyEffect(f.root);
  expect(existsSync(f.directory)).toBe(false);
  const policies = await Promise.all(Array.from({ length: 6 }, () => Effect.runPromise(program)));
  const file = JSON.parse(readFileSync(f.path, "utf8"));
  for (const policy of policies) expect(policy).toEqual(file);
  expect(file.budgets.maxWorkers).toBe(4);
  expect(readdirSync(f.directory)).toEqual(["policy.json"]);
});

it("reads a competing creator's policy without overwriting its bytes", async () => {
  const f = fixture();
  const original = fs.link;
  const declaration = '{"schemaVersion":1,"budgets":{"maxWorkers":1}}\n';
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    writeFileSync(f.path, declaration);
    await original(from, to);
  });
  const policy = await Effect.runPromise(loadRepositoryPolicyEffect(f.root));
  expect(policy.budgets.maxWorkers).toBe(1);
  expect(readFileSync(f.path, "utf8")).toBe(declaration);
  expect(readdirSync(f.directory)).toEqual(["policy.json"]);
});

it.each(["writeFile", "link"] as const)(
  "cleans the temporary directory after %s fails",
  async (operation) => {
    const f = fixture(),
      cause = new Error("injected filesystem failure");
    vi.spyOn(fs, operation).mockRejectedValueOnce(cause);
    const result = await run(f.root);
    if (!Result.isFailure(result)) throw new Error("Expected policy failure");
    expect(result.failure).toMatchObject({
      _tag: "RepositoryPolicyError",
      stage: operation === "link" ? "publish" : "write",
      path: f.path,
    });
    expect(result.failure.cause).toBe(cause);
    expect(readdirSync(f.directory)).toEqual([]);
  },
);

it("does not release a temporary directory when acquisition failed", async () => {
  const f = fixture(),
    cause = new Error("cannot allocate temporary directory");
  vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(cause);
  const remove = vi.spyOn(fs, "rm");
  const result = await run(f.root);
  if (!Result.isFailure(result)) throw new Error("Expected acquisition failure");
  expect(result.failure.stage).toBe("initialize");
  expect(result.failure.cause).toBe(cause);
  expect(remove).not.toHaveBeenCalled();
  expect(existsSync(f.path)).toBe(false);
});

it.each([false, true])(
  "reports cleanup failure, including when writing also failed (%s)",
  async (writeFails) => {
    const f = fixture(),
      cleanupFailure = new Error("cleanup denied");
    if (writeFails) vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("write failed"));
    vi.spyOn(fs, "rm").mockRejectedValueOnce(cleanupFailure);
    const result = await run(f.root);
    if (!Result.isFailure(result)) throw new Error("Expected cleanup failure");
    expect(result.failure.stage).toBe("cleanup");
    expect(result.failure.cause).toBe(cleanupFailure);
    expect(existsSync(f.path)).toBe(!writeFails);
  },
);

it("keeps decode failures typed and preserves the invalid file", async () => {
  const f = fixture();
  mkdirSync(f.directory);
  writeFileSync(f.path, "{invalid");
  const result = await run(f.root);
  if (!Result.isFailure(result)) throw new Error("Expected decode failure");
  expect(result.failure).toMatchObject({ stage: "decode", path: f.path });
  expect(readFileSync(f.path, "utf8")).toBe("{invalid");
});

it("waits for an interrupted write to settle before removing its directory", async () => {
  const f = fixture();
  const write = fs.writeFile;
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
    await held;
    await write(...args);
  });
  const remove = vi.spyOn(fs, "rm"),
    publish = vi.spyOn(fs, "link");
  const fiber = Effect.runFork(loadRepositoryPolicyEffect(f.root));
  let stopped = false;
  let stopping: Promise<void> | undefined;
  try {
    await expect.poll(() => started.mock.calls.length).toBe(1);
    stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      stopped = true;
    });
    await setImmediate();
    expect(stopped).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    finish();
    await stopping;
    expect(publish).not.toHaveBeenCalled();
    expect(readdirSync(f.directory)).toEqual([]);
  } finally {
    finish();
    await Effect.runPromise(Fiber.interrupt(fiber));
    await stopping;
  }
});
