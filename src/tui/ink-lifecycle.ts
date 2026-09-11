import type { Instance } from "ink";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

export type TerminalState = "untouched" | "released" | "unknown";

class InkLifecycleFailed extends Data.TaggedError("InkLifecycleFailed")<{
  readonly stage: "wait" | "cleanup";
  readonly cause: unknown;
  readonly terminalState: "released" | "unknown";
}> {}

/** Adapt an acquired Ink instance; callers still own rendering, listeners and selection. */
export function inkLifecycle(
  ui: Pick<Instance, "unmount" | "waitUntilExit" | "waitUntilRenderFlush">,
) {
  // Observe once and retain the failure's origin. Re-awaiting this result during
  // release must not reclassify an application/renderer failure as cleanup.
  const exited = (async (): Promise<Result.Result<void, InkLifecycleFailed>> => {
    try {
      await ui.waitUntilExit();
      return Result.succeed(undefined);
    } catch (cause) {
      // Ink's async method can reject during beforeExit registration, before
      // returning its exit promise. Rejection alone does not prove release.
      return Result.fail(
        new InkLifecycleFailed({ stage: "wait", cause, terminalState: "unknown" }),
      );
    }
  })();

  const release = (
    drain: Effect.Effect<void> = Effect.void,
    beforeUnmount: readonly (() => void)[] = [],
  ) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        let preparationFailure: InkLifecycleFailed | undefined;
        // These are independent cleanup obligations. A listener observer can
        // throw during removal; still cancel work, unmount, and drain everything.
        for (const cleanup of beforeUnmount) {
          const result = yield* Effect.result(
            Effect.try({
              try: cleanup,
              catch: (cause) =>
                new InkLifecycleFailed({ stage: "cleanup", cause, terminalState: "unknown" }),
            }),
          );
          if (Result.isFailure(result)) preparationFailure ??= result.failure;
        }
        const unmounted = yield* Effect.result(
          Effect.try({
            try: () => ui.unmount(),
            catch: (cause) =>
              new InkLifecycleFailed({ stage: "cleanup", cause, terminalState: "unknown" }),
          }),
        );
        // Owned I/O must settle even if terminal teardown failed.
        yield* drain;
        // Ink can throw after marking itself as unmounting but before settling
        // its exit promise. Retrying or awaiting exit cannot repair that state.
        if (Result.isFailure(unmounted)) return yield* Effect.fail(unmounted.failure);
        const flushed = yield* Effect.result(
          Effect.tryPromise({
            try: async () => {
              let deadline: ReturnType<typeof setTimeout> | undefined;
              try {
                // In Ink 7.1.1, after unmount this public method awaits the internal
                // exit promise independently of waitUntilExit's listener setup.
                return await Promise.race([
                  Promise.all([exited, ui.waitUntilRenderFlush()]).then(([result]) => result),
                  new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(
                      () =>
                        reject(new Error("Ink terminal output did not finish within 5 seconds")),
                      5_000,
                    );
                  }),
                ]);
              } finally {
                clearTimeout(deadline);
              }
            },
            catch: (cause) =>
              new InkLifecycleFailed({ stage: "cleanup", cause, terminalState: "unknown" }),
          }),
        );
        if (preparationFailure) return yield* Effect.fail(preparationFailure);
        if (Result.isFailure(flushed)) return yield* Effect.fail(flushed.failure);
        const outcome = flushed.success;
        if (Result.isFailure(outcome))
          return yield* Effect.fail(
            new InkLifecycleFailed({
              stage: outcome.failure.stage,
              cause: outcome.failure.cause,
              terminalState: "released",
            }),
          );
      }),
    );

  return { exited, release };
}
