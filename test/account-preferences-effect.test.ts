import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { afterEach, expect, it, vi } from "vitest";
import { AccountPreferencesSchema } from "../src/domain/accounts.js";
import { saveAccountPreferences, saveAccountPreferencesEffect } from "../src/adapters/accounts.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
const roots: string[] = [];
const releases: (() => void)[] = [];
const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const stop of stops.splice(0)) await stop();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function gate() {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  releases.push(finish);
  return { promise, finish };
}
type Operation =
  | "open_file"
  | "write"
  | "sync_file"
  | "close_file"
  | "rename"
  | "open_directory"
  | "sync_directory"
  | "close_directory"
  | "unlink";
function fixture(failures: Partial<Record<Operation, Error>> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "epicd-preferences-effect-")));
  roots.push(root);
  const path = join(root, "accounts.json");
  const old = '{"schemaVersion":1,"defaultCodexHome":"/old"}\n';
  writeFileSync(path, old, { mode: 0o600 });
  const preferences = AccountPreferencesSchema.parse({
    schemaVersion: 1,
    defaultCodexHome: "/new",
  });
  const events: Operation[] = [];
  const held: Partial<Record<Operation, ReturnType<typeof gate>>> = {};
  const before = async (operation: Operation) => {
    events.push(operation);
    if (held[operation]) await held[operation].promise;
    if (failures[operation]) throw failures[operation];
  };
  const open = fs.open,
    rename = fs.rename,
    unlink = fs.unlink;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const kind = args[1] === "wx" ? "file" : args[1] === "r" ? "directory" : null;
    if (kind) await before(kind === "file" ? "open_file" : "open_directory");
    const file = await open(...args);
    if (kind) {
      const write = file.writeFile.bind(file),
        sync = file.sync.bind(file),
        close = file.close.bind(file);
      if (kind === "file")
        vi.spyOn(file, "writeFile").mockImplementation(async (...input) => {
          await before("write");
          await write(...input);
        });
      vi.spyOn(file, "sync").mockImplementation(async () => {
        await before(kind === "file" ? "sync_file" : "sync_directory");
        await sync();
      });
      vi.spyOn(file, "close").mockImplementation(async () => {
        // Close the real fixture descriptor even when injecting a reported close error.
        await close();
        await before(kind === "file" ? "close_file" : "close_directory");
      });
    }
    return file;
  });
  vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
    await before("rename");
    await rename(...args);
  });
  vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
    await before("unlink");
    await unlink(...args);
  });
  const program = saveAccountPreferencesEffect(preferences, path);
  const run = () => Effect.runPromise(Effect.result(program));
  const fork = () => {
    const fiber = Effect.runFork(program);
    stops.push(() => Effect.runPromise(Fiber.interrupt(fiber)));
    return fiber;
  };
  const published = () => JSON.parse(readFileSync(path, "utf8"));
  return { root, path, old, preferences, events, held, program, run, fork, published };
}

it("is lazy and preserves write, sync, close, publish, directory sync, and cleanup order", async () => {
  const f = fixture();
  expect(f.events).toEqual([]);
  expect(readFileSync(f.path, "utf8")).toBe(f.old);
  const result = await f.run();
  expect(Result.isSuccess(result)).toBe(true);
  expect(f.events).toEqual([
    "open_file",
    "write",
    "sync_file",
    "close_file",
    "rename",
    "open_directory",
    "sync_directory",
    "close_directory",
    "unlink",
  ]);
  expect(f.published()).toEqual(f.preferences);
  expect(readdirSync(f.root)).toEqual(["accounts.json"]);
});

it.each([
  ["open_file", "open", false],
  ["write", "write", false],
  ["sync_file", "sync", false],
  ["close_file", "close", false],
  ["rename", "publish", false],
  ["open_directory", "open", true],
  ["sync_directory", "sync", true],
  ["close_directory", "close", true],
] as const)(
  "retains %s failures and the actual publication state",
  async (operation, stage, published) => {
    const cause = new Error(`injected ${operation}`),
      f = fixture({ [operation]: cause });
    const result = await f.run();
    if (!Result.isFailure(result)) throw new Error("Expected save failure");
    expect(result.failure.stage).toBe(stage);
    expect(result.failure.message).toContain(`Account preferences ${stage} failed`);
    expect(result.failure.cause).toBe(cause);
    if (published) expect(f.published()).toEqual(f.preferences);
    else expect(readFileSync(f.path, "utf8")).toBe(f.old);
    expect(readdirSync(f.root)).toEqual(["accounts.json"]);
    if (operation !== "open_file") expect(f.events).toContain("close_file");
    if (operation === "sync_directory" || operation === "close_directory")
      expect(f.events).toContain("close_directory");
  },
);

it("preserves original Promise rejection identity", async () => {
  const cause = new Error("write failed"),
    f = fixture({ write: cause });
  await expect(saveAccountPreferences(f.preferences, f.path)).rejects.toBe(cause);
  expect(readFileSync(f.path, "utf8")).toBe(f.old);
});

it.each([false, true])(
  "cleanup error takes precedence over a write error (unlink failure: %s)",
  async (unlinkFails) => {
    const close = new Error("close failed"),
      unlink = new Error("unlink failed");
    const f = fixture({
      write: new Error("write failed"),
      close_file: close,
      ...(unlinkFails ? { unlink } : {}),
    });
    const result = await f.run();
    if (!Result.isFailure(result)) throw new Error("Expected cleanup failure");
    expect(result.failure.stage).toBe(unlinkFails ? "cleanup" : "close");
    expect(result.failure.cause).toBe(unlinkFails ? unlink : close);
    expect(readFileSync(f.path, "utf8")).toBe(f.old);
    expect(readdirSync(f.root).filter((name) => name.endsWith(".tmp"))).toHaveLength(
      unlinkFails ? 1 : 0,
    );
  },
);

it.each(["validate", "prepare", "read_existing"] as const)(
  "rejects at %s before opening a temporary file",
  async (stage) => {
    const f = fixture();
    if (stage === "validate") f.preferences.defaultCodexHome = "";
    else if (stage === "prepare") chmodSync(f.root, 0o755);
    else writeFileSync(f.path, "malformed existing preferences");
    const before = readFileSync(f.path, "utf8");
    const result = await f.run();
    if (!Result.isFailure(result)) throw new Error("Expected preferences failure");
    expect(result.failure.stage).toBe(stage);
    expect(result.failure.cause).toBeInstanceOf(Error);
    expect(f.events).toEqual([]);
    expect(readFileSync(f.path, "utf8")).toBe(before);
    expect(readdirSync(f.root)).toEqual(["accounts.json"]);
  },
);

it.each(["publication", "directory durability"] as const)(
  "preserves cleanup precedence and disk state after paired %s failures",
  async (phase) => {
    const cause = new Error("cleanup failed");
    const f = fixture(
      phase === "publication"
        ? { rename: new Error("rename failed"), unlink: cause }
        : { sync_directory: new Error("directory sync failed"), close_directory: cause },
    );
    const result = await f.run();
    if (!Result.isFailure(result)) throw new Error("Expected cleanup failure");
    expect(result.failure.cause).toBe(cause);
    expect(result.failure.stage).toBe(phase === "publication" ? "cleanup" : "close");
    if (phase === "publication") {
      expect(readFileSync(f.path, "utf8")).toBe(f.old);
      expect(readdirSync(f.root).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
    } else {
      expect(f.published()).toEqual(f.preferences);
      expect(readdirSync(f.root)).toEqual(["accounts.json"]);
    }
  },
);

it.each(["permission denied", "symlink", "shared mode"] as const)(
  "retains an existing-file %s failure without publishing or creating a temporary file",
  async (kind) => {
    const f = fixture();
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    if (kind === "symlink") {
      renameSync(f.path, join(f.root, "original.json"));
      symlinkSync("original.json", f.path);
    } else if (kind === "shared mode") chmodSync(f.path, 0o640);
    else {
      const open = vi.mocked(fs.open).getMockImplementation()!;
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        if (args[0] === f.path) throw denied;
        return open(...args);
      });
    }
    const entries = readdirSync(f.root);
    const result = await f.run();
    if (!Result.isFailure(result)) throw new Error("Expected existing-file rejection");
    expect(result.failure.stage).toBe("read_existing");
    if (kind === "permission denied") expect(result.failure.cause).toBe(denied);
    expect(f.events).toEqual([]);
    expect(readFileSync(f.path, "utf8")).toBe(f.old);
    expect(readdirSync(f.root)).toEqual(entries);
  },
);

it.each(["open_file", "write", "sync_file", "close_file"] as const)(
  "drains interrupted %s before removing the unpublished temporary file",
  async (operation) => {
    const f = fixture();
    const blocked = gate();
    f.held[operation] = blocked;
    const fiber = f.fork();
    await expect.poll(() => f.events.includes(operation)).toBe(true);
    let stopped = false;
    const stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      stopped = true;
    });
    await setImmediate();
    expect(stopped).toBe(false);
    if (operation === "write") expect(f.events).not.toContain("close_file");
    expect(f.events).not.toContain("rename");
    expect(f.events).not.toContain("unlink");
    blocked.finish();
    await stopping;
    expect(f.events).toContain("close_file");
    expect(f.events).not.toContain("rename");
    expect(readFileSync(f.path, "utf8")).toBe(f.old);
    expect(readdirSync(f.root)).toEqual(["accounts.json"]);
  },
);

it.each(["open_directory", "close_directory"] as const)(
  "finishes durability and cleanup before acknowledging interruption during %s",
  async (operation) => {
    const f = fixture(),
      blocked = gate();
    f.held[operation] = blocked;
    const fiber = f.fork();
    await expect.poll(() => f.events.includes(operation)).toBe(true);
    expect(f.published()).toEqual(f.preferences);
    let stopped = false;
    const stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      stopped = true;
    });
    await setImmediate();
    expect(stopped).toBe(false);
    expect(f.events).not.toContain("unlink");
    blocked.finish();
    await stopping;
    expect(f.events.slice(-3)).toEqual(["sync_directory", "close_directory", "unlink"]);
    expect(f.published()).toEqual(f.preferences);
    expect(readdirSync(f.root)).toEqual(["accounts.json"]);
  },
);

it("finishes publication and directory sync before acknowledging interruption during rename", async () => {
  const f = fixture();
  f.held.rename = gate();
  f.held.sync_directory = gate();
  const fiber = f.fork();
  await expect.poll(() => f.events.includes("rename")).toBe(true);
  let stopped = false;
  const stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
    stopped = true;
  });
  await setImmediate();
  expect(stopped).toBe(false);
  f.held.rename.finish();
  await expect.poll(() => f.events.includes("sync_directory")).toBe(true);
  expect(f.published()).toEqual(f.preferences);
  expect(stopped).toBe(false);
  f.held.sync_directory.finish();
  await stopping;
  expect(f.events).toContain("close_directory");
  expect(readdirSync(f.root)).toEqual(["accounts.json"]);
});
