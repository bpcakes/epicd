import { render } from "ink";
import { homedir } from "node:os";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  validateAccountDraft,
  defaultAccountsPath,
  discoverAccountHomes,
  loadAccountDraft,
  loadAccountPreferences,
  saveAccountPreferences,
} from "../adapters/accounts.js";
import { editAccountDraft, type AccountDraft, type AccountOverrides } from "../domain/accounts.js";
import { AccountEditor } from "./account-editor.js";
import { inkLifecycle, type TerminalState } from "./ink-lifecycle.js";
import { errorDetail } from "../util/error-detail.js";
import type { RuntimeKind } from "../domain/types.js";

type SetupOptions = {
  epicTitle?: string | null;
  repoPath?: string;
  runtime?: RuntimeKind;
  start?: (draft: AccountDraft, signal: AbortSignal) => Promise<void>;
};

type AccountSelection = AccountDraft | null | "quit";

export class AccountSelectionFailed extends Data.TaggedError("AccountSelectionFailed")<{
  readonly stage:
    "load_draft" | "load_preferences" | "discover_homes" | "render" | "wait" | "cleanup";
  readonly cause: unknown;
  readonly message: string;
  readonly terminalState: TerminalState;
}> {
  constructor(options: {
    stage: AccountSelectionFailed["stage"];
    cause: unknown;
    terminalState: TerminalState;
  }) {
    const detail = errorDetail(options.cause);
    super({ ...options, message: `Account selection ${options.stage} failed: ${detail}` });
  }
}

/** Own setup and its Ink instance; existing Promise operations must drain before release. */
export function selectAccountsEffect(
  epicId: string,
  overrides: AccountOverrides,
  configPath?: string,
  signal?: AbortSignal,
  options: SetupOptions = {},
): Effect.Effect<AccountSelection, AccountSelectionFailed> {
  const read = <A,>(stage: AccountSelectionFailed["stage"], run: () => Promise<A>) =>
    Effect.uninterruptible(
      Effect.tryPromise({
        try: run,
        catch: (cause) => new AccountSelectionFailed({ stage, cause, terminalState: "untouched" }),
      }),
    );
  return Effect.gen(function* () {
    const draft = yield* read("load_draft", () => loadAccountDraft(overrides, configPath, false));
    const savedPreferences = yield* read("load_preferences", () =>
      loadAccountPreferences(configPath ?? defaultAccountsPath(), configPath !== undefined),
    );
    // Inventory is optional; literal path editing remains available after a read failure.
    const inventory = yield* Effect.result(
      read("discover_homes", () => discoverAccountHomes(draft)),
    );
    const homes = Result.isSuccess(inventory) ? inventory.success : [];
    if (signal?.aborted) return "quit";
    const cancellation = new AbortController();
    const context = {
      configPath: configPath ?? defaultAccountsPath(),
      cwd: process.cwd(),
      operatorHome: homedir(),
      ...(process.env.CODEX_HOME !== undefined ? { environmentHome: process.env.CODEX_HOME } : {}),
    };
    const pending = new Set<Promise<unknown>>();
    const selection = yield* Deferred.make<AccountSelection, AccountSelectionFailed>();
    const track = <T,>(run: () => Promise<T>): Promise<T> => {
      if (cancellation.signal.aborted || Deferred.isDoneUnsafe(selection))
        return Promise.reject(cancellation.signal.reason ?? new Error("Account setup closed"));
      const promise = run();
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    };
    const finish = (value: AccountSelection) =>
      Deferred.doneUnsafe(selection, Effect.succeed(value));
    const stop = (result: null | "quit") => {
      if (Deferred.isDoneUnsafe(selection)) return;
      cancellation.abort();
      finish(result);
    };
    const quit = () => stop("quit");
    const result = yield* Effect.acquireUseRelease(
      Effect.try({
        try: () =>
          inkLifecycle(
            render(
              <AccountEditor
                epicId={epicId}
                {...(options.epicTitle !== undefined ? { epicTitle: options.epicTitle } : {})}
                {...(options.repoPath !== undefined ? { repoPath: options.repoPath } : {})}
                {...(options.runtime !== undefined ? { runtime: options.runtime } : {})}
                defaultsPath={context.configPath}
                initialDraft={draft}
                savedPreferences={savedPreferences}
                homes={homes}
                edit={(draft, row, path) => editAccountDraft(draft, row, path, context)}
                resolve={(draft) => track(() => validateAccountDraft(draft))}
                saveDefaults={(preferences) =>
                  track(() => saveAccountPreferences(preferences, context.configPath))
                }
                onStart={async (draft) => {
                  const start = options.start;
                  if (start) await track(() => start(draft, cancellation.signal));
                  if (!cancellation.signal.aborted) finish(draft);
                }}
                onBack={() => stop(null)}
                onQuit={quit}
              />,
              { exitOnCtrlC: false, interactive: true },
            ),
          ),
        catch: (cause) =>
          new AccountSelectionFailed({ stage: "render", cause, terminalState: "unknown" }),
      }),
      (session) =>
        Effect.result(
          Effect.gen(function* () {
            yield* Effect.try({
              try: () => {
                process.once("SIGINT", quit);
                process.once("SIGTERM", quit);
                signal?.addEventListener("abort", quit, { once: true });
                if (signal?.aborted) quit();
                void session.exited.then((outcome) => {
                  if (Result.isFailure(outcome))
                    Deferred.doneUnsafe(
                      selection,
                      Effect.fail(
                        new AccountSelectionFailed({
                          stage: outcome.failure.stage,
                          cause: outcome.failure.cause,
                          terminalState: outcome.failure.terminalState,
                        }),
                      ),
                    );
                  else stop(null);
                });
              },
              catch: (cause) =>
                new AccountSelectionFailed({ stage: "wait", cause, terminalState: "unknown" }),
            });
            return yield* Deferred.await(selection);
          }),
        ),
      (session) =>
        session
          .release(
            Effect.promise(async () => {
              await Promise.allSettled([...pending]);
            }),
            [
              () => {
                process.off("SIGINT", quit);
              },
              () => {
                process.off("SIGTERM", quit);
              },
              () => signal?.removeEventListener("abort", quit),
              // Fiber interruption and renderer failure must also cancel a pending start.
              () => cancellation.abort(),
            ],
          )
          .pipe(
            Effect.mapError(
              (failure) =>
                new AccountSelectionFailed({
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
        new AccountSelectionFailed({
          stage: result.failure.stage,
          cause: result.failure.cause,
          terminalState: "released",
        }),
      );
    return result.success;
  });
}

/** Promise callers retain their original selection values and rejection causes. */
export async function selectAccounts(
  epicId: string,
  overrides: AccountOverrides,
  configPath?: string,
  signal?: AbortSignal,
  options: SetupOptions = {},
): Promise<AccountSelection> {
  const result = await Effect.runPromise(
    Effect.result(selectAccountsEffect(epicId, overrides, configPath, signal, options)),
  );
  if (Result.isFailure(result)) throw result.failure.cause;
  return result.success;
}
