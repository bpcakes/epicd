import { render } from "ink";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { OperatorRequest, RunOperator } from "../operator-controls.js";
import { errorDetail } from "../util/error-detail.js";
import { inkLifecycle, type TerminalState } from "./ink-lifecycle.js";
import { OperatorView } from "./operator-view.js";

type OperatorConsole = Pick<RunOperator, "status" | "submit" | "settle">;

export class OperatorConsoleFailed extends Data.TaggedError("OperatorConsoleFailed")<{
  readonly stage: "prepare" | "render" | "wait" | "cleanup";
  readonly cause: unknown;
  readonly message: string;
  readonly terminalState: TerminalState;
}> {
  constructor(options: {
    stage: OperatorConsoleFailed["stage"];
    cause: unknown;
    terminalState: TerminalState;
  }) {
    super({
      ...options,
      message: `Operator console ${options.stage} failed: ${errorDetail(options.cause)}`,
    });
  }
}

/** Own one operator UI and drain any admitted request before its caller may close SQLite. */
export function operatorConsoleEffect(
  operator: OperatorConsole,
): Effect.Effect<void, OperatorConsoleFailed> {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => operator.status(),
      catch: (cause) =>
        new OperatorConsoleFailed({ stage: "prepare", cause, terminalState: "untouched" }),
    });
    const cancellation = new AbortController();
    const closed = yield* Deferred.make<void, OperatorConsoleFailed>();
    const finish = () => Deferred.doneUnsafe(closed, Effect.void);
    const stop = () => {
      if (Deferred.isDoneUnsafe(closed)) return;
      cancellation.abort(new Error("Operator console closed"));
      finish();
    };
    const controls = {
      status: () => operator.status(),
      submit: (request: OperatorRequest) => operator.submit(request, cancellation.signal),
    };
    const result = yield* Effect.acquireUseRelease(
      Effect.try({
        try: () =>
          inkLifecycle(
            render(<OperatorView controls={controls} close={stop} />, {
              exitOnCtrlC: false,
              interactive: true,
            }),
          ),
        catch: (cause) =>
          new OperatorConsoleFailed({ stage: "render", cause, terminalState: "unknown" }),
      }),
      (session) =>
        Effect.result(
          Effect.gen(function* () {
            yield* Effect.try({
              try: () => {
                process.once("SIGINT", stop);
                process.once("SIGTERM", stop);
                void session.exited.then((outcome) => {
                  if (Result.isFailure(outcome))
                    Deferred.doneUnsafe(
                      closed,
                      Effect.fail(
                        new OperatorConsoleFailed({
                          stage: outcome.failure.stage,
                          cause: outcome.failure.cause,
                          terminalState: outcome.failure.terminalState,
                        }),
                      ),
                    );
                  else finish();
                });
              },
              catch: (cause) =>
                new OperatorConsoleFailed({ stage: "wait", cause, terminalState: "unknown" }),
            });
            return yield* Deferred.await(closed);
          }),
        ),
      (session) =>
        session
          .release(
            Effect.promise(() => operator.settle()),
            [
              () => {
                process.off("SIGINT", stop);
              },
              () => {
                process.off("SIGTERM", stop);
              },
              () => cancellation.abort(new Error("Operator console closed")),
            ],
          )
          .pipe(
            Effect.mapError(
              (failure) =>
                new OperatorConsoleFailed({
                  stage: failure.stage,
                  cause: failure.cause,
                  terminalState: failure.terminalState,
                }),
            ),
          ),
    );
    if (Result.isFailure(result))
      return yield* Effect.fail(
        new OperatorConsoleFailed({
          stage: result.failure.stage,
          cause: result.failure.cause,
          terminalState: "released",
        }),
      );
  });
}
