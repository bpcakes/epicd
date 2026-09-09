import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverHerdr,
  discoverHerdrEffect,
  resolveExecutable,
  resolveExecutableEffect,
  sdkNativeExecutable,
  sdkNativeExecutableEffect,
  selectedCodexExecutable,
  selectedCodexExecutableEffect,
} from "../src/adapters/runtime-discovery.js";
import * as command from "../src/util/command.js";
import { doctorFixture } from "./fixtures/doctor.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture(options: Parameters<typeof doctorFixture>[0] = {}) {
  const f = doctorFixture(options);
  cleanup.push(f.cleanup);
  vi.stubEnv("PATH", f.env.PATH);
  vi.stubEnv("HERDR_ENV", f.env.HERDR_ENV);
  vi.stubEnv("EPICD_DOCTOR_LOG", f.env.EPICD_DOCTOR_LOG);
  return f;
}

describe.runIf(process.platform === "linux")("runtime discovery", () => {
  it("resolves PATH at execution, skips unavailable candidates, and canonicalizes symlinks", async () => {
    const f = fixture();
    vi.stubEnv("PATH", "");
    const program = resolveExecutableEffect("codex");
    const denied = join(f.root, "denied"),
      aliases = join(f.root, "aliases");
    mkdirSync(denied);
    mkdirSync(aliases);
    writeFileSync(join(denied, "codex"), "not executable", { mode: 0o600 });
    symlinkSync(f.codex, join(aliases, "codex"));
    vi.stubEnv(
      "PATH",
      [join(f.root, "missing"), join(f.repo, "user.txt"), denied, aliases].join(":"),
    );
    expect(await Effect.runPromise(program)).toBe(f.codex);
    expect(await resolveExecutable("codex")).toBe(f.codex);
    expect(f.calls()).toEqual([]);
  });

  it("propagates unexpected filesystem errors instead of selecting a later PATH candidate", async () => {
    const f = fixture();
    const loop = join(f.root, "loop");
    mkdirSync(loop);
    symlinkSync("codex", join(loop, "codex"));
    vi.stubEnv("PATH", `${loop}:${f.env.PATH}`);
    const result = await Effect.runPromise(Effect.result(resolveExecutableEffect("codex")));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("Expected resolution to fail");
    expect(result.failure).toMatchObject({
      _tag: "RuntimeDiscoveryError",
      operation: "resolve_executable",
      cause: { code: "ELOOP" },
    });
    await expect(resolveExecutable("codex")).rejects.toMatchObject({ code: "ELOOP" });
    expect(f.calls()).toEqual([]);
  });

  it("treats empty executable input as a typed failure and preserves the Promise diagnostic", async () => {
    const result = await Effect.runPromise(Effect.result(resolveExecutableEffect(" ")));
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("Expected resolution to fail");
    expect(result.failure.operation).toBe("resolve_executable");
    expect(result.failure.cause).toBeInstanceOf(Error);
    await expect(resolveExecutable(" ")).rejects.toThrow("Executable cannot be empty");
  });

  it.runIf(process.arch === "x64").each([
    {
      name: "explicit entrypoint",
      effect: () => selectedCodexExecutableEffect("sdk", "codex"),
      promise: () => selectedCodexExecutable("sdk", "codex"),
    },
    { name: "SDK payload", effect: sdkNativeExecutableEffect, promise: sdkNativeExecutable },
    {
      name: "default SDK selection",
      effect: () => selectedCodexExecutableEffect("sdk"),
      promise: () => selectedCodexExecutable("sdk"),
    },
  ])(
    "labels $name filesystem failures as Codex selection without wrapping the cause",
    async ({ effect, promise }) => {
      const f = fixture();
      const cause = Object.assign(new Error("filesystem failure"), { code: "EIO" });
      vi.spyOn(fs, "realpath").mockRejectedValue(cause);
      const result = await Effect.runPromise(Effect.result(effect()));
      if (!Result.isFailure(result)) throw new Error("Expected selection to fail");
      expect(result.failure.operation).toBe("select_codex");
      expect(result.failure.cause).toBe(cause);
      await expect(promise()).rejects.toBe(cause);
      const direct = await Effect.runPromise(Effect.result(resolveExecutableEffect("codex")));
      if (!Result.isFailure(direct)) throw new Error("Expected resolution to fail");
      expect(direct.failure.operation).toBe("resolve_executable");
      expect(direct.failure.cause).toBe(cause);
      expect(f.calls()).toEqual([]);
    },
  );

  it.runIf(process.arch === "x64")(
    "labels an unavailable selected npm native payload as Codex selection",
    async () => {
      const f = fixture();
      const pkg = join(f.root, "selected-package");
      const nativePkg = join(pkg, "node_modules/@openai/codex-linux-x64");
      mkdirSync(join(pkg, "bin"), { recursive: true });
      mkdirSync(nativePkg, { recursive: true });
      const entry = join(pkg, "bin/codex.js");
      copyFileSync(f.codex, entry);
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "@openai/codex",
          bin: { codex: "bin/codex.js" },
        }),
      );
      writeFileSync(join(nativePkg, "package.json"), '{"name":"@openai/codex-linux-x64"}');
      const result = await Effect.runPromise(
        Effect.result(selectedCodexExecutableEffect("sdk", entry)),
      );
      if (!Result.isFailure(result)) throw new Error("Expected selection to fail");
      expect(result.failure.operation).toBe("select_codex");
      const message = `Executable unavailable: ${join(nativePkg, "vendor/x86_64-unknown-linux-musl/bin/codex")}`;
      expect(result.failure.cause).toMatchObject({ message });
      await expect(selectedCodexExecutable("sdk", entry)).rejects.toThrow(message);
      expect(f.calls()).toEqual([]);
    },
  );

  it.runIf(process.arch === "x64").each([
    { manifest: "{", message: "", errorName: "SyntaxError" },
    {
      manifest: '{"name":"unrelated-package"}',
      message: "supported npm entrypoint",
      errorName: "Error",
    },
  ])(
    "rejects an invalid selected npm manifest ($errorName) before executing any command",
    async ({ manifest, message, errorName }) => {
      const f = fixture();
      const pkg = join(f.root, "selected-package");
      mkdirSync(join(pkg, "bin"), { recursive: true });
      const entry = join(pkg, "bin", "codex.js");
      copyFileSync(f.codex, entry);
      writeFileSync(join(pkg, "package.json"), manifest);
      const result = await Effect.runPromise(
        Effect.result(selectedCodexExecutableEffect("sdk", entry)),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) throw new Error("Expected selection to fail");
      expect(result.failure.operation).toBe("select_codex");
      expect(result.failure.cause).toMatchObject({ name: errorName });
      await expect(selectedCodexExecutable("sdk", entry)).rejects.toMatchObject({
        name: errorName,
      });
      if (message) expect((result.failure.cause as Error).message).toContain(message);
      expect(f.calls()).toEqual([]);
    },
  );

  it.each([
    {
      options: { malformedSessions: true },
      errorName: "SyntaxError",
      calls: ["herdr status server", "herdr session list --json"],
    },
    {
      options: { invalidPane: true },
      errorName: "ZodError",
      calls: ["herdr status server", "herdr session list --json", "herdr pane current --current"],
    },
  ])(
    "keeps Herdr parsing failures in the typed channel ($errorName)",
    async ({ options, errorName, calls }) => {
      const f = fixture(options);
      const before = f.snapshot();
      const program = discoverHerdrEffect(f.herdr, f.repo);
      expect(f.calls()).toEqual([]);
      const result = await Effect.runPromise(Effect.result(program));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) throw new Error("Expected discovery to fail");
      expect(result.failure.operation).toBe("discover_herdr");
      expect(result.failure.cause).toMatchObject({ name: errorName });
      expect(f.calls()).toEqual(calls);
      await expect(discoverHerdr(f.herdr, f.repo)).rejects.toMatchObject({ name: errorName });
      expect(f.calls()).toEqual([...calls, ...calls]);
      expect(f.snapshot()).toEqual(before);
    },
  );

  it.each([new Error("command failed"), { detail: "legacy rejection" }, null, "legacy rejection"])(
    "preserves command rejection identity at the Promise boundary: %s",
    async (cause) => {
      const f = fixture();
      const run = vi.spyOn(command, "runCommand").mockRejectedValue(cause);
      const result = await Effect.runPromise(Effect.result(discoverHerdrEffect(f.herdr, f.repo)));
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) throw new Error("Expected discovery to fail");
      expect(result.failure.cause).toBe(cause);
      await expect(discoverHerdr(f.herdr, f.repo)).rejects.toBe(cause);
      expect(run).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenLastCalledWith(f.herdr, ["status", "server"], {
        cwd: f.repo,
        timeoutMs: 10_000,
      });
    },
  );
});
