import { useEffect, useRef, useState } from "react";
import { basename } from "node:path";
import { Box, Text, useInput } from "ink";
import { redactSensitiveText } from "../util/redact.js";
import {
  ACCOUNT_CLASSES,
  AccountDraftValidationError,
  sameAccountPreferences,
  type AccountClass,
  type AccountDraft,
  type AccountField,
  type AccountPreferences,
  type ResolvedAccount,
} from "../domain/accounts.js";
import type { RuntimeKind } from "../domain/types.js";

const visible = (text: string) =>
  redactSensitiveText(text, 4000).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
type Row = AccountClass | "default";
type View =
  | { kind: "form" }
  | { kind: "picker"; row: Row; index: number }
  | { kind: "path"; row: Row; text: string; cursor: number }
  | { kind: "summary"; expanded: boolean };
export type AccountEditorProps = {
  epicId: string;
  epicTitle?: string | null;
  repoPath?: string;
  runtime?: RuntimeKind;
  defaultsPath: string;
  initialDraft: AccountDraft;
  savedPreferences?: AccountPreferences;
  homes: readonly string[];
  edit: (draft: AccountDraft, row: Row, path: string | null) => AccountDraft;
  resolve: (draft: AccountDraft) => Promise<AccountDraft>;
  saveDefaults: (preferences: AccountPreferences) => Promise<void>;
  onStart: (draft: AccountDraft) => void | Promise<void>;
  onBack: () => void;
  onQuit: () => void;
};

function sourceLabel(entry: ResolvedAccount | null): string {
  if (!entry) return "Inherits assignment role";
  const origin = {
    environment: "From CODEX_HOME",
    default: "Built-in default (~/.codex)",
    file: "Saved default",
    cli: "CLI override",
    tui: "Override",
  }[entry.origin];
  return entry.inheritedFrom ? `Inherits ${entry.inheritedFrom} · ${origin}` : origin;
}
function fieldFailure(error: unknown): AccountDraftValidationError | undefined {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof AccountDraftValidationError) return error;
    seen.add(error);
    error = error.cause;
  }
  return undefined;
}

export function AccountEditor(props: AccountEditorProps) {
  const [draft, setDraft] = useState(props.initialDraft);
  const [saved, setSaved] = useState(props.savedPreferences ?? props.initialDraft.preferences);
  const [advanced, setAdvanced] = useState(false);
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<View>({ kind: "form" });
  const [notice, setNotice] = useState("");
  const [errors, setErrors] = useState<Partial<Record<AccountField, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true),
    pending = useRef(false),
    finished = useRef(false);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const rows: Row[] = ["default", ...ACCOUNT_CLASSES.slice(0, advanced ? undefined : 3)];
  const dirty = !sameAccountPreferences(draft.preferences, saved);
  const entryFor = (row: Row) => (row === "default" ? draft.defaultAccount : draft.classes[row]);
  const report = (error: unknown) => {
    if (!alive.current || finished.current) return;
    const fields = fieldFailure(error)?.fields;
    setErrors(fields ?? {});
    setNotice(
      fields
        ? "Check the highlighted account settings. Your edits are kept."
        : `${error instanceof Error ? error.message : "Account settings failed"} Your edits are kept.`,
    );
    setView({ kind: "form" });
    const row = Object.keys(fields ?? {})[0];
    if (row) {
      const index = (["default", ...ACCOUNT_CLASSES] as string[]).indexOf(row);
      if (index > 3) setAdvanced(true);
      if (index >= 0) setSelected(index);
    }
  };
  const perform = (label: string, task: () => Promise<void>) => {
    if (pending.current || finished.current) return;
    pending.current = true;
    setBusy(label);
    setNotice("");
    void task()
      .catch(report)
      .finally(() => {
        pending.current = false;
        if (alive.current) setBusy(null);
      });
  };
  const resolve = async (next: AccountDraft) => {
    const resolved = await props.resolve(next);
    if (alive.current && !finished.current) {
      setDraft(resolved);
      setErrors({});
    }
    return resolved;
  };
  const leave = (quit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (quit) props.onQuit();
    else props.onBack();
  };
  const apply = (row: Row, path: string | null) => {
    try {
      const next = props.edit(draft, row, path);
      setDraft(next);
      setView({ kind: "form" });
      perform("Checking account paths and credentials…", async () => {
        await resolve(next);
      });
    } catch (error) {
      report(error);
    }
  };
  const openPath = (row: Row) => {
    const explicit =
      row === "default"
        ? draft.preferences.defaultCodexHome !== null
        : !!draft.preferences.classes[row];
    const text = explicit ? entryFor(row)!.codexHome : "";
    setView({ kind: "path", row, text, cursor: Array.from(text).length });
    setNotice("");
  };
  const openPicker = (row: Row) => {
    const explicit =
      row === "default"
        ? draft.preferences.defaultCodexHome !== null
        : !!draft.preferences.classes[row];
    const found = props.homes.indexOf(entryFor(row)?.codexHome ?? "");
    setView({
      kind: "picker",
      row,
      index: explicit ? (found >= 0 ? found + 1 : props.homes.length + 1) : 0,
    });
    setNotice("");
  };
  useInput((input, key) => {
    if ((key.ctrl && input === "c") || input.includes("\u0003")) {
      leave(true);
      return;
    }
    if (finished.current || pending.current) return;
    if (view.kind === "path") {
      if (key.escape) {
        openPicker(view.row);
        return;
      }
      if (key.return) {
        apply(view.row, view.text.length ? view.text : null);
        return;
      }
      if (key.tab) {
        openPicker(view.row);
        return;
      }
      const chars = Array.from(view.text);
      if (key.leftArrow) {
        setView({ ...view, cursor: Math.max(0, view.cursor - 1) });
        return;
      }
      if (key.rightArrow) {
        setView({ ...view, cursor: Math.min(chars.length, view.cursor + 1) });
        return;
      }
      if (key.home || (key.ctrl && input === "a")) {
        setView({ ...view, cursor: 0 });
        return;
      }
      if (key.end || (key.ctrl && input === "e")) {
        setView({ ...view, cursor: chars.length });
        return;
      }
      if (key.ctrl && input === "u") {
        setView({ ...view, text: "", cursor: 0 });
        return;
      }
      if (key.backspace) {
        if (view.cursor) chars.splice(view.cursor - 1, 1);
        setView({ ...view, text: chars.join(""), cursor: Math.max(0, view.cursor - 1) });
        return;
      }
      if (key.delete) {
        chars.splice(view.cursor, 1);
        setView({ ...view, text: chars.join("") });
        return;
      }
      if (!key.ctrl && !key.meta && input) {
        if (/[\u0000-\u001f\u007f-\u009f]/.test(input)) {
          setNotice("Paths cannot contain newlines or control characters.");
          return;
        }
        const inserted = Array.from(input);
        const next = [
          ...chars.slice(0, view.cursor),
          ...inserted,
          ...chars.slice(view.cursor),
        ].join("");
        if (next.length > 4096) {
          setNotice("Path is too long (maximum 4096 characters).");
          return;
        }
        setView({ ...view, text: next, cursor: view.cursor + inserted.length });
        setNotice("");
      }
      return;
    }
    if (input === "q") {
      leave(true);
      return;
    }
    if (view.kind === "picker") {
      const count = props.homes.length + 2;
      if (key.escape || input === "b") {
        setView({ kind: "form" });
        return;
      }
      if (input === "e") {
        openPath(view.row);
        return;
      }
      if (key.upArrow || input === "k" || (key.tab && key.shift))
        setView({ ...view, index: (view.index + count - 1) % count });
      else if (key.downArrow || input === "j" || key.tab)
        setView({ ...view, index: (view.index + 1) % count });
      else if (key.return) {
        if (view.index === count - 1) openPath(view.row);
        else apply(view.row, view.index === 0 ? null : props.homes[view.index - 1]!);
      }
      return;
    }
    if (view.kind === "summary") {
      if (key.escape || input === "b") {
        setView({ kind: "form" });
        return;
      }
      if (input === "a") {
        setView({ ...view, expanded: !view.expanded });
        return;
      }
      if (key.return)
        perform("Creating run…", async () => {
          await props.onStart(draft);
          if (alive.current) finished.current = true;
        });
      return;
    }
    if (key.escape || input === "b") {
      leave(false);
      return;
    }
    if (input === "s") {
      perform("Checking account paths and credentials…", async () => {
        await resolve(draft);
        if (alive.current && !finished.current) setView({ kind: "summary", expanded: false });
      });
      return;
    }
    if (input === "a") {
      setAdvanced(!advanced);
      setSelected(0);
      return;
    }
    if (key.upArrow || input === "k") {
      setSelected((selected + rows.length - 1) % rows.length);
      return;
    }
    if (key.downArrow || input === "j") {
      setSelected((selected + 1) % rows.length);
      return;
    }
    if (input === "d") {
      perform("Saving defaults…", async () => {
        await resolve(draft);
        if (!alive.current || finished.current) return;
        await props.saveDefaults(draft.preferences);
        if (alive.current && !finished.current) {
          setSaved(draft.preferences);
          setNotice("Defaults saved.");
        }
      });
      return;
    }
    if (key.return) openPicker(rows[selected]!);
  });
  const summary = view.kind === "summary";
  const inherited = ACCOUNT_CLASSES.slice(3).filter((key) => !draft.preferences.classes[key]);
  const shownRows: Row[] = summary
    ? ACCOUNT_CLASSES.filter(
        (key, index) => index < 3 || !!draft.preferences.classes[key] || view.expanded,
      )
    : rows;
  const accountRows = (list: Row[]) =>
    list.map((row) => {
      const entry = entryFor(row);
      return (
        <Box key={row} flexDirection="column">
          <Text {...(!summary && rows[selected] === row ? { color: "cyan" } : {})}>
            {!summary && rows[selected] === row ? "› " : "  "}
            {row}
            {entry?.inheritedFrom
              ? ` (inherits ${entry.inheritedFrom})`
              : row === "specialist" && !entry
                ? " (inherits assignment role)"
                : ""}
          </Text>
          <Text>
            {" "}
            {visible(
              entry?.codexHome ?? "implementation or review home, matching the specialist role",
            )}
          </Text>
          {!summary ? (
            <Text dimColor>
              {" "}
              {visible(sourceLabel(entry))}
              {entry?.label ? ` · ${visible(entry.label)}` : ""}
            </Text>
          ) : null}
          {errors[row] ? <Text color="red"> {visible(errors[row]!)}</Text> : null}
        </Box>
      );
    });
  const homeName = (path: string) => {
    {
      const configured = [draft.defaultAccount, ...Object.values(draft.classes)].find(
        (entry) => entry?.codexHome === path,
      );
      if (configured?.label) return configured.label;
    }
    return basename(path);
  };
  return (
    <Box flexDirection="column">
      <Text bold>
        {summary
          ? `START ${visible(props.epicId)} WITH THESE ACCOUNTS`
          : `Accounts — ${visible(props.epicId)}`}
      </Text>
      {props.epicTitle ? <Text>{visible(props.epicTitle)}</Text> : null}
      {props.repoPath ? <Text>Repository: {visible(props.repoPath)}</Text> : null}
      {props.runtime ? <Text>Runtime: {props.runtime}</Text> : null}
      {!summary ? (
        <Text dimColor>
          Choose accounts, then review and confirm Start. Agents use private homes.
        </Text>
      ) : null}
      <Text color={dirty ? "yellow" : "gray"}>
        {dirty
          ? "Unsaved changes · applies to this run; Save defaults to reuse"
          : "Matches saved defaults"}
      </Text>
      {notice ? <Text color="yellow">{visible(notice)}</Text> : null}
      {view.kind === "picker" ? (
        <>
          <Text bold>Choose home for {view.row}</Text>
          {Array.from({ length: props.homes.length + 2 }, (_, index) => index)
            .slice(Math.max(0, view.index - 3), Math.max(7, view.index + 4))
            .map((index) => (
              <Box key={index} flexDirection="column">
                <Text color={index === view.index ? "cyan" : "gray"}>
                  {index === view.index ? "› " : "  "}
                  {index === 0
                    ? "Inherit"
                    : index === props.homes.length + 1
                      ? "Enter another path…"
                      : visible(homeName(props.homes[index - 1]!))}
                </Text>
                {index > 0 && index <= props.homes.length ? (
                  <Text> {visible(props.homes[index - 1]!)}</Text>
                ) : null}
              </Box>
            ))}
          {!props.homes.length ? (
            <Text dimColor>No local homes found. Enter an existing Codex home path.</Text>
          ) : null}
          <Text>
            ↑/↓ or Tab choose · Enter apply · e Enter another path · Esc back · Ctrl+C quit
          </Text>
        </>
      ) : view.kind === "path" ? (
        <>
          <Text bold>
            Edit {view.row} source home: {Array.from(view.text).slice(0, view.cursor).join("")}▏
            {Array.from(view.text).slice(view.cursor).join("")}
          </Text>
          <Text dimColor>
            ←/→ cursor · Home/End · Backspace/Delete · Ctrl+U clear · empty inherits
          </Text>
          <Text>Enter apply · Tab homes · Esc back · Ctrl+C quit</Text>
        </>
      ) : (
        <>
          {accountRows(shownRows)}
          {summary && inherited.length && !view.expanded ? (
            <Text dimColor>
              Inherited roles:{" "}
              {inherited
                .map((key) => `${key} → ${draft.classes[key]?.inheritedFrom ?? "assignment role"}`)
                .join("; ")}
            </Text>
          ) : null}
        </>
      )}
      {busy ? (
        <Text>Ctrl+C quit</Text>
      ) : view.kind === "form" ? (
        <>
          <Text>
            ↑/↓ select · Enter choose home · a advanced · d Save defaults · s Review choices · Esc
            back · q/Ctrl+C quit
          </Text>
          <Text dimColor>Save defaults to: {visible(props.defaultsPath)}</Text>
        </>
      ) : summary ? (
        <Text>
          Enter Start run · a {view.expanded ? "hide" : "show"} inherited roles · Esc back ·
          q/Ctrl+C quit
        </Text>
      ) : null}
      {busy ? <Text>{busy}</Text> : null}
    </Box>
  );
}
