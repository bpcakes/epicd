import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { z } from "zod";
import type { RuntimeKind } from "../domain/types.js";
import { runCommand } from "../util/command.js";

export type HerdrEndpoint = {
  executable: string;
  sessionName: string;
  workspaceId: string;
};

/**
 * Operation identifies the public discovery API, including failures in delegated helpers.
 * Retains original failures for Promise callers; causes require redaction before logging.
 */
export class RuntimeDiscoveryError extends Data.TaggedError("RuntimeDiscoveryError")<{
  readonly operation: "resolve_executable" | "select_codex" | "discover_herdr";
  readonly cause: unknown;
}> {}

function attempt<A>(operation: RuntimeDiscoveryError["operation"], run: () => A) {
  return Effect.try({
    try: run,
    catch: (cause) => new RuntimeDiscoveryError({ operation, cause }),
  });
}

function attemptPromise<A>(operation: RuntimeDiscoveryError["operation"], run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new RuntimeDiscoveryError({ operation, cause }),
  });
}

function codexSelectionError(error: RuntimeDiscoveryError): RuntimeDiscoveryError {
  return error.operation === "select_codex"
    ? error
    : new RuntimeDiscoveryError({ operation: "select_codex", cause: error.cause });
}

export function resolveExecutableEffect(
  value: string,
): Effect.Effect<string, RuntimeDiscoveryError> {
  return Effect.gen(function* () {
    const candidates = yield* attempt("resolve_executable", () => {
      if (!value.trim()) throw new Error("Executable cannot be empty");
      return isAbsolute(value) || value.includes("/")
        ? [resolve(value)]
        : (process.env.PATH ?? "")
            .split(":")
            .filter(Boolean)
            .map((path) => join(path, value));
    });
    for (const candidate of candidates) {
      const checked = yield* Effect.result(
        Effect.gen(function* () {
          const path = yield* attemptPromise("resolve_executable", () => realpath(candidate));
          yield* attemptPromise("resolve_executable", () => access(path, constants.X_OK));
          return path;
        }),
      );
      if (Result.isSuccess(checked)) return checked.success;
      const cause = checked.failure.cause;
      if (
        typeof cause !== "object" ||
        cause === null ||
        !("code" in cause) ||
        !["ENOENT", "EACCES", "ENOTDIR"].includes(String(cause.code))
      )
        return yield* Effect.fail(checked.failure);
    }
    return yield* Effect.fail(
      new RuntimeDiscoveryError({
        operation: "resolve_executable",
        cause: new Error(`Executable unavailable: ${value}`),
      }),
    );
  });
}

export function sdkNativeExecutableEffect(): Effect.Effect<string, RuntimeDiscoveryError> {
  return Effect.gen(function* () {
    const native = yield* attempt("select_codex", () => {
      if (process.platform !== "linux" || process.arch !== "x64")
        throw new Error("Controlled runtime admission currently requires Linux x64");
      const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
      const manifest = sdkRequire.resolve("@openai/codex-linux-x64/package.json");
      return join(dirname(manifest), "vendor/x86_64-unknown-linux-musl/bin/codex");
    });
    return yield* resolveExecutableEffect(native);
  }).pipe(Effect.mapError(codexSelectionError));
}

/** Resolve only the selected installation's native payload, without executing its npm shim. */
export function selectedCodexExecutableEffect(
  runtime: RuntimeKind,
  override?: string,
): Effect.Effect<string, RuntimeDiscoveryError> {
  return Effect.gen(function* () {
    if (!override && runtime === "sdk") return yield* sdkNativeExecutableEffect();
    const entry = yield* resolveExecutableEffect(override ?? "codex");
    if (basename(entry) !== "codex.js") return entry;
    const manifestPath = yield* attempt("select_codex", () => {
      if (process.platform !== "linux" || process.arch !== "x64")
        throw new Error("Controlled runtime admission currently requires Linux x64");
      return join(dirname(entry), "..", "package.json");
    });
    const raw = yield* attemptPromise("select_codex", () => readFile(manifestPath, "utf8"));
    yield* attempt("select_codex", () => {
      const manifest = z
        .object({
          name: z.literal("@openai/codex"),
          bin: z.object({ codex: z.literal("bin/codex.js") }),
        })
        .safeParse(JSON.parse(raw));
      if (!manifest.success || dirname(entry).split("/").at(-1) !== "bin")
        throw new Error("Select a native Codex binary or its supported npm entrypoint");
    });
    const nativeManifest = yield* attempt("select_codex", () => {
      try {
        return createRequire(entry).resolve("@openai/codex-linux-x64/package.json");
      } catch (error) {
        throw new Error(
          "The selected Codex installation has no native Linux x64 dependency; no installation fallback was attempted",
          { cause: error },
        );
      }
    });
    return yield* resolveExecutableEffect(
      join(dirname(nativeManifest), "vendor/x86_64-unknown-linux-musl/bin/codex"),
    );
  }).pipe(Effect.mapError(codexSelectionError));
}

/** Read-only caller discovery. Command deadlines remain owned by runCommand; interruption is not drain. */
export function discoverHerdrEffect(
  executable: string,
  cwd: string,
): Effect.Effect<HerdrEndpoint, RuntimeDiscoveryError> {
  return Effect.gen(function* () {
    yield* attempt("discover_herdr", () => {
      if (process.env.HERDR_ENV !== "1")
        throw new Error("Native Herdr requires a Herdr-managed caller (HERDR_ENV=1)");
    });
    const read = (args: string[]) =>
      Effect.map(
        attemptPromise("discover_herdr", () =>
          runCommand(executable, args, { cwd, timeoutMs: 10_000 }),
        ),
        (result) => result.stdout,
      );
    const status = yield* read(["status", "server"]);
    const socket = yield* attempt("discover_herdr", () => {
      const socket = /^socket:\s*(.+)$/m.exec(status)?.[1]?.trim();
      if (!socket || !/^compatible:\s*yes\s*$/m.test(status))
        throw new Error("Herdr server endpoint or protocol compatibility could not be verified");
      return socket;
    });
    const sessionText = yield* read(["session", "list", "--json"]);
    const sessionName = yield* attempt("discover_herdr", () => {
      const sessions = z
        .object({
          sessions: z.array(
            z.object({ name: z.string(), running: z.boolean(), socket_path: z.string() }),
          ),
        })
        .parse(JSON.parse(sessionText)).sessions;
      const matching = sessions.filter(
        (session) => session.running && session.socket_path === socket,
      );
      if (matching.length !== 1)
        throw new Error("Cannot identify the caller's exact named Herdr session");
      return matching[0]!.name;
    });
    const paneText = yield* read(["pane", "current", "--current"]);
    const workspaceId = yield* attempt("discover_herdr", () => {
      const pane = z
        .object({ result: z.object({ pane: z.object({ workspace_id: z.string().min(1) }) }) })
        .parse(JSON.parse(paneText));
      return pane.result.pane.workspace_id;
    });
    return { executable, sessionName, workspaceId };
  });
}

/** Execute once at a legacy boundary, preserving the original rejection value. */
async function runDiscovery<A>(program: Effect.Effect<A, RuntimeDiscoveryError>): Promise<A> {
  const outcome = await Effect.runPromise(Effect.result(program));
  if (Result.isFailure(outcome)) throw outcome.failure.cause;
  return outcome.success;
}

export function resolveExecutable(value: string): Promise<string> {
  return runDiscovery(resolveExecutableEffect(value));
}

export function sdkNativeExecutable(): Promise<string> {
  return runDiscovery(sdkNativeExecutableEffect());
}

export function selectedCodexExecutable(runtime: RuntimeKind, override?: string): Promise<string> {
  return runDiscovery(selectedCodexExecutableEffect(runtime, override));
}

export function discoverHerdr(executable: string, cwd: string): Promise<HerdrEndpoint> {
  return runDiscovery(discoverHerdrEffect(executable, cwd));
}
