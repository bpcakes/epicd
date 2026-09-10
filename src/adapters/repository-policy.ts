import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { RepositoryPolicySchema, type RepositoryPolicy } from "../domain/repository-policy.js";

type PolicyStage = "read" | "initialize" | "write" | "publish" | "cleanup" | "decode";

export class RepositoryPolicyError extends Data.TaggedError("RepositoryPolicyError")<{
  readonly stage: PolicyStage;
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {
  constructor(options: { stage: PolicyStage; path: string; cause: unknown }) {
    const prefix = options.stage === "decode" ? "Invalid" : "Cannot read or initialize";
    super({
      ...options,
      message: `${prefix} repository policy at ${JSON.stringify(options.path)}. ${String(options.cause)}`,
    });
  }
}

const hasCode = (error: RepositoryPolicyError, code: string) =>
  error.cause instanceof Error && "code" in error.cause && error.cause.code === code;

/** Atomic first-run initialization. Each Node operation settles before cleanup or interruption. */
export function loadRepositoryPolicyEffect(
  repoPath: string,
  signal?: AbortSignal,
  initializeMissing = true,
): Effect.Effect<RepositoryPolicy, RepositoryPolicyError> {
  const path = join(repoPath, ".epicd", "policy.json");
  const io = <A>(stage: PolicyStage, run: () => Promise<A>) =>
    Effect.uninterruptible(
      Effect.tryPromise({
        try: () => {
          if (stage !== "cleanup") signal?.throwIfAborted();
          return run();
        },
        catch: (cause) => new RepositoryPolicyError({ stage, path, cause }),
      }),
    );
  const read = io("read", () => readFile(path, "utf8"));
  const initialize = Effect.gen(function* () {
    const directory = dirname(path);
    // Non-recursive creation cannot create directories through a dangling alias.
    yield* io("initialize", () => mkdir(directory)).pipe(
      Effect.catchTag("RepositoryPolicyError", (error) =>
        hasCode(error, "EEXIST") ? Effect.void : Effect.fail(error),
      ),
    );
    yield* io("initialize", async () => {
      if (
        !(await lstat(directory)).isDirectory() ||
        (await realpath(directory)) !== join(await realpath(repoPath), ".epicd")
      )
        throw new Error("Policy directory must be a real directory inside the repository");
    });
    const published = yield* Effect.acquireUseRelease(
      io("initialize", () => mkdtemp(join(directory, ".policy-"))),
      (temporaryDirectory) =>
        // Preserve finally's precedence: cleanup failure wins over a typed use failure.
        Effect.result(
          Effect.gen(function* () {
            const temporaryPath = join(temporaryDirectory, "policy.json");
            const defaults = RepositoryPolicySchema.parse({ schemaVersion: 1 });
            yield* io("write", () =>
              writeFile(temporaryPath, JSON.stringify(defaults, null, 2) + "\n"),
            );
            yield* io("publish", () => link(temporaryPath, path)).pipe(
              Effect.catchTag("RepositoryPolicyError", (error) =>
                hasCode(error, "EEXIST") ? Effect.void : Effect.fail(error),
              ),
            );
          }),
        ),
      (temporaryDirectory) =>
        io("cleanup", () => rm(temporaryDirectory, { recursive: true, force: true })),
    );
    if (Result.isFailure(published)) return yield* Effect.fail(published.failure);
    // Read the winning declaration, including one published by a concurrent creator.
    return yield* read;
  });
  return Effect.gen(function* () {
    const source = yield* read.pipe(
      Effect.catchTag("RepositoryPolicyError", (error) =>
        hasCode(error, "ENOENT")
          ? initializeMissing
            ? initialize
            : Effect.succeed(JSON.stringify(RepositoryPolicySchema.parse({ schemaVersion: 1 })))
          : Effect.fail(error),
      ),
    );
    return yield* Effect.try({
      try: () => RepositoryPolicySchema.parse(JSON.parse(source)),
      catch: (cause) => new RepositoryPolicyError({ stage: "decode", path, cause }),
    });
  });
}
