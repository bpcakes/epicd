import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { EpicBrowserItem } from "../epic-browser.js";
import type { RuntimeKind } from "../domain/types.js";
import { redactSensitiveText } from "../util/redact.js";

const withoutControls = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
const visible = (text: string) => withoutControls(redactSensitiveText(text, 4000));
const title = (item: EpicBrowserItem) =>
  item.epic.title ?? `Epic ${item.epic.id} (title unavailable)`;
export type EpicBrowserQuery = { page: number; search: string; showNested: boolean };
const label = (item: EpicBrowserItem) => {
  switch (item.action.kind) {
    case "start":
      return "new epic · configure accounts";
    case "resume":
      return `${item.action.status} · resume`;
    case "control":
      return `${item.action.status} · operator console`;
    case "unavailable":
      return "unavailable";
  }
};

export function EpicPicker({
  items,
  runtime,
  error,
  onSelect,
  onQuit,
  query,
  hasNextPage,
  onBrowse,
}: {
  items: EpicBrowserItem[];
  runtime: RuntimeKind;
  error?: string;
  onSelect: (item: EpicBrowserItem) => void;
  onQuit: () => void;
  query: EpicBrowserQuery;
  hasNextPage: boolean;
  onBrowse: (query: EpicBrowserQuery) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState(query.search);
  const [searching, setSearching] = useState(false);
  const [showNested, setShowNested] = useState(query.showNested);
  const [confirm, setConfirm] = useState<
    | (EpicBrowserItem & {
        action: Exclude<EpicBrowserItem["action"], { kind: "start" }>;
      })
    | null
  >(null);
  const submitted = useRef(false);
  // Always expose saved runs, even when their epic is nested under another open epic.
  const roots = items.filter(
    (item) =>
      item.action.kind === "resume" ||
      item.action.kind === "control" ||
      (item.action.kind === "unavailable" && item.action.runId !== null) ||
      item.parentIds === null ||
      item.parentIds.length === 0,
  );
  const filtered = showNested ? items : roots;
  const index = Math.min(selected, Math.max(0, filtered.length - 1));
  const browse = (next: EpicBrowserQuery) => {
    submitted.current = true;
    onBrowse(next);
  };
  useInput((input, key) => {
    if (submitted.current) return;
    if (key.ctrl && input === "c") {
      onQuit();
      return;
    }
    if (searching) {
      if (key.escape) {
        setFilter(query.search);
        setSearching(false);
      } else if (key.return) {
        setSearching(false);
        if (filter.trim() !== query.search)
          browse({ page: 1, search: filter.trim(), showNested: true });
      } else if (key.backspace || key.delete) setFilter((value) => value.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) {
        setFilter((value) => (value + withoutControls(input)).slice(0, 200));
        setSelected(0);
      }
      return;
    }
    if (input === "q") {
      onQuit();
      return;
    }
    if (confirm) {
      if (key.escape || input === "n" || input === "b") setConfirm(null);
      else if (confirm.action.kind !== "unavailable" && (key.return || input === "y")) {
        submitted.current = true;
        onSelect(confirm);
      }
      return;
    }
    if (key.upArrow || input === "k") setSelected(Math.max(0, index - 1));
    else if (key.downArrow || input === "j") setSelected(Math.min(filtered.length - 1, index + 1));
    else if (key.return && filtered[index]) {
      const item = filtered[index];
      if (item.action.kind === "start") {
        submitted.current = true;
        onSelect(item);
      } else setConfirm({ ...item, action: item.action });
    } else if (input === "r") browse({ ...query, showNested });
    else if (input === "/") setSearching(true);
    else if (input === "c") {
      setFilter("");
      setSelected(0);
      if (query.search) browse({ page: 1, search: "", showNested });
    } else if (input === "a") {
      setShowNested((value) => !value);
      setSelected(0);
    } else if (input === "]" && hasNextPage) browse({ ...query, page: query.page + 1, showNested });
    else if (input === "[" && query.page > 1)
      browse({ ...query, page: query.page - 1, showNested });
  });

  if (confirm) {
    const action = confirm.action;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold>
          {action.kind === "resume"
            ? "RESUME EPIC"
            : action.kind === "control"
              ? "OPEN OPERATOR CONSOLE"
              : "RUN UNAVAILABLE"}
        </Text>
        <Text>{visible(title(confirm))}</Text>
        <Text dimColor>{visible(confirm.epic.id)}</Text>
        <Text>Tracker status: {confirm.epic.status ?? "unknown"}</Text>
        {confirm.notice ? <Text color="yellow">{visible(confirm.notice)}</Text> : null}
        {action.kind === "unavailable" ? (
          <Text color="red">{visible(action.reason)}</Text>
        ) : (
          <>
            <Text>Runtime: {action.runtime}</Text>
            <Text>
              Run {action.runId} · {action.status}
            </Text>
            {action.accounts?.map((line, index) => (
              <Text key={index}>{visible(line)}</Text>
            ))}
            <Text>
              {action.kind === "control"
                ? "Open controls for the existing run."
                : "Continue the saved run with its recorded runtime and settings."}
            </Text>
          </>
        )}
        <Text dimColor>
          {action.kind === "unavailable"
            ? "esc/b back · q quit"
            : "enter/y confirm · esc/n back · q quit"}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          EPICD
        </Text>
        <Text> · choose an epic</Text>
      </Box>
      <Text dimColor>New runs: {runtime} · Select an epic to choose accounts.</Text>
      {error ? <Text color="red">{visible(error)}</Text> : null}
      <Text>
        Search: {visible(filter) || (searching ? "" : "/ to search all epics")}
        {searching ? "▏" : ""}
      </Text>
      {searching ? (
        <Text color="yellow">
          Search terms can be visible to other local processes. Avoid secrets.
        </Text>
      ) : null}
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        {filtered.length === 0 ? (
          <Text color="yellow">
            No matching open epics on this page.{" "}
            {items.length ? "Press a to show nested epics." : ""}
          </Text>
        ) : null}
        {filtered.slice(Math.max(0, index - 6), index + 7).map((item) => (
          <Text key={item.epic.id}>
            <Text color={item === filtered[index] ? "cyan" : "gray"}>
              {item === filtered[index] ? "❯ " : "  "}
            </Text>
            <Text
              bold={item === filtered[index]}
            >{`${item.epic.priority === null ? "Priority unknown" : `P${item.epic.priority}`} ${visible(title(item))}`}</Text>
            <Text
              dimColor
            >{` · ${visible(item.epic.id)} · tracker: ${item.epic.status ?? "unknown"} · ${label(item)}`}</Text>
            {item.parentIds === null ? <Text dimColor> · hierarchy unknown</Text> : null}
          </Text>
        ))}
      </Box>
      <Text dimColor>
        ↑↓/jk navigate · / search · c clear · r reload · enter{" "}
        {filtered[index]?.action.kind === "start" ? "configure" : "select"} · a{" "}
        {showNested ? "roots" : "all"} · q quit
      </Text>
      <Text dimColor>
        Page {query.page} · {filtered.length} epics · {query.page > 1 ? "[ previous · " : ""}
        {hasNextPage ? "] next" : "last page"}
      </Text>
    </Box>
  );
}
