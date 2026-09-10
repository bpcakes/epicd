import { render } from "ink";
import { homedir } from "node:os";
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
import type { RuntimeKind } from "../domain/types.js";

type SetupOptions = {
  epicTitle?: string | null;
  repoPath?: string;
  runtime?: RuntimeKind;
  start?: (draft: AccountDraft, signal: AbortSignal) => Promise<void>;
};

/** Keep setup open through run creation, then tear down Ink before controller launch. */
export async function selectAccounts(
  epicId: string,
  overrides: AccountOverrides,
  configPath?: string,
  signal?: AbortSignal,
  options: SetupOptions = {},
): Promise<AccountDraft | null | "quit"> {
  const draft = await loadAccountDraft(overrides, configPath, false);
  const savedPreferences = await loadAccountPreferences(
    configPath ?? defaultAccountsPath(),
    configPath !== undefined,
  );
  let homes: string[] = [];
  try {
    homes = await discoverAccountHomes(draft);
  } catch {
    /* Literal path editing remains available. */
  }
  if (signal?.aborted) return "quit";
  const cancellation = new AbortController();
  const context = {
    configPath: configPath ?? defaultAccountsPath(),
    cwd: process.cwd(),
    operatorHome: homedir(),
    ...(process.env.CODEX_HOME !== undefined ? { environmentHome: process.env.CODEX_HOME } : {}),
  };
  const pending = new Set<Promise<unknown>>();
  const track = <T,>(promise: Promise<T>) => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  let done = false;
  let finish!: (draft: AccountDraft | null | "quit") => void;
  const choice = new Promise<AccountDraft | null | "quit">((resolve) => {
    finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
  });
  const stop = (result: null | "quit") => {
    if (done) return;
    cancellation.abort();
    finish(result);
  };
  const quit = () => stop("quit");
  let ui: ReturnType<typeof render> | undefined;
  let exited: Promise<unknown> | undefined;
  try {
    ui = render(
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
        resolve={(draft) => track(validateAccountDraft(draft))}
        saveDefaults={(preferences) =>
          track(saveAccountPreferences(preferences, context.configPath))
        }
        onStart={async (draft) => {
          if (options.start) await track(options.start(draft, cancellation.signal));
          if (!cancellation.signal.aborted) finish(draft);
        }}
        onBack={() => stop(null)}
        onQuit={quit}
      />,
      { exitOnCtrlC: false, interactive: true },
    );
    process.once("SIGINT", quit);
    process.once("SIGTERM", quit);
    signal?.addEventListener("abort", quit, { once: true });
    if (signal?.aborted) quit();
    exited = ui.waitUntilExit();
    // Renderer failure is observed alongside selection; clean exit cancels the draft.
    const renderer = exited.then(() => {
      stop(null);
      return null;
    });
    return await Promise.race([choice, renderer]);
  } finally {
    process.off("SIGINT", quit);
    process.off("SIGTERM", quit);
    signal?.removeEventListener("abort", quit);
    ui?.unmount();
    await Promise.allSettled([...pending]);
    if (ui) await (exited ?? ui.waitUntilExit());
  }
}
