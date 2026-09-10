import type { ComponentProps } from "react";
import { render } from "ink";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { EpicBrowserItem } from "../epic-browser.js";
import { EpicPicker, type EpicBrowserQuery } from "./epic-picker.js";

export type EpicPickerEvent =
  | { kind: "select"; item: EpicBrowserItem }
  | { kind: "browse"; query: EpicBrowserQuery }
  | { kind: "quit" };
type PickerProps = Omit<ComponentProps<typeof EpicPicker>, "onSelect" | "onBrowse" | "onQuit">;

export class EpicPickerFailed extends Data.TaggedError("EpicPickerFailed")<{
  readonly stage: "render" | "wait" | "cleanup";
  readonly cause: unknown;
  readonly message: string;
}> {
  constructor(options: { stage: "render" | "wait" | "cleanup"; cause: unknown }) {
    const detail = options.cause instanceof Error ? options.cause.message : String(options.cause);
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
    return yield* Effect.acquireUseRelease(
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
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
          return { ui, exited: undefined as Promise<unknown> | undefined };
        },
        catch: (cause) => new EpicPickerFailed({ stage: "render", cause }),
      }),
      (session) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => {
              session.exited = session.ui.waitUntilExit();
              void session.exited.then(stop, (cause) =>
                Deferred.doneUnsafe(
                  selection,
                  Effect.fail(new EpicPickerFailed({ stage: "wait", cause })),
                ),
              );
            },
            catch: (cause) => new EpicPickerFailed({ stage: "wait", cause }),
          });
          return yield* Deferred.await(selection);
        }),
      (session) =>
        Effect.tryPromise({
          try: async () => {
            signal.removeEventListener("abort", stop);
            session.ui.unmount();
            await (session.exited ?? session.ui.waitUntilExit());
          },
          catch: (cause) => new EpicPickerFailed({ stage: "cleanup", cause }),
        }),
    );
  });
}
