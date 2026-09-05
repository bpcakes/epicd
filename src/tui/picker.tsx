import { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { runNeedsResume, runRecoveryKind, type Issue, type RunState } from "../domain/types.js";

export type PickerItem = {
  epic: Issue;
  run: RunState | null;
  unavailableReason: string | null;
};

export function canSelectPickerItem(item: Pick<PickerItem, "unavailableReason">): boolean {
  return item.unavailableReason === null;
}

export function EpicPicker({
  items,
  onSelect,
}: {
  items: PickerItem[];
  onSelect: (item: PickerItem) => void;
}) {
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState("");
  const [searching, setSearching] = useState(false);
  const [confirm, setConfirm] = useState<PickerItem | null>(null);
  const [showNested, setShowNested] = useState(false);
  const roots = items.filter(
    (item) =>
      !items.some(
        (possibleParent) =>
          possibleParent.epic.id !== item.epic.id &&
          item.epic.id.startsWith(`${possibleParent.epic.id}.`),
      ),
  );
  const visibleItems = showNested ? items : roots;
  const filtered = visibleItems.filter((item) =>
    `${item.epic.id} ${item.epic.title}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const safeSelected = Math.min(selected, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (confirm) {
      if (canSelectPickerItem(confirm) && (key.return || input === "y")) onSelect(confirm);
      else if (key.escape || input === "n" || input === "b") setConfirm(null);
      else if (input === "q") exit();
    } else if (searching) {
      if (key.escape || key.return) setSearching(false);
      else if (key.backspace || key.delete) setFilter((value) => value.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) {
        setFilter((value) => `${value}${input}`);
        setSelected(0);
      }
    } else if (key.upArrow || input === "k") setSelected((value) => Math.max(0, value - 1));
    else if (key.downArrow || input === "j")
      setSelected((value) => Math.min(filtered.length - 1, value + 1));
    else if (key.return && filtered[safeSelected]) setConfirm(filtered[safeSelected]);
    else if (input === "a") {
      setShowNested((value) => !value);
      setSelected(0);
    } else if (input === "/") setSearching(true);
    else if (input === "c") setFilter("");
    else if (input === "q") exit();
  });

  if (confirm) {
    if (confirm.unavailableReason) {
      return (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
            <Text bold color="red">
              RUN UNAVAILABLE
            </Text>
            <Box marginTop={1} flexDirection="column">
              <Text bold>{confirm.epic.title}</Text>
              <Text dimColor>{confirm.epic.id}</Text>
              <Text>{confirm.unavailableReason}</Text>
            </Box>
          </Box>
          <Box marginTop={1}>
            <Text dimColor> esc/n/b back · q quit </Text>
          </Box>
        </Box>
      );
    }
    const resuming = Boolean(confirm.run && runNeedsResume(confirm.run));
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
          <Text bold color="cyan">
            {resuming ? "RESUME EPIC" : "START EPIC"}
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold>{confirm.epic.title}</Text>
            <Text dimColor>{confirm.epic.id}</Text>
          </Box>
          {resuming ? (
            <Box marginTop={1}>
              {confirm.run?.phase === "complete" ? (
                <Text>
                  {runRecoveryKind(confirm.run) === "diagnostic"
                    ? "Clear the existing run's saved diagnostic; no agent cleanup remains."
                    : "Finish the existing run's pending agent cleanup."}
                </Text>
              ) : (
                <Text>
                  Continue the existing <Text color="yellow">{confirm.run?.phase}</Text> run from
                  its persisted phase.
                </Text>
              )}
            </Box>
          ) : (
            <Box marginTop={1} flexDirection="column">
              <Text>epicd will claim concrete ready tasks and create local commits.</Text>
              <Text>A clean working tree is required. Nothing will be pushed.</Text>
            </Box>
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor> enter/y confirm · esc/n back · q quit </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          EPICD
        </Text>
        <Text dimColor> choose an epic to deliver</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Filter: </Text>
        <Text>{filter || (searching ? "" : "/ to search")}</Text>
        {searching ? <Text color="cyan">▌</Text> : null}
      </Box>
      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        {filtered.length === 0 ? <Text color="yellow">No matching open epics.</Text> : null}
        {filtered.slice(Math.max(0, safeSelected - 6), safeSelected + 7).map((item) => {
          const index = filtered.indexOf(item);
          const active = index === safeSelected;
          const runLabel = item.unavailableReason
            ? " · invalid saved run"
            : item.run && runNeedsResume(item.run)
              ? item.run.phase === "complete"
                ? runRecoveryKind(item.run) === "diagnostic"
                  ? " · needs attention"
                  : " · cleanup pending"
                : ` · ${item.run.phase.replaceAll("_", " ")}`
              : "";
          return (
            <Box key={item.epic.id}>
              {active ? <Text color="cyan">❯ </Text> : <Text> </Text>}
              <Text
                bold={active}
                inverse={active}
              >{` P${item.epic.priority} ${item.epic.title} `}</Text>
              <Text
                color={item.unavailableReason || item.run?.phase === "blocked" ? "red" : "gray"}
              >
                {runLabel}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} justifyContent="space-between">
        <Text dimColor>
          {" "}
          ↑↓/jk navigate · / search · enter start/resume · a {showNested ? "roots" : "all"} · q
          quit{" "}
        </Text>
        <Text dimColor>
          {filtered.length} epic{filtered.length === 1 ? "" : "s"}
        </Text>
      </Box>
    </Box>
  );
}
