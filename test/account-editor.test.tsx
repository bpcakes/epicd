import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { render } from "ink-testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { AccountEditor, type AccountEditorProps } from "../src/tui/account-editor.js";
import {
  AccountPreferencesSchema,
  editAccountDraft,
  resolveAccountDraft,
  type AccountDraft,
} from "../src/domain/accounts.js";
import {
  canonicalizeAccountDraft,
  saveAccountPreferences,
  validateAccountDraft,
} from "../src/adapters/accounts.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(extra: Partial<AccountEditorProps> = {}) {
  const root = await mkdtemp(join(tmpdir(), "epicd-account-editor-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const homes = ["main", "build", "review"].map((name) => join(root, name));
  for (const path of homes) await mkdir(path, { mode: 0o700 });
  const context = {
    configPath: join(root, "accounts.json"),
    cwd: root,
    operatorHome: root,
    environmentHome: homes[0]!,
  };
  const initialDraft = resolveAccountDraft({
    ...context,
    preferences: AccountPreferencesSchema.parse({ schemaVersion: 1 }),
  });
  const onStart = vi.fn(),
    onBack = vi.fn(),
    onQuit = vi.fn();
  const saveDefaults = vi.fn((preferences: Parameters<typeof saveAccountPreferences>[0]) =>
    saveAccountPreferences(preferences, context.configPath),
  );
  const view = render(
    <AccountEditor
      epicId="demo"
      defaultsPath={context.configPath}
      initialDraft={initialDraft}
      homes={homes}
      edit={(draft, row, path) => editAccountDraft(draft, row, path, context)}
      resolve={canonicalizeAccountDraft}
      saveDefaults={saveDefaults}
      onStart={onStart}
      onBack={onBack}
      onQuit={onQuit}
      epicTitle="Demo epic"
      repoPath={join(root, "repo")}
      runtime="sdk"
      {...extra}
    />,
  );
  cleanup.push(() => view.unmount());
  await setImmediate();
  const key = async (input: string) => {
    view.stdin.write(input);
    await setImmediate();
  };
  const settled = () =>
    expect
      .poll(() => view.lastFrame())
      .not.toMatch(/Checking account paths|Saving defaults|Creating run|Loading home settings/);
  return {
    root,
    homes,
    context,
    initialDraft,
    view,
    key,
    settled,
    onStart,
    onBack,
    onQuit,
    saveDefaults,
  };
}
it("selects three homes and confirms the exact draft before creating any run", async () => {
  const v = await setup();
  await v.key("j");
  await v.key("\r");
  await v.key("e");
  await v.key(v.homes[0]!);
  await v.key("\r");
  await v.settled();
  await v.key("j");
  await v.key("\r");
  await v.key("e");
  await v.key(v.homes[1]!);
  await v.key("\r");
  await v.settled();
  await v.key("j");
  await v.key("\r");
  await v.key("e");
  await v.key(v.homes[2]!);
  await v.key("\r");
  await v.settled();
  expect(v.onStart).not.toHaveBeenCalled();
  await v.key("s");
  await v.settled();
  expect(v.view.lastFrame()).toContain("START demo WITH THESE ACCOUNTS");
  expect(v.view.lastFrame()).toContain("verification → review");
  expect(v.view.lastFrame()).not.toContain("verification (inherits review)");
  expect(v.view.lastFrame()).toContain("Demo epic");
  expect(v.view.lastFrame()).toContain("Repository:");
  expect(v.view.lastFrame()).toContain("Runtime: sdk");
  expect(v.onStart).not.toHaveBeenCalled();
  await v.key("\r");
  await v.key("\r");
  expect(v.onStart).toHaveBeenCalledOnce();
  const draft = v.onStart.mock.calls[0]![0] as AccountDraft;
  if (draft.mode !== "homes") throw new Error("Expected homes");
  expect([
    draft.classes.orchestrator?.codexHome,
    draft.classes.implementation?.codexHome,
    draft.classes.review?.codexHome,
  ]).toEqual(v.homes);
  expect(draft.classes.epic_repair?.codexHome).toBe(v.homes[1]);
  expect(draft.classes.final_review?.codexHome).toBe(v.homes[2]);
});
it("chooses from a visible home list, inherits, and saves paths only on request", async () => {
  const v = await setup();
  await v.key("j");
  await v.key("j");
  await v.key("\r");
  expect(v.view.lastFrame()).toContain("Choose home for implementation");
  expect(v.view.lastFrame()).toContain("Enter another path");
  expect(v.view.lastFrame()).toContain(v.homes[0]);
  await v.key("\t");
  await v.key("\t");
  await v.key("\r");
  await v.settled();
  expect(v.view.lastFrame()).toContain(v.homes[1]);
  expect(v.saveDefaults).not.toHaveBeenCalled();
  await v.key("d");
  await v.settled();
  expect(
    JSON.parse(await readFile(v.context.configPath, "utf8")).classes.implementation.codexHome,
  ).toBe(v.homes[1]);
  await v.key("\r");
  await v.key("e");
  await v.key("\u0015");
  await v.key("\r");
  await v.settled();
  expect(v.view.lastFrame()).toContain("implementation (inherits default)");
  expect(v.onStart).not.toHaveBeenCalled();
});
it("cancels edits and confirmation without saving or starting", async () => {
  const v = await setup();
  await v.key("j");
  await v.key("\r");
  await v.key("e");
  await v.key("literal");
  await v.key("\u001b");
  await expect.poll(() => v.view.lastFrame()).not.toContain("literal");
  await v.key("\u001b");
  await v.key("s");
  await v.settled();
  await v.key("b");
  expect(v.view.lastFrame()).not.toContain("START demo");
  await v.key("b");
  expect(v.onBack).toHaveBeenCalledOnce();
  expect(v.saveDefaults).not.toHaveBeenCalled();
  expect(v.onStart).not.toHaveBeenCalled();
});
it("ignores pasted shortcut sequences and control characters", async () => {
  const v = await setup();
  await v.key("s\rq\r");
  expect(v.onStart).not.toHaveBeenCalled();
  expect(v.onBack).not.toHaveBeenCalled();
  await v.key("j");
  await v.key("\r");
  await v.key("e");
  await v.key("evil\npath");
  expect(v.view.lastFrame()).not.toContain("evil");
  await v.key("\u001b");
  expect(v.onStart).not.toHaveBeenCalled();
});
it("retains edited paths and displays save failures", async () => {
  const v = await setup({
    saveDefaults: async () => {
      throw new Error("No space to save preferences");
    },
  });
  await v.key("j");
  await v.key("\r");
  await v.key("e");
  await v.key(v.homes[2]!);
  await v.key("\r");
  await v.settled();
  await v.key("d");
  await v.settled();
  expect(v.view.lastFrame()).toContain("No space to save preferences");
  expect(v.view.lastFrame()).toContain(v.homes[2]);
  await v.key("s");
  await v.settled();
  await v.key("\r");
  expect(v.onStart).toHaveBeenCalledOnce();
});
it("does not start after cancellation during path resolution", async () => {
  let finish!: (draft: AccountDraft) => void;
  const v = await setup({
    resolve: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await v.key("s");
  await v.key("\u0003");
  expect(v.onQuit).toHaveBeenCalledOnce();
  expect(v.onBack).not.toHaveBeenCalled();
  finish(v.initialDraft);
  await setImmediate();
  await v.settled();
  await v.key("\r");
  expect(v.onStart).not.toHaveBeenCalled();
});

it("blocks confirmation on local credential and directory errors beside the editable field", async () => {
  const v = await setup({ resolve: validateAccountDraft });
  await v.key("s");
  await v.settled();
  expect(v.view.lastFrame()).toContain("Check the highlighted account settings");
  expect(v.view.lastFrame()).toContain("› default");
  expect(v.view.lastFrame()).toContain("Unable to load a supported Codex access token");
  expect(v.view.lastFrame()).not.toContain("START demo");
  expect(v.onStart).not.toHaveBeenCalled();
  await v.key("\r");
  await v.key("e");
  await v.key(join(v.root, "missing"));
  await v.key("\r");
  await v.settled();
  expect(v.view.lastFrame()).toContain("› default");
  expect(v.view.lastFrame()).toContain("Directory is missing or unreadable");
  expect(v.view.lastFrame()).toContain(join(v.root, "missing"));
  await v.key("s");
  await v.settled();
  expect(v.view.lastFrame()).not.toContain("START demo");
  expect(v.onStart).not.toHaveBeenCalled();
});

it("refuses to save a missing home and retains the prior defaults and draft", async () => {
  const v = await setup();
  await v.key("d");
  await v.settled();
  const original = await readFile(v.context.configPath, "utf8");
  v.saveDefaults.mockClear();
  await v.key("\r");
  await v.key("e");
  await v.key(join(v.root, "missing"));
  await v.key("\r");
  await v.settled();
  await v.key("d");
  await v.settled();
  expect(v.saveDefaults).not.toHaveBeenCalled();
  expect(await readFile(v.context.configPath, "utf8")).toBe(original);
  expect(v.view.lastFrame()).toContain("Directory is missing or unreadable");
  expect(v.view.lastFrame()).toContain("Unsaved changes");
});

it("does not save defaults after quitting during their validation", async () => {
  let finish!: (draft: AccountDraft) => void;
  const v = await setup({
    resolve: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await v.key("d");
  await v.key("\u0003");
  finish(v.initialDraft);
  await v.settled();
  expect(v.onQuit).toHaveBeenCalledOnce();
  expect(v.saveDefaults).not.toHaveBeenCalled();
  await expect(readFile(v.context.configPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("cancels when Ctrl+C arrives in the same input chunk as path text", async () => {
  const v = await setup();
  await v.key("j");
  await v.key("\r");
  await v.key("e");
  await v.key("unsaved\u0003");
  expect(v.onQuit).toHaveBeenCalledOnce();
  expect(v.onBack).not.toHaveBeenCalled();
  expect(v.onStart).not.toHaveBeenCalled();
  expect(v.saveDefaults).not.toHaveBeenCalled();
});

it("keeps edits after a failed start, highlights its account field, and retries the same draft", async () => {
  const { AccountDraftValidationError } = await import("../src/domain/accounts.js");
  const start = vi
    .fn()
    .mockRejectedValueOnce(
      new Error("Run creation failed", {
        cause: new AccountDraftValidationError({
          implementation: "Account changed. Select its home again.",
        }),
      }),
    )
    .mockResolvedValue(undefined);
  const v = await setup({ onStart: start });
  await v.key("j");
  await v.key("j");
  await v.key("\r");
  await v.key("e");
  await v.key(v.homes[1]!);
  await v.key("\r");
  await v.settled();
  expect(v.view.lastFrame()).toContain("Unsaved changes");
  await v.key("s");
  await v.settled();
  await v.key("\r");
  await v.settled();
  expect(v.view.lastFrame()).toContain("Account changed. Select its home again.");
  expect(v.view.lastFrame()).toContain("› implementation");
  expect(v.view.lastFrame()).toContain(v.homes[1]);
  expect(v.onBack).not.toHaveBeenCalled();
  expect(v.onQuit).not.toHaveBeenCalled();
  await v.key("s");
  await v.settled();
  await v.key("\r");
  await v.settled();
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[1]![0]).toEqual(start.mock.calls[0]![0]);
});

it("shows source origins and only clears the unsaved indicator after a successful save", async () => {
  const v = await setup();
  expect(v.view.lastFrame()).toContain("From CODEX_HOME");
  expect(v.view.lastFrame()).toContain("Matches saved defaults");
  await v.key("\r");
  await v.key("e");
  await v.key(v.homes[2]!);
  await v.key("\r");
  await v.settled();
  expect(v.view.lastFrame()).toContain("Override");
  expect(v.view.lastFrame()).toContain("Unsaved changes");
  await v.key("d");
  await v.settled();
  expect(v.view.lastFrame()).toContain("Matches saved defaults");
  expect(v.view.lastFrame()).not.toContain("Unsaved changes");
});

it("edits at the cursor with arrows, Home/End, Backspace and Delete", async () => {
  const edit = vi.fn((draft: AccountDraft) => draft);
  const v = await setup({ edit });
  await v.key("j");
  await v.key("\r");
  await v.key("e");
  await v.key("a🙂c");
  await v.key("\u001b[D");
  await v.key("b");
  expect(v.view.lastFrame()).toContain("a🙂b▏c");
  await v.key("\u001b[H");
  await v.key("\u001b[3~");
  expect(v.view.lastFrame()).toContain("▏🙂bc");
  await v.key("\u001b[F");
  await v.key("\u007f");
  expect(v.view.lastFrame()).toContain("🙂b▏");
  await v.key("\r");
  await v.settled();
  expect(edit).toHaveBeenCalledWith(expect.anything(), "orchestrator", "🙂b");
});

it("shows explicit advanced overrides in the compact summary and expands inherited roles on demand", async () => {
  const v = await setup();
  await v.key("a");
  for (let i = 0; i < 4; i++) await v.key("j");
  await v.key("\r");
  await v.key("e");
  await v.key(v.homes[2]!);
  await v.key("\r");
  await v.settled();
  await v.key("s");
  await v.settled();
  expect(v.view.lastFrame()).toContain("verification");
  expect(v.view.lastFrame()).toContain(v.homes[2]);
  expect(v.view.lastFrame()).not.toContain("final_review (inherits review)");
  await v.key("a");
  expect(v.view.lastFrame()).toContain("final_review (inherits review)");
  expect(v.onStart).not.toHaveBeenCalled();
});
