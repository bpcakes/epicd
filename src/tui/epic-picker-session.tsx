import type { ComponentProps } from "react";
import { render } from "ink";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { EpicBrowserItem } from "../epic-browser.js";
import { EpicPicker, type EpicBrowserQuery } from "./epic-picker.js";
import { inkLifecycle, type TerminalState } from "./ink-lifecycle.js";
import { errorDetail } from "../util/error-detail.js";

export type EpicPickerEvent =
  | { kind: "select"; item: EpicBrowserItem }
  | { kind: "browse"; query: EpicBrowserQuery }
  | { kind: "quit" };
type PickerProps = Omit<ComponentProps<typeof EpicPicker>, "onSelect" | "onBrowse" | "onQuit">;

export class EpicPickerFailed extends Data.TaggedError("EpicPickerFailed")<{
  readonly stage: "render" | "wait" | "cleanup";
  readonly cause: unknown;
  readonly message: string;
  readonly terminalState: TerminalState;
}> {
  constructor(options: {
    stage: "render" | "wait" | "cleanup";
    cause: unknown;
    terminalState: TerminalState;
  }) {
    const detail = errorDetail(options.cause);
    super({ ...options, message: `Epic picker ${options.stage} failed: ${detail}` });
  }
}

/** One choice owns one Ink instance. Release waits for exit before another UI may render. */
export function pickEpicEffect(
  props: PickerProps,
  signal: AbortSignal,
): Effect.Effect<EpicPickerEvent, EpicPickerFailed> {
  return Effect.gen(function* () {
    if (signal.aborted) return { kind: "quit" } as const;
    const selection = yield* Deferred.make<EpicPickerEvent, EpicPickerFailed>();
    // Ink invokes synchronous callbacks outside Effect. Complete once without spawning fibers.
    const finish = (event: EpicPickerEvent) =>
      Deferred.doneUnsafe(selection, Effect.succeed(event));
    const stop = () => {
      finish({ kind: "quit" });
    };
    const result = yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const ui = render(
            <EpicPicker
              {...props}
              onSelect={(item) => {
                finish({ kind: "select", item });
              }}
              onBrowse={(query) => {
                finish({ kind: "browse", query });
              }}
              onQuit={stop}
            />,
            { exitOnCtrlC: false, interactive: true },
          );
          return inkLifecycle(ui);
        },
        catch: (cause) =>
          new EpicPickerFailed({ stage: "render", cause, terminalState: "unknown" }),
      }),
      (session) =>
        Effect.result(
          Effect.gen(function* () {
            yield* Effect.try({
              try: () => {
                signal.addEventListener("abort", stop, { once: true });
                if (signal.aborted) stop();
                void session.exited.then((outcome) => {
                  if (Result.isFailure(outcome))
                    Deferred.doneUnsafe(
                      selection,
                      Effect.fail(
                        new EpicPickerFailed({
                          stage: outcome.failure.stage,
                          cause: outcome.failure.cause,
                          terminalState: outcome.failure.terminalState,
                        }),
                      ),
                    );
                  else stop();
                });
              },
              catch: (cause) =>
                new EpicPickerFailed({ stage: "wait", cause, terminalState: "unknown" }),
            });
            return yield* Deferred.await(selection);
          }),
        ),
      (session) =>
        session.release(Effect.void, [() => signal.removeEventListener("abort", stop)]).pipe(
          Effect.mapError(
            (failure) =>
              new EpicPickerFailed({
                stage: failure.stage,
                cause: failure.cause,
                terminalState: failure.terminalState,
              }),
          ),
        ),
    );
    // Reaching this point proves release succeeded. A failed use can now report
    // a released terminal; release failures already propagated from the bracket.
    if (Result.isFailure(result))
      return yield* Effect.fail(
        new EpicPickerFailed({
          stage: result.failure.stage,
          cause: result.failure.cause,
          terminalState: "released",
        }),
      );
    return result.success;
  });
}
